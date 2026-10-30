import { randomUUID } from 'node:crypto';
import { packageInstall, packageProbe } from './package';
import type { Project } from '../../shared/models';
import type { RemoteEvent } from '../../shared/remote';
import {
  ARTHAS_VERSION,
  diagnosticCommand,
  methodSchema,
  multiTracePatterns,
  sameJvm,
  traceScopeSchema,
  type TraceScopeInput,
  type ArthasAgent,
  type ArthasAttachProgress,
  type AttachInput,
  type DiagnosticInput,
  type DiagnosticTask,
  type Jvm,
  type JvmTarget,
  type MethodCandidate,
} from '../../shared/arthas';
import { shellQuote } from '../../shared/commands';
import { DeepCapture } from '../../shared/deep';
import { SessionManager, type Session } from '../connections/session-manager';

interface ApiResponse {
  state: string;
  message?: string;
  sessionId?: string;
  consumerId?: string;
  body?: { jobId?: number; jobStatus?: string; results?: Record<string, unknown>[] };
}
interface TaskRecord {
  owner: number;
  agent: ArthasAgent;
  task: DiagnosticTask;
  cancelled: boolean;
  disposed: boolean;
  sessionId?: string;
  consumerId?: string;
  jobId?: number;
  run?: Promise<void>;
}

// Commands run inside the selected container: a host SSH tunnel cannot reach its loopback by assumption.
export class ArthasService {
  private readonly agents = new Map<string, { owner: number; agent: ArthasAgent }>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly epochs = new Map<number, number>();
  private readonly revisions = new Map<string, number>();
  constructor(
    private readonly sessions: SessionManager,
    private readonly emit: (owner: number, event: RemoteEvent) => void,
  ) {}

