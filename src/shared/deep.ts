export interface StackFrame {
  className: string;
  methodName: string;
  fileName?: string;
  lineNumber?: number;
}
export interface DeepPath {
  id: string;
  hits: number;
  state: string;
  frames: StackFrame[];
  lockName?: string;
  lockOwnerId?: number;
  lockOwnerName?: string;
}
export interface DeepProfile {
  entryClass: string;
  entryMethod: string;
  intervalMs: number;
  phase: 'waiting' | 'running' | 'complete' | 'partial';
  threadId?: number;
  threadName?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exceptional?: boolean;
  samples: number;
  meanIntervalMs?: number;
  skipped: number;
  paths: DeepPath[];
  reason?: string;
}

// Only capture primitive thread/time markers. Never evaluate business parameters or return values.
export function deepWatchCommand(entry: {
  className: string;
  methodName: string;
  classLoaderHash: string;
}): string {
  const literal = entry.className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const condition = `clazz.name=="${entry.className}" && method.name=="${entry.methodName}"`;
  // Keep observing both entry/exit until the selected invocation finishes; concurrent requests
  // must not consume a small -n limit. The app interrupts only its own session on completion.
  return `watch -E '^${literal}$' '^${entry.methodName.replace(/[$]/g, '\\$')}$' '"TLDDEEP:"+@java.lang.Thread@currentThread().getId()+":"+@java.lang.System@nanoTime()' '${condition}' -b -f -x 1 -n 2147483647 -c ${entry.classLoaderHash} --exclude-class-pattern '^(?!${literal}$).*$'`;
}

export class DeepCapture {
  readonly profile: DeepProfile;
  private entered?: bigint;
  private depth = 0;
  private firstSampleAt?: bigint;
  private readonly accepted: { path: DeepPath; time: bigint }[] = [];
  private readonly paths = new Map<string, DeepPath>();

  constructor(entry: { className: string; methodName: string }, intervalMs: number) {
    this.profile = {
      entryClass: entry.className,
      entryMethod: entry.methodName,
      intervalMs,
      phase: 'waiting',
      samples: 0,
      skipped: 0,
      paths: [],
    };
  }

  marker(result: Record<string, unknown>): boolean {
    if (
      result.type !== 'watch' ||
      result.className !== this.profile.entryClass ||
      result.methodName !== this.profile.entryMethod
    )
      return false;
    const match = /^@String\[TLDDEEP:(\d+):(-?\d+)\]$/.exec(String(result.value));
    if (!match) throw new Error('深入追踪未收到有效的线程/时钟标识');
    const threadId = Number(match[1]);
    const time = BigInt(match[2]);
    const before = result.accessPoint === 'AtEnter';
    if (this.profile.phase === 'waiting' && before) {
      this.profile.threadId = threadId;
      this.profile.startedAt = String(result.ts ?? '');
      this.profile.phase = 'running';
      this.entered = time;
    }
    if (this.profile.phase !== 'running' || this.profile.threadId !== threadId) return false;
    if (before) this.depth += 1;
    else if (['AtExit', 'AtExceptionExit'].includes(String(result.accessPoint))) {
      this.depth -= 1;
      if (this.depth === 0) {
        // watch -b/-f's own cost is not a reliable pair timer. Use target-JVM monotonic stamps.
        this.profile.durationMs = Number(time - this.entered!) / 1e6;
        this.profile.finishedAt = String(result.ts ?? '');
        this.profile.exceptional = result.accessPoint === 'AtExceptionExit';
        this.profile.phase = 'complete';
        // Discard samples collected after this invocation exited, even if the same pooled
        // thread immediately entered the same method again before the exit event was polled.
        for (const sample of this.accepted) {
          if (sample.time <= time) continue;
          sample.path.hits -= 1;
          this.profile.samples -= 1;
          this.profile.skipped += 1;
        }
        this.profile.paths = this.profile.paths.filter((path) => path.hits > 0);
        const valid = this.accepted.filter((sample) => sample.time <= time);
        this.profile.meanIntervalMs =
          valid.length > 1
            ? Number(valid.at(-1)!.time - valid[0].time) / 1e6 / (valid.length - 1)
            : undefined;
      }
    }
    return true;
  }

