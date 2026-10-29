import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { Project } from '../../shared/models';
import {
  connectSchema,
  logRequestSchema,
  targetSchema,
  type RemoteEvent,
  type RemoteTarget,
} from '../../shared/remote';
import { connectionBinding } from '../../shared/commands';
import { remoteChannels } from '../../shared/channels';
import { ProjectStore } from '../storage/project-store';
import { KnownHosts } from '../storage/known-hosts';
import { ContextRegistry } from '../workspaces/context-registry';
import { SessionManager } from './session-manager';
import { DockerService } from '../docker/docker-service';

type Register = (
  name: string,
  action: (owner: number, input: unknown) => unknown | Promise<unknown>,
) => void;
export class RemoteController {
  readonly sessions: SessionManager;
  readonly docker: DockerService;
  private readonly keys = new Map<string, { owner: number; path: string }>();
  constructor(
    private readonly store: ProjectStore,
    private readonly registry: ContextRegistry,
    trustPath: string,
    emit: (owner: number, event: RemoteEvent) => void,
    private readonly chooseKey: (owner: number) => Promise<string | undefined>,
  ) {
    this.sessions = new SessionManager(new KnownHosts(trustPath), emit);
    this.docker = new DockerService(this.sessions, emit);
  }
  private workspace(owner: number, projectId?: string): string {
    const context = this.registry.get(owner);
    if (context.kind !== 'workspace' || (projectId && context.projectId !== projectId))
      throw new Error('远程操作不属于当前项目工作区');
    return context.projectId;
  }
  private async project(owner: number, projectId: string): Promise<Project> {
    this.workspace(owner, projectId);
    const project = (await this.store.list()).find((p) => p.id === projectId);
    this.workspace(owner, projectId);
    if (!project) throw new Error('项目不存在');
    return project;
  }
  private async target(owner: number, target: RemoteTarget) {
    const project = await this.project(owner, target.projectId);
    const server = project.environments
      .find((e) => e.id === target.environmentId)
      ?.servers.find((s) => s.id === target.serverId);
    if (!server) throw new Error('服务器不属于当前项目环境');
    return server;
  }
  register(handle: Register): void {
    handle(remoteChannels.list, (owner) => {
      this.workspace(owner);
      return this.sessions.list(owner);
    });
    handle(remoteChannels.connect, async (owner, input) => {
      const value = connectSchema.parse(input);
      const server = await this.target(owner, value);
      if (connectionBinding(server) !== value.binding)
        throw new Error('连接配置已变化，请重新打开连接窗口');
      const auth = value.authentication;
      let material: { password?: string; privateKey?: Buffer; passphrase?: string } = {};
      if (auth.kind === 'password') material = { password: auth.password };
      if (auth.kind === 'privateKey') {
        const key = this.keys.get(auth.keyId);
        if (!key || key.owner !== owner) throw new Error('请在当前窗口重新选择私钥文件');
        material = {
          privateKey: await readFile(key.path),
          passphrase: auth.passphrase || undefined,
        };
      }
      this.workspace(owner, value.projectId);
      const latest = await this.target(owner, value);
      if (connectionBinding(latest) !== value.binding)
        throw new Error('连接配置已变化，请重新连接');
      return this.sessions.connect(
        owner,
        {
          projectId: value.projectId,
          environmentId: value.environmentId,
          serverId: value.serverId,
        },
        latest,
        material,
      );
    });
    handle(remoteChannels.key, async (owner) => {
      this.workspace(owner);
      const path = await this.chooseKey(owner);
      if (!path) return null;
      this.workspace(owner);
      const id = randomUUID();
      this.keys.set(id, { owner, path });
      return { id, name: basename(path) };
    });
    handle(remoteChannels.disconnect, (owner, input) =>
      this.sessions.disconnect(owner, z.string().parse(input)),
    );
    handle(remoteChannels.answer, (owner, input) =>
      this.sessions.answer(
        owner,
        z
          .object({
            connectionId: z.string(),
            challengeId: z.string(),
            answers: z.array(z.string()),
            acceptHost: z.boolean().optional(),
          })
          .parse(input),
      ),
    );
    handle(remoteChannels.terminal, (owner, input) =>
      this.sessions.snapshot(owner, z.string().parse(input)),
    );
    handle(remoteChannels.input, (owner, input) => {
      const value = z.object({ id: z.string(), data: z.string() }).parse(input);
      this.sessions.input(owner, value.id, value.data);
    });
    handle(remoteChannels.resize, (owner, input) => {
      const value = z
        .object({
          id: z.string(),
          cols: z.number().int().positive(),
          rows: z.number().int().positive(),
        })
        .parse(input);
      this.sessions.resize(owner, value.id, value.cols, value.rows);
    });
    handle(remoteChannels.confirm, (owner, input) =>
      this.sessions.confirmTarget(owner, z.string().parse(input)),
    );
    handle(remoteChannels.discover, async (owner, input) => {
      const value = targetSchema.parse(input);
      await this.target(owner, value);
      return this.docker.discover(this.sessions.findReady(owner, value));
    });
    handle(remoteChannels.tasks, (owner) => {
      this.workspace(owner);
      return this.docker.list(owner);
    });
    handle(remoteChannels.logs, async (owner, input) => {
      const value = logRequestSchema.parse(input);
      return this.docker.start(owner, await this.project(owner, value.projectId), value);
    });
    handle(remoteChannels.stop, (owner, input) =>
      this.docker.stop(owner, z.array(z.string()).parse(input)),
    );
  }
  reconcile(project: Project): void {
    this.docker.reconcile(project);
    this.sessions.reconcile(
      project.id,
      project.environments.flatMap((e) =>
        e.servers.map((server) => ({ environmentId: e.id, server })),
      ),
    );
  }
  disposeOwner(owner: number): void {
    this.docker.disposeOwner(owner);
    this.sessions.disposeOwner(owner);
    for (const [id, key] of this.keys) if (key.owner === owner) this.keys.delete(id);
  }
}
