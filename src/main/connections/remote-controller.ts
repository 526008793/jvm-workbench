import { PasswordStore, type PasswordScope } from '../storage/password-store';
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
import { connectionBinding, gatewayBinding } from '../../shared/commands';
import { remoteChannels } from '../../shared/channels';
import { ProjectStore } from '../storage/project-store';
import { KnownHosts } from '../storage/known-hosts';
import { ContextRegistry } from '../workspaces/context-registry';
import { SessionManager } from './session-manager';
import { DockerService } from '../docker/docker-service';

import { arthasChannels } from '../../shared/channels';
import { ArthasService } from '../arthas/arthas-service';
import {
  attachSchema,
  diagnosticSchema,
  traceScopeSchema,
  jvmTargetSchema,
  type Jvm,
} from '../../shared/arthas';

type Register = (
  name: string,
  action: (owner: number, input: unknown) => unknown | Promise<unknown>,
) => void;
export class RemoteController {
  readonly sessions: SessionManager;
  readonly docker: DockerService;
  readonly arthas: ArthasService;
  private readonly keys = new Map<string, { owner: number; path: string }>();
  private readonly pendingPasswords = new Map<
    string,
    { owner: number; scope: PasswordScope; target: RemoteTarget; encrypted: Buffer }
  >();
  constructor(
    private readonly store: ProjectStore,
    private readonly registry: ContextRegistry,
    trustPath: string,
    private readonly emit: (owner: number, event: RemoteEvent) => void,
    private readonly chooseKey: (owner: number) => Promise<string | undefined>,
    private readonly passwords?: PasswordStore,
  ) {
    this.sessions = new SessionManager(new KnownHosts(trustPath), (owner, event) =>
      this.sessionEvent(owner, event),
    );
    this.docker = new DockerService(this.sessions, emit);
    this.arthas = new ArthasService(this.sessions, emit);
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
    handle(remoteChannels.passwordStatus, async (owner, input) => {
      const value = targetSchema.extend({ binding: z.string() }).parse(input);
      const server = await this.target(owner, value);
      if (connectionBinding(server) !== value.binding)
        throw new Error('连接配置已变化，请重新打开连接窗口');
      return (
        this.passwords?.status({ ...value, server }) ?? { available: false, remembered: false }
      );
    });
    handle(remoteChannels.forgetPassword, async (owner, input) => {
      const value = targetSchema.extend({ binding: z.string() }).parse(input);
      const server = await this.target(owner, value);
      if (connectionBinding(server) !== value.binding)
        throw new Error('连接配置已变化，请重新打开连接窗口');
      await this.forgetRememberedPassword(owner, { ...value, server });
    });
    handle(arthasChannels.discover, async (owner, input) => {
      const value = jvmTargetSchema.parse(input);
      return this.arthas.discover(owner, await this.project(owner, value.projectId), value);
    });
    handle(arthasChannels.attach, async (owner, input) => {
      const value = attachSchema.parse(input);
      await this.assertJvm(owner, value.jvm);
      return this.arthas.attach(owner, value);
    });
    handle(arthasChannels.agents, (owner) => {
      this.workspace(owner);
      return this.arthas.listAgents(owner);
    });
    handle(arthasChannels.search, async (owner, input) => {
      const value = z
        .object({ agentId: z.string().min(1), query: z.string(), packageName: z.string() })
        .parse(input);
      await this.assertJvm(owner, this.arthas.getAgent(owner, value.agentId).jvm);
      return this.arthas.search(owner, value.agentId, value.query, value.packageName);
    });
    handle(arthasChannels.scope, async (owner, input) => {
      const value = traceScopeSchema.parse(input);
      await this.assertJvm(owner, this.arthas.getAgent(owner, value.agentId).jvm);
      return this.arthas.resolveTraceScope(owner, value);
    });
    handle(arthasChannels.start, async (owner, input) => {
      const value = diagnosticSchema.parse(input);
      await this.assertJvm(owner, this.arthas.getAgent(owner, value.agentId).jvm);
      return this.arthas.start(owner, value);
    });
    handle(arthasChannels.stop, (owner, input) => {
      this.workspace(owner);
      return this.arthas.stop(owner, z.string().min(1).parse(input));
    });
    handle(arthasChannels.tasks, (owner) => {
      this.workspace(owner);
      return this.arthas.listTasks(owner);
    });
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
      if (auth.kind === 'savedPassword') {
        if (!this.passwords) throw new Error('密码存储不可用，请重新输入');
        material = { password: await this.passwords.get({ ...value, server }) };
      }
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
      const target: RemoteTarget = {
        projectId: value.projectId,
        environmentId: value.environmentId,
        serverId: value.serverId,
      };
      const scope = { ...target, server: latest };
      let encrypted: Buffer | undefined;
      if (auth.kind === 'password' && value.rememberPassword) {
        if (!this.passwords) throw new Error('密码存储不可用，请取消记住密码');
        encrypted = this.passwords.prepare(auth.password);
      }
      if (
        (auth.kind === 'password' || auth.kind === 'savedPassword') &&
        value.rememberPassword === false
      )
        await this.forgetRememberedPassword(owner, scope);
      // Reading/deleting a stored credential is asynchronous. Recheck the endpoint before sending authentication material.
      const finalServer = await this.target(owner, value);
      if (connectionBinding(finalServer) !== value.binding)
        throw new Error('连接配置已变化，请重新连接');
      const connection = this.sessions.connect(
        owner,
        target,
        finalServer,
        material,
        auth.kind === 'reuse' ? auth.connectionId : undefined,
      );
      if (encrypted && !['closed', 'error'].includes(connection.status))
        this.pendingPasswords.set(connection.id, { owner, scope, target, encrypted });
      return connection;
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
    void this.passwords
      ?.reconcile(project)
      .catch(() =>
        console.warn('[passwords] configuration cleanup failed', { projectId: project.id }),
      );
    this.docker.reconcile(project);
    this.arthas.reconcile(project);
    this.sessions.reconcile(
      project.id,
      project.environments.flatMap((e) =>
        e.servers.map((server) => ({ environmentId: e.id, server })),
      ),
    );
  }
  disposeOwner(owner: number): void {
    for (const [id, pending] of this.pendingPasswords)
      if (pending.owner === owner) this.pendingPasswords.delete(id);
    this.arthas.disposeOwner(owner);
    this.docker.disposeOwner(owner);
    this.sessions.disposeOwner(owner);
    for (const [id, key] of this.keys) if (key.owner === owner) this.keys.delete(id);
  }
  private async assertJvm(owner: number, jvm: Jvm): Promise<void> {
    const project = await this.project(owner, jvm.projectId);
    const instance = project.environments
      .find((e) => e.id === jvm.environmentId)
      ?.services.find((s) => s.id === jvm.serviceId)
      ?.instances.find((i) => i.id === jvm.instanceId);
    if (
      !instance ||
      instance.serverId !== jvm.serverId ||
      instance.containerName !== jvm.containerName
    )
      throw new Error('实例配置已变化，请重新发现JVM');
    await this.target(owner, jvm);
  }
  async removeProjectPasswords(projectId: string): Promise<void> {
    for (const [id, pending] of this.pendingPasswords)
      if (pending.scope.projectId === projectId) this.pendingPasswords.delete(id);
    await this.passwords?.removeProject(projectId);
  }
  private async forgetRememberedPassword(owner: number, scope: PasswordScope): Promise<void> {
    // Cancel in-flight authentication saves before deleting, so a later ready event cannot restore a forgotten password.
    for (const [id, pending] of this.pendingPasswords) {
      if (
        pending.owner === owner &&
        pending.scope.projectId === scope.projectId &&
        pending.scope.environmentId === scope.environmentId &&
        gatewayBinding(pending.scope.server) === gatewayBinding(scope.server)
      )
        this.pendingPasswords.delete(id);
    }
    await this.passwords?.forget(scope);
  }
  private sessionEvent(owner: number, event: RemoteEvent): void {
    if (event.type === 'connection') {
      const pending = this.pendingPasswords.get(event.connection.id);
      if (
        pending &&
        ['ready', 'awaiting-target', 'closed', 'error'].includes(event.connection.status)
      ) {
        this.pendingPasswords.delete(event.connection.id);
        if (['ready', 'awaiting-target'].includes(event.connection.status)) {
          // Commit only after SSH has accepted authentication, including any required MFA.
          void this.passwords!.remember(pending.scope, pending.encrypted)
            .then(() => {
              this.emit(owner, {
                type: 'password-state',
                target: pending.target,
                remembered: true,
              });
            })
            .catch(() => {
              console.warn('[passwords] encrypted save failed', {
                projectId: pending.scope.projectId,
                serverId: pending.target.serverId,
              });
              this.emit(owner, {
                type: 'password-state',
                target: pending.target,
                remembered: false,
                error: '连接成功，但密码未能安全保存，请重试记住密码',
              });
            });
        }
      }
    }
    this.emit(owner, event);
  }
}