  sample(results: Record<string, unknown>[], timestamp: string): void {
    const time = BigInt(timestamp);
    const info = results.find((r) => r.type === 'thread')?.threadInfo as
      Record<string, unknown> | undefined;
    const frames = Array.isArray(info?.stackTrace)
      ? info.stackTrace.filter(
          (frame): frame is StackFrame =>
            frame && typeof frame.className === 'string' && typeof frame.methodName === 'string',
        )
      : [];
    if (
      this.profile.phase !== 'running' ||
      time < this.entered! ||
      !info ||
      info?.threadId !== this.profile.threadId ||
      !frames.some(
        (frame) =>
          frame.className === this.profile.entryClass &&
          frame.methodName === this.profile.entryMethod,
      )
    ) {
      this.profile.skipped += 1;
      return;
    }
    this.profile.threadName = String(info.threadName ?? '');
    const key = JSON.stringify([info.threadState, info.lockName, info.lockOwnerId, frames]);
    let path = this.paths.get(key);
    if (!path) {
      path = {
        id: `path-${this.paths.size + 1}`,
        hits: 0,
        state: String(info.threadState ?? 'UNKNOWN'),
        frames: frames.slice(
          0,
          frames.length -
            [...frames]
              .reverse()
              .findIndex(
                (frame) =>
                  frame.className === this.profile.entryClass &&
                  frame.methodName === this.profile.entryMethod,
              ),
        ),
        lockName: typeof info.lockName === 'string' ? info.lockName : undefined,
        lockOwnerId:
          typeof info.lockOwnerId === 'number' && info.lockOwnerId >= 0
            ? info.lockOwnerId
            : undefined,
        lockOwnerName: typeof info.lockOwnerName === 'string' ? info.lockOwnerName : undefined,
      };
      this.paths.set(key, path);
      this.profile.paths.push(path);
    }
    path.hits += 1;
    this.profile.samples += 1;
    this.accepted.push({ path, time });
    this.firstSampleAt ??= time;
    if (this.profile.samples > 1)
      this.profile.meanIntervalMs =
        Number(time - this.firstSampleAt) / 1e6 / (this.profile.samples - 1);
  }

  partial(reason: string): void {
    if (this.profile.phase === 'complete') return;
    this.profile.phase = 'partial';
    this.profile.reason = reason;
  }
}

export function deepEvidence(path: DeepPath): { label: string; detail: string } {
  const stack = path.frames.map((f) => `${f.className}.${f.methodName}`).join('\n');
  if (path.state === 'BLOCKED')
    return {
      label: '锁竞争',
      detail:
        path.lockOwnerId === undefined
          ? '线程阻塞于监视器锁；需要核对持锁线程。'
          : `等待线程 ${path.lockOwnerName || path.lockOwnerId}（ID ${path.lockOwnerId}）持有的锁。`,
    };
  if (
    /HikariPool\.getConnection|ConcurrentBag\.borrow|DruidDataSource.*getConnection|GenericObjectPool\.borrowObject/.test(
      stack,
    )
  )
    return {
      label: '连接池等待线索',
      detail: '调用栈停在借用连接路径；需结合连接池活跃数及连接持有时间确认。',
    };
  if (
    /Socket.*(?:read|write)|socketRead|socketWrite|NioSocketImpl.*(?:read|write)|Net\.poll|SSLSocketInputRecord/.test(
      stack,
    )
  )
    return /com\.mysql|org\.postgresql|oracle\.jdbc|com\.microsoft\.sqlserver/.test(stack)
      ? {
          label: '数据库网络等待线索',
          detail: '线程停在数据库驱动网络路径；不能仅据此断定慢SQL、缺索引或数据库锁。',
        }
      : {
          label: '网络 I/O 等待线索',
          detail: '线程停在网络读写路径；需结合对应远端响应、超时与网络情况确认。',
        };
  if (/java\.lang\.Thread\.sleep/.test(stack))
    return {
      label: '休眠/重试间隔线索',
      detail: '采样时线程正在休眠；沿业务调用位置核对轮询、限流或重试逻辑。',
    };
  if (/FileDispatcherImpl|FileInputStream\.read|FileOutputStream\.write/.test(stack))
    return {
      label: '文件 I/O 线索',
      detail: '线程停在文件读写路径；需结合磁盘吞吐与响应时间确认。',
    };
  if (['WAITING', 'TIMED_WAITING'].includes(path.state))
    return {
      label: '线程等待',
      detail: '沿完整调用栈核对Future、队列、线程池或同步等待；等待状态本身不等于锁竞争。',
    };
  return {
    label: '运行中采样',
    detail: '该路径频繁出现是热点线索；RUNNABLE也可能包含本地I/O，不能直接等同于CPU占用。',
  };
}

export interface DeepConclusion {
  id: string;
  method: string;
  locations: StackFrame[];
  callers: StackFrame[];
  finding: string;
  suggestions: string[];
  hits: number;
}