  listAgents(owner: number): ArthasAgent[] {
    return structuredClone(
      [...this.agents.values()].filter((a) => a.owner === owner).map((a) => a.agent),
    );
  }
  listTasks(owner: number): DiagnosticTask[] {
    return structuredClone(
      [...this.tasks.values()].filter((t) => t.owner === owner).map((t) => t.task),
    );
  }
  private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.queues.set(id, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }
  private session(owner: number, jvm: Jvm): Session {
    const session = this.sessions.findReady(owner, jvm);
    if (session.view.id !== jvm.connectionId) throw new Error('连接已变化，请重新发现JVM');
    return session;
  }
  private async inspect(session: Session, container: string) {
    const format =
      '{"id":{{json .Id}},"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}}}';
    const value = JSON.parse(
      await this.sessions.execute(
        session,
        `docker inspect --type container --format ${shellQuote(format)} -- ${shellQuote(container)}`,
      ),
    );
    if (
      value.running !== true ||
      !/^[a-f\d]{12,64}$/.test(value.id) ||
      typeof value.startedAt !== 'string'
    )
      throw new Error('目标容器未运行或身份信息无效');
    return value as { id: string; startedAt: string };
  }
  private exec(jvm: Jvm, command: string): string {
    return `docker exec --user ${shellQuote(jvm.uid)} ${shellQuote(jvm.containerId)} sh -c ${shellQuote(command)}`;
  }
  private async verify(owner: number, jvm: Jvm): Promise<Session> {
    const session = this.session(owner, jvm);
    const metadata = await this.inspect(session, jvm.containerName);
    if (metadata.id !== jvm.containerId || metadata.startedAt !== jvm.startedAt)
      throw new Error('容器已重建或重启，请重新发现JVM');
    const probe = `test "$(readlink /proc/${jvm.pid}/exe)" = ${shellQuote(jvm.java)} && test "$(awk '{sub(/^.*[)] /, ""); print $20}' /proc/${jvm.pid}/stat)" = ${shellQuote(jvm.startTicks)} && test "$(awk '/^Uid:/{print $2}' /proc/${jvm.pid}/status)" = ${shellQuote(jvm.uid)}`;
    await this.sessions.execute(session, this.exec(jvm, probe));
    this.session(owner, jvm);
    return session;
  }
  async discover(owner: number, project: Project, target: JvmTarget): Promise<Jvm[]> {
    const environment = project.environments.find((e) => e.id === target.environmentId);
    const instance = environment?.services
      .find((s) => s.id === target.serviceId)
      ?.instances.find((i) => i.id === target.instanceId);
    if (!instance) throw new Error('实例不属于当前项目服务');
    const session = this.sessions.findReady(owner, { ...target, serverId: instance.serverId });
    return this.serial(session.view.id, async () => {
      const identity = await this.inspect(session, instance.containerName);
      // Never expose process command lines: application arguments can contain passwords or tokens.
      const script = `for p in /proc/[0-9]*; do j=$(readlink "$p/exe") || continue; case "$j" in */java) printf '%s\\t%s\\t%s\\t%s\\n' "${'$'}{p##*/}" "$(awk '/^Uid:/{print $2}' "$p/status")" "$(awk '{sub(/^.*[)] /, ""); print $20}' "$p/stat")" "$j";; esac; done`;
      const output = await this.sessions.execute(
        session,
        `docker exec ${shellQuote(identity.id)} sh -c ${shellQuote(script)}`,
      );
      this.sessions.findReady(owner, session.view);
      const jvms = output
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [pid, uid, startTicks, java] = line.split('\t');
          if (
            !/^\d+$/.test(pid) ||
            !/^\d+$/.test(uid) ||
            !/^\d+$/.test(startTicks) ||
            !java?.startsWith('/')
          )
            throw new Error('无法解析JVM进程信息');
          return {
            ...target,
            serverId: instance.serverId,
            connectionId: session.view.id,
            containerName: instance.containerName,
            containerId: identity.id,
            startedAt: identity.startedAt,
            pid: Number(pid),
            uid,
            startTicks,
            java,
          };
        });
      // Retire old attachments after rediscovery, including a restart that keeps the same PID.
      // Historical tasks retain their snapshots; their old JVM must never become a new target.
      for (const [id, record] of this.agents) {
        const previous = record.agent.jvm;
        if (
          record.owner === owner &&
          previous.projectId === target.projectId &&
          previous.environmentId === target.environmentId &&
          previous.serviceId === target.serviceId &&
          previous.instanceId === target.instanceId &&
          !jvms.some((jvm) => sameJvm(previous, jvm))
        )
          this.agents.delete(id);
      }
      return jvms;
    });
  }
  private async request(
    owner: number,
    agent: ArthasAgent,
    payload: Record<string, unknown>,
  ): Promise<ApiResponse> {
    return this.serial(agent.jvm.connectionId, async () => {
      const session = await this.verify(owner, agent.jvm);
      const command = `curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 10 -H 'Content-Type: application/json' -X POST --data-binary ${shellQuote(JSON.stringify(payload))} http://127.0.0.1:${agent.port}/api`;
      const response = JSON.parse(
        await this.sessions.execute(session, this.exec(agent.jvm, command)),
      ) as ApiResponse;
      if (!['SUCCEEDED', 'SCHEDULED'].includes(response.state))
        throw new Error(response.message || 'Arthas拒绝请求');
      return response;
    });
  }
  private async command(
    owner: number,
    agent: ArthasAgent,
    command: string,
  ): Promise<Record<string, unknown>[]> {
    const response = await this.request(owner, agent, {
      action: 'exec',
      command,
      execTimeout: 5000,
    });
    const results = response.body?.results ?? [];
    const status = results.find((r) => r.type === 'status');
    if (!status || status.statusCode !== 0)
      throw new Error(String(status?.message || 'Arthas命令未成功完成'));
    return results;
  }
  async attach(owner: number, input: AttachInput): Promise<ArthasAgent> {
    const epoch = this.epochs.get(owner) ?? 0;
    this.epochs.set(owner, epoch);
    const revision = this.revisions.get(input.jvm.projectId) ?? 0;
    const assertCurrent = (): void => {
      if (
        (this.epochs.get(owner) ?? 0) !== epoch ||
        (this.revisions.get(input.jvm.projectId) ?? 0) !== revision
      )
        throw new Error('工作区已关闭或配置已变化，请重新接入');
    };
    const progress = (stage: ArthasAttachProgress['stage']): void => {
      this.emit(owner, { type: 'arthas-attach-progress', progress: { jvm: input.jvm, stage } });
    };
    await this.serial(input.jvm.connectionId, async () => {
      assertCurrent();
      let session = await this.verify(owner, input.jvm);
      progress('checking');
      const presence = await this.sessions.execute(
        session,
        this.exec(input.jvm, packageProbe(input.home)),
      );
      assertCurrent();
      const bootOnly = presence.trim() !== 'present';
      if (presence.trim() === 'missing') {
        progress('installing');
        console.info('[arthas] installing package', {
          instanceId: input.jvm.instanceId,
          version: ARTHAS_VERSION,
        });
        try {
          await this.sessions.execute(
            session,
            this.exec(input.jvm, packageInstall(input.home, input.jvm.java)),
            150000,
          );
        } catch (error) {
          console.warn('[arthas] package installation failed', {
            instanceId: input.jvm.instanceId,
            error: (error as Error).message,
          });
          throw error;
        }
        // Downloads can outlive a container restart or a window/configuration change.
        assertCurrent();
        session = await this.verify(owner, input.jvm);
      }
      assertCurrent();
      const home = shellQuote(input.home);
      const boot = shellQuote(`${input.home}/arthas-boot.jar`);
      const java = shellQuote(input.jvm.java);
      const cache = bootOnly
        ? `ARTHAS_LIB_DIR=${shellQuote(`${input.home}/.arthas/lib`)} ${java} -Duser.home=${home}`
        : java;
      const check = `command -v curl >/dev/null || { printf '容器缺少curl，请安装后接入Arthas' >&2; exit 1; }; ${cache} -jar ${boot} --help`;
      const help = await this.sessions.execute(session, this.exec(input.jvm, check));
      if (!help.includes(`arthas-boot version: ${ARTHAS_VERSION}`))
        throw new Error(
          `工具包版本不匹配，需要Arthas ${ARTHAS_VERSION}；请更换目录或准备对应版本arthas-boot.jar`,
        );
      assertCurrent();
      progress(bootOnly ? 'bootstrapping' : 'attaching');
      // The official launcher downloads/extracts dependencies using Java, without a system unzip.
      // Isolate its writable cache from the account's OS home and inherited ARTHAS_LIB_DIR.
      const launcher = bootOnly
        ? `${cache} -Dsun.net.client.defaultConnectTimeout=10000 -Dsun.net.client.defaultReadTimeout=120000 -jar ${boot} --use-version ${ARTHAS_VERSION} --repo-mirror center`
        : `${java} -jar ${boot} --arthas-home ${home}`;
      // Arthas 4.0.5 probes Telnet even with --attach-only; -1 throws before attach.
      // Port 0 requests a loopback random port, avoiding both that bug and a fixed-port collision.
      await this.sessions.execute(
        session,
        this.exec(
          input.jvm,
          `${launcher} --attach-only --target-ip 127.0.0.1 --telnet-port 0 --http-port ${input.port} ${input.jvm.pid}`,
        ),
        bootOnly ? 150000 : 15000,
      );
      assertCurrent();
      await this.verify(owner, input.jvm);
    });
    const agent: ArthasAgent = {
      id: randomUUID(),
      jvm: structuredClone(input.jvm),
      version: ARTHAS_VERSION,
      port: input.port,
    };
    assertCurrent();
    progress('verifying');
    const versions = await this.command(owner, agent, 'version');
    const identity = await this.command(owner, agent, 'session');
    if (
      !versions.some((r) => r.type === 'version' && r.version === ARTHAS_VERSION) ||
      !identity.some((r) => r.type === 'session' && Number(r.javaPid) === agent.jvm.pid)
    )
      throw new Error('Arthas端口对应的版本或JVM不匹配，请核对工具包及端口');
    if (
      (this.epochs.get(owner) ?? 0) !== epoch ||
      (this.revisions.get(input.jvm.projectId) ?? 0) !== revision
    )
      throw new Error('工作区已关闭或配置已变化，请重新接入');
    // Repeated attachment uses the existing agent record; it never stops an agent used by another client.
    const existing = [...this.agents.values()].find(
      (a) => a.owner === owner && sameJvm(a.agent.jvm, agent.jvm) && a.agent.port === agent.port,
    );
    if (existing) return structuredClone(existing.agent);
    this.agents.set(agent.id, { owner, agent });
    console.info('[arthas] agent verified', {
      agentId: agent.id,
      instanceId: agent.jvm.instanceId,
      pid: agent.jvm.pid,
    });
    return structuredClone(agent);
  }
  getAgent(owner: number, id: string): ArthasAgent {
    const value = this.agents.get(id);
    if (!value || value.owner !== owner) throw new Error('Arthas连接不属于当前工作区或已失效');
    this.session(owner, value.agent.jvm);
    return value.agent;
  }
  async search(
    owner: number,
    id: string,
    query: string,
    packageName: string,
  ): Promise<MethodCandidate[]> {
    const agent = this.getAgent(owner, id);
    const parts = query.split('#');
    const className = parts.length === 2 ? parts[0] : `${packageName}.*`;
    const method = parts.length === 2 ? parts[1] : parts[0];
    if (
      !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(
        parts.length === 2 ? className : packageName,
      ) ||
      !/^[A-Za-z_$][\w$]*$/.test(method) ||
      parts.length > 2
    )
      throw new Error('请输入业务包名及具体方法名，或完整类名#方法名');
    const results = await this.command(owner, agent, `sm -d ${className} ${method}`);
    this.getAgent(owner, id);
    return results
      .filter((r) => r.type === 'sm' && r.methodInfo)
      .map((r) => {
        const info = r.methodInfo as Record<string, unknown>;
        return methodSchema.parse({
          className: info.declaringClass,
          methodName: info.methodName,
          classLoaderHash: info.classLoaderHash,
          parameters: info.parameters,
          returnType: info.returnType,
          descriptor: info.descriptor,
          modifier: typeof info.modifier === 'string' ? info.modifier : undefined,
        });
      });
  }
  async resolveTraceScope(owner: number, input: TraceScopeInput): Promise<MethodCandidate[]> {
    const value = traceScopeSchema.parse(input);
    const agent = this.getAgent(owner, value.agentId);
    const patterns = multiTracePatterns(value.classes, value.methods);
    const results = await this.command(
      owner,
      agent,
      `sm -d -E ${patterns.classes} ${patterns.methods} -c ${value.classLoaderHash}`,
    );
    this.getAgent(owner, value.agentId);
    const methods = results
      .filter((result) => {
        const info = result.methodInfo as { constructor?: boolean } | undefined;
        // sm '*' also returns constructors, which are not supported diagnostic method targets.
        return result.type === 'sm' && info && info.constructor !== true;
      })
      .map((result) => {
        const info = result.methodInfo as Record<string, unknown>;
        return methodSchema.parse({
          className: info.declaringClass,
          methodName: info.methodName,
          classLoaderHash: info.classLoaderHash,
          parameters: info.parameters,
          returnType: info.returnType,
          descriptor: info.descriptor,
          modifier: typeof info.modifier === 'string' ? info.modifier : undefined,
        });
      })
      .filter(
        (method) =>
          value.classes.includes(method.className) &&
          (value.methods.includes('*') || value.methods.includes(method.methodName)) &&
          method.classLoaderHash === value.classLoaderHash &&
          !/\b(?:abstract|native)\b/.test(method.modifier ?? ''),
      );
    const missingClasses = value.classes.filter(
      (name) => !methods.some((method) => method.className === name),
    );
    const missingMethods = value.methods.filter(
      (name) => name !== '*' && !methods.some((method) => method.methodName === name),
    );
    if (missingClasses.length || missingMethods.length)
      throw new Error(
        `当前ClassLoader未找到可增强目标：${[...missingClasses, ...missingMethods].join('、')}，请核对类名、方法及具体实现`,
      );
    return [
      ...new Map(
        methods.map((method) => [
          JSON.stringify([
            method.className,
            method.methodName,
            method.descriptor,
            method.classLoaderHash,
          ]),
          method,
        ]),
      ).values(),
    ].sort((a, b) =>
      `${a.className}#${a.methodName}${a.descriptor}`.localeCompare(
        `${b.className}#${b.methodName}${b.descriptor}`,
      ),
    );
  }
  async decompile(
    owner: number,
    id: string,
    className: string,
    classLoaderHash: string,
  ): Promise<string> {
    methodSchema.shape.className.parse(className);
    methodSchema.shape.classLoaderHash.parse(classLoaderHash);
    const agent = this.getAgent(owner, id);
    const results = await this.command(
      owner,
      agent,
      `jad --source-only --lineNumber false -c ${classLoaderHash} ${className}`,
    );
    this.getAgent(owner, id);
    const sources = results.filter(
      (result) =>
        result.type === 'jad' &&
        typeof result.source === 'string' &&
        result.source.trim() &&
        result.source !== 'unknown',
    );
    if (sources.length !== 1) throw new Error(`Arthas未返回唯一的运行源码：${className}`);
    return sources[0].source as string;
  }
  private state(record: TaskRecord, status: DiagnosticTask['status'], error?: string): void {
    record.task.status = status;
    record.task.error = error;
    if (!record.disposed)
      this.emit(record.owner, { type: 'diagnostic-state', task: structuredClone(record.task) });
  }
  start(owner: number, input: DiagnosticInput): DiagnosticTask {
    const agent = this.getAgent(owner, input.agentId);
    if (
      [...this.tasks.values()].some(
        (t) =>
          t.task.agentId === agent.id &&
          ['submitted', 'waiting', 'results', 'stopping'].includes(t.task.status),
      )
    )
      throw new Error('此JVM已有诊断任务，请先停止');
    const record: TaskRecord = {
      owner,
      agent,
      cancelled: false,
      disposed: false,
      task: {
        id: randomUUID(),
        agentId: agent.id,
        jvm: structuredClone(agent.jvm),
        command: diagnosticCommand(input),
        status: 'submitted',
        results: [],
        scope: input.kind === 'trace-multi' ? structuredClone(input.scope) : undefined,
        method: structuredClone(input.method),
      },
    };
    this.tasks.set(record.task.id, record);
    this.state(record, 'submitted');
    record.run = this.run(record, input);
    return structuredClone(record.task);
  }
  private async run(record: TaskRecord, input: DiagnosticInput): Promise<void> {
    const { owner, agent } = record;
    const deep =
      input.kind === 'deep'
        ? new DeepCapture(input.method, input.sampleIntervalMs ?? 1000)
        : undefined;
    if (deep) record.task.deep = deep.profile;
    let deepFinished = false;
    let lastSampleAt = 0;
    const timer = setTimeout(() => {
      record.cancelled = true;
    }, input.duration * 1000);
    try {
      // Revalidate the selected signature on this instance; overload selection does not restrict enhancement to that signature.
      const candidates = await this.search(
        owner,
        agent.id,
        `${input.method.className}#${input.method.methodName}`,
        '',
      );
      if (
        !candidates.some(
          (m) =>
            m.classLoaderHash === input.method.classLoaderHash &&
            m.descriptor === input.method.descriptor,
        )
      )
        throw new Error('方法或ClassLoader已变化，请重新搜索');
      if (input.kind === 'trace-multi') {
        // A class/method-name combination includes every matching overload. Re-resolve the full
        // combination before enhancement, so a forged, stale or partially checked scope cannot run.
        const actual = await this.resolveTraceScope(owner, {
          agentId: input.agentId,
          classLoaderHash: input.method.classLoaderHash,
          classes: [...new Set(input.scope!.map((method) => method.className))],
          methods: [...new Set(input.scope!.map((method) => method.methodName))],
        });
        const key = (method: MethodCandidate): string =>
          JSON.stringify([
            method.className,
            method.methodName,
            method.descriptor,
            method.classLoaderHash,
          ]);
        const expected = new Set(input.scope!.map(key));
        if (actual.length !== expected.size || actual.some((method) => !expected.has(key(method))))
          throw new Error('多层追踪实际范围已变化或包含未核对的重载，请重新核对范围');
        console.info('[arthas] multi trace scope verified', {
          agentId: agent.id,
          classes: new Set(actual.map((method) => method.className)).size,
          methods: actual.length,
        });
      }
      if (record.cancelled) {
        deep?.partial('诊断已停止，尚未开始采样。');
        this.state(record, 'stopped');
        return;
      }
      const session = await this.request(owner, agent, { action: 'init_session' });
      record.sessionId = session.sessionId;
      record.consumerId = session.consumerId;
      if (!record.sessionId || !record.consumerId) throw new Error('Arthas未返回会话标识');
      if (!record.cancelled) {
        const scheduled = await this.request(owner, agent, {
          action: 'async_exec',
          sessionId: record.sessionId,
          command: record.task.command,
        });
        record.jobId = scheduled.body?.jobId;
        if (typeof record.jobId !== 'number') throw new Error('Arthas未返回任务标识');
        while (!record.cancelled) {
          const response = await this.request(owner, agent, {
            action: 'pull_results',
            sessionId: record.sessionId,
            consumerId: record.consumerId,
          });
          const results = (response.body?.results ?? []).filter((r) => r.jobId === record.jobId);
          if (deep) {
            const previousPhase = deep.profile.phase;
            // The first entry selects one invocation. Other threads and recursive exits cannot
            // finish it. Only selected markers are retained; never retain business watch values.
            const kept = results.filter((result) => result.type !== 'watch' || deep.marker(result));
            if (previousPhase === 'waiting' && deep.profile.threadId)
              console.info('[arthas] deep entry captured', {
                taskId: record.task.id,
                agentId: agent.id,
                threadId: deep.profile.threadId,
              });
            record.task.results = [...record.task.results, ...kept].slice(-200);
            if (deep.profile.phase === 'complete') {
              deepFinished = true;
              break;
            }
            if (
              deep.profile.phase === 'running' &&
              Date.now() - lastSampleAt >= deep.profile.intervalMs
            ) {
              lastSampleAt = Date.now();
              const sampled = await this.command(owner, agent, `thread ${deep.profile.threadId}`);
              // Read a clock fence after the stack: a later exit marker can conservatively
              // exclude snapshots from a subsequent request on the same thread/entry.
              const clock = await this.command(
                owner,
                agent,
                "ognl '@java.lang.System@nanoTime()' -x 1",
              );
              const stamp = /^@Long\[(-?\d+)\]$/.exec(
                String(clock.find((r) => r.type === 'ognl')?.value),
              );
              if (!stamp) throw new Error('深入追踪未收到有效的采样时钟');
              deep.sample(sampled, stamp[1]);
              record.task.results = [
                ...record.task.results,
                ...sampled
                  .filter((r) => r.type === 'thread')
                  .map((r) => ({ ...r, deepSampleNanos: stamp[1] })),
              ].slice(-200);
            }
          } else record.task.results = [...record.task.results, ...results].slice(-200);
          const status = results.find((r) => r.type === 'status');
          if (status) {
            if (deep)
              throw new Error(String(status.message || '入口观察提前结束，未确认所选调用完成'));
            this.state(
              record,
              status.statusCode === 0 ? 'ended' : 'error',
              status.statusCode === 0 ? undefined : String(status.message || '诊断命令失败'),
            );
            break;
          }
          const enhancer = results.find((r) => r.type === 'enhancer');
          if (
            enhancer &&
            (enhancer.success !== true ||
              Number((enhancer.effect as Record<string, unknown>)?.methodCount) === 0)
          )
            throw new Error('未成功增强目标方法，请检查方法和ClassLoader');
          this.state(
            record,
            deep?.profile.phase === 'running' ||
              record.task.results.some((r) =>
                ['trace', 'watch', 'monitor', 'stack'].includes(String(r.type)),
              )
              ? 'results'
              : enhancer
                ? 'waiting'
                : record.task.status,
          );
          // Some proxies return empty polls immediately. Yield between polls to keep the shell usable.
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      if ((record.cancelled || deepFinished) && !['ended', 'error'].includes(record.task.status)) {
        this.state(record, 'stopping');
        if (record.jobId !== undefined) {
          const interrupted = await this.request(owner, agent, {
            action: 'interrupt_job',
            sessionId: record.sessionId,
          });
          if (
            interrupted.body?.jobStatus !== 'TERMINATED' ||
            interrupted.body.jobId !== record.jobId
          )
            throw new Error('未确认当前诊断任务已结束');
        }
        if (record.cancelled)
          deep?.partial('已停止或达到最长运行时间；只保留实际采集到的调用栈，未确认请求结束。');
        this.state(record, record.cancelled ? 'stopped' : 'ended');
      }
    } catch (error) {
      deep?.partial((error as Error).message);
      this.state(
        record,
        record.sessionId ? 'unknown' : record.cancelled ? 'stopped' : 'error',
        (error as Error).message,
      );
    } finally {
      clearTimeout(timer);
      if (record.sessionId) {
        try {
          // Only close our dedicated session. Never issue global stop/reset against a shared agent.
          await this.request(owner, agent, {
            action: 'close_session',
            sessionId: record.sessionId,
          });
        } catch (error) {
          this.state(record, 'unknown', `会话清理未确认：${(error as Error).message}`);
        }
      }
      console.info('[arthas] diagnostic finished', {
        taskId: record.task.id,
        status: record.task.status,
        ...(deep ? { samples: deep.profile.samples, capture: deep.profile.phase } : {}),
      });
    }
  }
  async stop(owner: number, id: string): Promise<void> {
    const record = this.tasks.get(id);
    if (!record || record.owner !== owner) throw new Error('诊断任务不属于当前工作区');
    if (!['submitted', 'waiting', 'results', 'stopping'].includes(record.task.status)) return;
    record.cancelled = true;
    this.state(record, 'stopping');
    await record.run;
  }
  reconcile(project: Project): void {
    this.revisions.set(project.id, (this.revisions.get(project.id) ?? 0) + 1);
    for (const [id, { agent }] of this.agents) {
      if (agent.jvm.projectId !== project.id) continue;
      const instance = project.environments
        .find((e) => e.id === agent.jvm.environmentId)
        ?.services.find((s) => s.id === agent.jvm.serviceId)
        ?.instances.find((i) => i.id === agent.jvm.instanceId);
      if (
        !instance ||
        instance.serverId !== agent.jvm.serverId ||
        instance.containerName !== agent.jvm.containerName
      ) {
        for (const record of this.tasks.values())
          if (record.task.agentId === id) record.cancelled = true;
        this.agents.delete(id);
      }
    }
  }
  disposeOwner(owner: number): void {
    this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    for (const [id, value] of this.agents) if (value.owner === owner) this.agents.delete(id);
    for (const [id, record] of this.tasks)
      if (record.owner === owner) {
        record.cancelled = true;
        record.disposed = true;
        this.tasks.delete(id);
      }
  }
}
