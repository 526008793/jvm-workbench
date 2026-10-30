import { randomUUID } from 'node:crypto';
import { LogAssembler, type LogMessage } from './log-assembler';
import type { Project, ServiceInstance } from '../../shared/models';
import type {
  DockerContainer,
  LogRequest,
  LogRow,
  LogTask,
  RemoteEvent,
} from '../../shared/remote';
import { buildLogCommand, shellQuote } from '../../shared/commands';
import {
  SessionManager,
  RemoteCommandUncertainError,
  type Session,
  type StreamJob,
} from '../connections/session-manager';

interface RunningLog {
  owner: number;
  task: LogTask;
  job?: StreamJob;
  stopPromise?: Promise<void>;
  cancelled: boolean;
  ended: boolean;
  assembler: LogAssembler;
}
export class DockerService {
  private readonly running = new Map<string, RunningLog>();
  private batches = new Map<number, Map<string, LogRow>>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  constructor(
    private readonly sessions: SessionManager,
    private readonly emit: (owner: number, event: RemoteEvent) => void,
  ) {}
  list(owner: number): LogTask[] {
    return [...this.running.values()].filter((r) => r.owner === owner).map((r) => ({ ...r.task }));
  }
  async discover(session: Session): Promise<DockerContainer[]> {
    const output = await this.sessions.execute(
      session,
      "docker ps --no-trunc --format '{{json .}}'",
    );
    return output
      .split(/\r?\n/)
      .filter((s) => s.trim())
      .map((line) => {
        const row = JSON.parse(line);
        if (typeof row.ID !== 'string' || typeof row.Names !== 'string')
          throw new Error('Docker返回了无法识别的容器记录');
        return {
          id: row.ID,
          name: row.Names,
          image: String(row.Image ?? ''),
          status: String(row.Status ?? ''),
        };
      });
  }
  private state(record: RunningLog, status: LogTask['status'], error?: string): void {
    record.task.status = status;
    record.task.error = error;
    this.emit(record.owner, { type: 'log-state', task: { ...record.task } });
  }
  private row(record: RunningLog, message: LogMessage): void {
    if (!this.running.has(record.task.id)) return;
    let rows = this.batches.get(record.owner) ?? new Map<string, LogRow>();
    rows.set(message.id, {
      ...message,
      taskId: record.task.id,
      serviceId: record.task.serviceId,
      instanceId: record.task.instanceId,
      serverId: record.task.serverId,
      containerName: record.task.containerName,
    });
    if (rows.size > 4000) {
      rows = new Map([...rows].slice(-2000));
      const id = randomUUID();
      rows.set(id, {
        id,
        taskId: record.task.id,
        serviceId: record.task.serviceId,
        instanceId: record.task.instanceId,
        serverId: record.task.serverId,
        containerName: record.task.containerName,
        stream: message.stream,
        text: '[日志输出过快，部分显示缓存已释放；可通过Docker或SLS查询原始记录]',
        receivedAt: Date.now(),
      });
    }
    this.batches.set(record.owner, rows);
    if (!this.timers.has(record.owner))
      this.timers.set(
        record.owner,
        setTimeout(() => this.flush(record.owner), 40),
      );
  }
  private flush(owner: number): void {
    const rows = [...(this.batches.get(owner)?.values() ?? [])];
    this.batches.delete(owner);
    this.timers.delete(owner);
    if (rows.length) this.emit(owner, { type: 'logs', rows });
  }
  private data(record: RunningLog, text: string, source: LogRow['stream']): void {
    if (!record.ended) record.assembler.write(text, source);
  }
  private finish(record: RunningLog, code: number | null, error?: string): void {
    if (record.ended) return;
    record.ended = true;
    record.assembler.finish();
    if (code === null) this.state(record, 'unknown', error || '无法确认远端日志命令状态');
    else if (record.cancelled) this.state(record, 'stopped');
    else if (code === 0) this.state(record, 'ended');
    else this.state(record, 'error', error || `Docker日志退出：${code}`);
  }

