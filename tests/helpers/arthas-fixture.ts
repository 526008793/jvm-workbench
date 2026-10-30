import { ARTHAS_VERSION } from '../../src/shared/arthas';

// Protocol fixture only: it does not emulate JVM instrumentation or prove Docker/attach compatibility.
export function createArthasResponder() {
  const state = {
    version: ARTHAS_VERSION,
    packagePresent: true,
    bootPresent: false,
    installs: 0,
    pid: 7,
    containerId: 'a'.repeat(64),
    startTicks: '98765',
    startedAt: '2026-10-29T01:00:00Z',
    finish: true,
    interrupt: true,
    methods: true,
    counter: 0,
    requests: [] as Record<string, unknown>[],
    commands: [] as string[],
    methodResults: {} as Record<string, Record<string, unknown>[]>,
    jadSources: {} as Record<string, string>,
    scopeResults: [] as Record<string, unknown>[],
    traceRoot: undefined as Record<string, unknown> | undefined,
    deepStart: true,
    deepFinish: true,
    deepClock: 1000000000,
    deepThreadInfo: undefined as Record<string, unknown> | undefined,
  };
  const method = {
    declaringClass: 'com.example.CatalogService',
    methodName: 'query',
    classLoaderHash: 'abc123',
    parameters: ['java.lang.String'],
    returnType: 'java.lang.String',
    descriptor: '(Ljava/lang/String;)Ljava/lang/String;',
  };
  const decode = (s: string): string => s.slice(1, -1).replaceAll(`'"'"'`, "'");
  const sessions = new Map<string, { polls: number; job: number; command?: string }>();
  function output(command: string): string | undefined {
    if (command.includes('docker inspect'))
      return JSON.stringify({ id: state.containerId, running: true, startedAt: state.startedAt });
    const marker = command.indexOf(' sh -c ');
    if (marker < 0) return undefined;
    const script = decode(command.slice(marker + 7));
    state.commands.push(script);
    if (script.startsWith('for p in /proc/'))
      return `7\t1000\t${state.startTicks}\t/usr/bin/java\n42\t1000\t98766\t/usr/bin/java\n`;
    if (script.startsWith('test "$(readlink')) return '';
    if (script.startsWith('home='))
      return state.packagePresent ? 'present' : state.bootPresent ? 'boot' : 'missing';
    if (script.startsWith('set -e;')) {
      state.installs += 1;
      state.bootPresent = true;
      return '';
    }
    if (script.includes('--help')) return `arthas-boot version: ${ARTHAS_VERSION}\n`;
    if (script.includes('--attach-only')) return 'Attach success\n';
    if (!script.startsWith('curl ')) return undefined;
    const payload = /--data-binary (.*) http:\/\/127\.0\.0\.1:/.exec(script);
    if (!payload) throw new Error('Missing Arthas fixture JSON');
    const request = JSON.parse(decode(payload[1]));
    state.requests.push(request);
    let body: Record<string, unknown> = {};
    if (request.action === 'exec') {
      let results: Record<string, unknown>[] = [];
      if (request.command === 'version') results = [{ type: 'version', version: state.version }];
      else if (request.command === 'session') results = [{ type: 'session', javaPid: state.pid }];
      else if (request.command.startsWith('jad ')) {
        const className = request.command.split(' ').at(-1);
        results = state.jadSources[className]
          ? [{ type: 'jad', source: state.jadSources[className] }]
          : [];
      } else if (request.command.startsWith('ognl ')) {
        state.deepClock += 1000000000;
        results = [{ type: 'ognl', value: `@Long[${state.deepClock}]` }];
      } else if (request.command.startsWith('thread '))
        results = [
          {
            type: 'thread',
            threadInfo: state.deepThreadInfo ?? {
              threadId: 41,
              threadName: 'export-worker',
              threadState: 'RUNNABLE',
              stackTrace: [
                {
                  className: 'java.net.SocketInputStream',
                  methodName: 'socketRead0',
                  lineNumber: -2,
                },
                {
                  className: 'com.mysql.cj.protocol.a.NativeProtocol',
                  methodName: 'readMessage',
                  fileName: 'NativeProtocol.java',
                  lineNumber: 500,
                },
                {
                  className: 'com.example.OrderMapper',
                  methodName: 'selectGoods',
                  fileName: 'OrderMapper.java',
                  lineNumber: 77,
                },
                {
                  className: 'com.example.OrderAssembler',
                  methodName: 'fillGoodsList',
                  fileName: 'OrderAssembler.java',
                  lineNumber: 129,
                },
                {
                  className: 'com.example.OrderAssembler',
                  methodName: 'doAssemble',
                  fileName: 'OrderAssembler.java',
                  lineNumber: 100,
                },
                {
                  className: 'com.example.CatalogService',
                  methodName: 'query',
                  fileName: 'CatalogService.java',
                  lineNumber: 304,
                },
              ],
            },
          },
        ];
      else if (request.command.startsWith('sm -d -E '))
        results = state.scopeResults.map((methodInfo) => ({ type: 'sm', methodInfo }));
      else if (state.methodResults[request.command])
        results = state.methodResults[request.command].map((methodInfo) => ({
          type: 'sm',
          methodInfo,
        }));
      else if (
        /^sm -d com\.example\.(OrderAssembler|OrderMapper) /.test(request.command) &&
        state.jadSources[request.command.split(' ')[2]]
      ) {
        const [, , className, methodName] = request.command.split(' ');
        results = [
          {
            type: 'sm',
            methodInfo: {
              ...method,
              declaringClass: className,
              methodName,
              classLoaderHash: 'abc123',
            },
          },
        ];
      } else if (request.command.startsWith('sm -d') && state.methods)
        results = [
          { type: 'sm', methodInfo: method },
          {
            type: 'sm',
            methodInfo: { ...method, parameters: [], descriptor: '()Ljava/lang/String;' },
          },
        ];
      body = { results: [...results, { type: 'status', statusCode: 0 }], jobStatus: 'TERMINATED' };
    }
    if (request.action === 'init_session') {
      const id = `fixture-${++state.counter}`;
      sessions.set(id, { polls: 0, job: state.counter });
      return JSON.stringify({ state: 'SUCCEEDED', sessionId: id, consumerId: `consumer-${id}` });
    }
    const session = sessions.get(request.sessionId);
    if (request.action === 'async_exec') {
      session!.command = request.command;
      body = { jobId: session!.job, jobStatus: 'READY' };
    }
    if (request.action === 'pull_results') {
      session!.polls += 1;
      const jobId = session!.job;
      body = {
        results:
          session!.polls === 1
            ? [
                {
                  type: 'enhancer',
                  success: true,
                  jobId,
                  effect: { methodCount: 2, classCount: 1 },
                },
              ]
            : state.finish
              ? [
                  {
                    type: 'trace',
                    jobId,
                    fixture: 'slow query 你好',
                    root: state.traceRoot ?? {
                      type: 'thread',
                      classloader: 'ThreadContextLoader@fffffff',
                      threadName: 'fixture-worker',
                      timestamp: '2026-10-29 17:30:47',
                      children: [
                        {
                          type: 'method',
                          className: 'com.example.CatalogService',
                          methodName: 'query',
                          invoking: false,
                          totalCost: 43398139751,
                          children: [
                            {
                              type: 'method',
                              className: 'com.example.OrderMapper',
                              methodName: 'selectAll',
                              invoking: true,
                              lineNumber: 301,
                              cost: 142575506,
                              totalCost: 142575506,
                              times: 1,
                            },
                            {
                              type: 'method',
                              className: 'com.example.OrderAssembler',
                              methodName: 'assembleForExport',
                              invoking: true,
                              lineNumber: 304,
                              cost: 42478227061,
                              totalCost: 42478227061,
                              times: 1,
                            },
                            {
                              type: 'method',
                              className: 'com.example.OrderVO',
                              methodName: 'getGoodsList',
                              invoking: true,
                              lineNumber: 317,
                              cost: 990,
                              totalCost: 15620720,
                              maxCost: 186547,
                              times: 10171,
                            },
                          ],
                        },
                      ],
                    },
                  },
                  { type: 'status', jobId, statusCode: 0 },
                ]
              : [],
      };
      if (session!.command?.includes('TLDDEEP:') && session!.polls > 1) {
        const before = session!.polls === 2 && state.deepStart;
        const after = session!.polls === 6 && state.deepStart && state.deepFinish;
        body = {
          results:
            before || after
              ? [
                  {
                    type: 'watch',
                    className: 'com.example.CatalogService',
                    methodName: 'query',
                    accessPoint: before ? 'AtEnter' : 'AtExit',
                    jobId,
                    ts: '2026-10-30 12:00:00',
                    value: `@String[TLDDEEP:41:${before ? '1000000000' : '46000000000'}]`,
                  },
                ]
              : [],
        };
      }
    }
    if (request.action === 'interrupt_job') {
      if (!state.interrupt)
        return JSON.stringify({ state: 'FAILED', message: 'fixture interruption unconfirmed' });
      body = { jobId: session!.job, jobStatus: 'TERMINATED' };
    }
    if (request.action === 'close_session') sessions.delete(request.sessionId);
    return JSON.stringify({
      state: request.action === 'async_exec' ? 'SCHEDULED' : 'SUCCEEDED',
      body,
    });
  }
  return { state, output };
}