export function deepConclusions(profile: DeepProfile): DeepConclusion[] {
  const boundary = /\.(?:controller|service|web|api)\./.exec(profile.entryClass)?.index;
  const prefix =
    boundary === undefined
      ? profile.entryClass.slice(0, profile.entryClass.lastIndexOf('.'))
      : profile.entryClass.slice(0, boundary);
  const recommendations: Record<string, { finding: string; suggestions: string[] }> = {
    锁竞争: {
      finding: '业务线程正在等待同步锁。',
      suggestions: [
        '检查持锁线程，缩小锁内的代码范围；将数据库、网络等耗时操作移出锁后，核对并发一致性。',
      ],
    },
    连接池等待线索: {
      finding: '执行路径停留在获取连接的位置，疑似等待可用连接。',
      suggestions: [
        '检查连接释放和长事务，缩短连接持有时间。',
        '结合连接池活跃数与数据库容量，再决定是否调整连接池大小。',
      ],
    },
    数据库网络等待线索: {
      finding: '执行路径停留在数据库驱动的网络读写处，优先排查此处数据库调用。',
      suggestions: [
        '核对这里调用的 SQL、慢查询和执行计划，再针对扫描、关联或排序设计索引。',
        '若代码在循环中逐条查询，改为批量查询后统一组装；同时核对数据库锁等待和网络响应。',
      ],
    },
    '网络 I/O 等待线索': {
      finding: '执行路径停留在网络读写处，优先排查此处远端调用。',
      suggestions: [
        '检查远端接口响应、超时与重试次数，避免重复重试放大耗时。',
        '若存在循环串行请求，优先使用批量接口；依赖允许时再考虑受控并发。',
      ],
    },
    '休眠/重试间隔线索': {
      finding: '该执行路径中存在休眠或重试等待。',
      suggestions: [
        '核对这行代码的 sleep、轮询或重试间隔；业务允许时减少重复等待，或改用事件通知。',
      ],
    },
    '文件 I/O 线索': {
      finding: '执行路径停留在文件读写处。',
      suggestions: [
        '检查是否存在循环小批量读写，按实际数据量使用缓冲或批量读写。',
        '大文件导出优先考虑流式写出，同时核对磁盘响应和内存占用。',
      ],
    },
    线程等待: {
      finding: '业务线程处于等待状态，需要核对这一行等待的结果或任务。',
      suggestions: [
        '检查 Future.get、join、队列或线程池等待，核对下游任务是否完成及线程池是否饱和；需要结合等待对象确认原因。',
      ],
    },
    运行中采样: {
      finding: '该业务位置在采样中出现，优先检查其内部计算或本地调用。',
      suggestions: [
        '检查该位置是否重复遍历、大集合组装或重复计算；确认后再考虑合并遍历、复用结果或分批处理。',
        '需要结合 CPU 指标确认是否为计算瓶颈，不能仅凭线程状态认定 CPU 很高。',
      ],
    },
  };
  const conclusions = new Map<string, DeepConclusion>();
  for (const path of profile.paths) {
    if (path.hits <= 0) continue;
    // Rank the innermost business location rather than repeating every parent frame at 100%.
    // Group line/stack variants of one method, retaining all observed source locations.
    const business = path.frames.filter(
      (frame) => frame.className.startsWith(prefix + '.') && !frame.className.includes('$$'),
    );
    const frame = business[0];
    if (!frame) continue;
    const evidence = deepEvidence(path);
    const method = `${frame.className}#${frame.methodName}`;
    const key = `${method}:${evidence.label}`;
    let conclusion = conclusions.get(key);
    if (!conclusion) {
      const advice = recommendations[evidence.label];
      conclusion = {
        id: key,
        method,
        locations: [],
        callers: [],
        finding: advice.finding,
        suggestions: advice.suggestions,
        hits: 0,
      };
      conclusions.set(key, conclusion);
    }
    conclusion.hits += path.hits;
    const caller = business.find(
      (candidate) => `${candidate.className}#${candidate.methodName}` !== method,
    );
    if (
      caller &&
      !conclusion.callers.some(
        (candidate) =>
          candidate.className === caller.className &&
          candidate.methodName === caller.methodName &&
          candidate.lineNumber === caller.lineNumber,
      )
    )
      conclusion.callers.push(caller);
    if (
      !conclusion.locations.some(
        (location) =>
          location.fileName === frame.fileName && location.lineNumber === frame.lineNumber,
      )
    )
      conclusion.locations.push(frame);
  }
  return [...conclusions.values()].sort((a, b) => b.hits - a.hits);
}