  async start(owner: number, project: Project, request: LogRequest): Promise<LogTask[]> {
    const environment = project.environments.find((e) => e.id === request.environmentId);
    const service = environment?.services.find((s) => s.id === request.serviceId);
    if (!environment || !service) throw new Error('环境或服务不存在');
    const ids = [...new Set(request.instanceIds)];
    const instances = ids.map((id) => {
      const instance = service.instances.find((i) => i.id === id);
      if (!instance) throw new Error('实例不属于当前服务');
      return instance;
    });
    return Promise.all(
      instances.map(async (instance) => {
        const existing = [...this.running.values()].find(
          (r) =>
            r.owner === owner &&
            r.task.projectId === project.id &&
            r.task.instanceId === instance.id &&
            r.task.environmentId === environment.id &&
            ['starting', 'running', 'stopping'].includes(r.task.status),
        );
        if (existing) return { ...existing.task };
        for (const [id, old] of this.running)
          if (
            old.owner === owner &&
            old.task.environmentId === environment.id &&
            old.task.instanceId === instance.id &&
            old.ended
          )
            this.running.delete(id);
        const record: RunningLog = {
          owner,
          cancelled: false,
          ended: false,
          assembler: new LogAssembler((message) => this.row(record, message)),
          task: {
            id: randomUUID(),
            projectId: project.id,
            environmentId: environment.id,
            serviceId: service.id,
            instanceId: instance.id,
            serverId: instance.serverId,
            containerName: instance.containerName,
            status: 'starting',
          },
        };
        this.running.set(record.task.id, record);
        this.state(record, 'starting');
        try {
          const session = this.sessions.findReady(owner, {
            projectId: project.id,
            environmentId: environment.id,
            serverId: instance.serverId,
          });
          const format =
            '{"id":{{json .Id}},"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}}}';
          const metadata = JSON.parse(
            await this.sessions.execute(
              session,
              `docker inspect --type container --format ${shellQuote(format)} -- ${shellQuote(instance.containerName)}`,
            ),
          );
          if (
            metadata.running !== true ||
            typeof metadata.id !== 'string' ||
            !/^[a-f\d]{12,64}$/.test(metadata.id) ||
            typeof metadata.startedAt !== 'string'
          )
            throw new Error('目标容器未运行或返回的身份信息无效');
          record.task.containerId = metadata.id;
          record.task.startedAt = metadata.startedAt;
          if (record.cancelled) {
            this.finish(record, 0);
            return { ...record.task };
          }
          record.job = await this.sessions.stream(
            session,
            buildLogCommand(metadata.id, request.mode, request.lines, request.since, request.until),
            (text, source) => this.data(record, text, source),
            (code, error) => this.finish(record, code, error),
          );
          if (record.cancelled) {
            const confirmed = await record.job.stop();
            if (!record.ended)
              this.state(
                record,
                confirmed ? 'stopped' : 'unknown',
                confirmed ? undefined : '未确认日志命令已结束',
              );
          } else if (!record.ended) this.state(record, 'running');
          console.info('[docker] log task opened', {
            taskId: record.task.id,
            serviceId: record.task.serviceId,
            serverId: instance.serverId,
          });
        } catch (error) {
          if (!record.ended) {
            record.ended = true;
            record.assembler.finish();
            this.state(
              record,
              error instanceof RemoteCommandUncertainError
                ? 'unknown'
                : record.cancelled
                  ? 'stopped'
                  : 'error',
              (error as Error).message,
            );
          }
        }
        return { ...record.task };
      }),
    );
  }
  async stop(owner: number, ids: string[]): Promise<void> {
    const records = ids.map((id) => {
      const record = this.running.get(id);
      if (!record || record.owner !== owner) throw new Error('日志任务不属于当前工作区');
      return record;
    });
    await Promise.all(
      records.map((record) => {
        // Repeated clicks share the same stop request; a second Ctrl+C could hit the parent target shell.
        if (record.stopPromise) return record.stopPromise;
        record.stopPromise = (async () => {
          if (record.ended || ['stopped', 'ended', 'error'].includes(record.task.status)) return;
          record.cancelled = true;
          this.state(record, 'stopping');
          if (!record.job) return;
          const confirmed = await record.job.stop();
          if (!record.ended) {
            record.ended = true;
            record.assembler.finish();
            this.state(
              record,
              confirmed ? 'stopped' : 'unknown',
              confirmed ? undefined : '无法确认远端任务结束，请到终端核对',
            );
          }
        })();
        return record.stopPromise;
      }),
    );
  }
  reconcile(project: Project): void {
    for (const record of this.running.values()) {
      if (record.task.projectId !== project.id || record.ended) continue;
      const env = project.environments.find((e) => e.id === record.task.environmentId);
      const instance = env?.services
        .find((s) => s.id === record.task.serviceId)
        ?.instances.find((i) => i.id === record.task.instanceId);
      if (
        !instance ||
        instance.containerName !== record.task.containerName ||
        instance.serverId !== record.task.serverId
      )
        void this.stop(record.owner, [record.task.id]);
    }
  }
  disposeOwner(owner: number): void {
    for (const [id, record] of this.running)
      if (record.owner === owner) {
        record.cancelled = true;
        record.ended = true;
        void (record.stopPromise ?? record.job?.stop())?.catch(() => undefined);
        this.running.delete(id);
      }
    clearTimeout(this.timers.get(owner));
    this.timers.delete(owner);
    this.batches.delete(owner);
  }
}
