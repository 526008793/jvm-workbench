import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeepCapture,
  deepConclusions,
  deepEvidence,
  deepWatchCommand,
  type DeepPath,
  type DeepProfile,
} from '../src/shared/deep';

const entry = {
  className: 'com.example.Controller',
  methodName: 'export',
  classLoaderHash: 'abcd',
};
function marker(thread: number, phase: string, nanos: string) {
  return {
    type: 'watch',
    className: entry.className,
    methodName: entry.methodName,
    accessPoint: phase,
    value: `@String[TLDDEEP:${thread}:${nanos}]`,
    cost: 999999999,
  };
}
function sample(threadId = 7, withEntry = true) {
  return [
    {
      type: 'thread',
      threadInfo: {
        threadId,
        threadName: 'worker',
        threadState: 'TIMED_WAITING',
        stackTrace: [
          { className: 'java.lang.Thread', methodName: 'sleep', lineNumber: -2 },
          {
            className: 'com.example.Helper',
            methodName: 'privateMethod',
            fileName: 'Helper.java',
            lineNumber: 42,
          },
          ...(withEntry
            ? [
                {
                  className: entry.className,
                  methodName: entry.methodName,
                  fileName: 'Controller.java',
                  lineNumber: 9,
                },
              ]
            : []),
          { className: 'org.example.HttpWorker', methodName: 'run' },
        ],
      },
    },
  ];
}

test('deep capture follows one invocation through recursion, ignores concurrent threads, and uses paired monotonic clocks', () => {
  const capture = new DeepCapture(entry, 1000);
  assert.equal(capture.marker(marker(8, 'AtExit', '1')), false);
  capture.marker(marker(7, 'AtEnter', '1000000000'));
  capture.marker(marker(8, 'AtEnter', '1001000000'));
  capture.marker(marker(7, 'AtEnter', '1002000000'));
  capture.marker(marker(8, 'AtExit', '2000000000'));
  capture.marker(marker(7, 'AtExit', '2001000000'));
  assert.equal(capture.profile.phase, 'running');
  for (let index = 0; index < 250; index++) capture.sample(sample(), '2002000000');
  capture.sample(sample(8), '2002000000');
  capture.sample(sample(7, false), '2002000000');
  capture.sample(sample(), '602000000000');
  capture.marker(marker(7, 'AtExceptionExit', '601000000000'));
  assert.equal(capture.profile.phase, 'complete');
  assert.equal(capture.profile.durationMs, 600000);
  assert.equal(capture.profile.exceptional, true);
  assert.equal(capture.profile.samples, 250);
  assert.equal(capture.profile.skipped, 3);
  assert.equal(capture.profile.paths.length, 1);
  assert.equal(capture.profile.paths[0].hits, 250);
  assert.equal(capture.profile.paths[0].frames.at(-1)?.className, entry.className);
  assert.ok(capture.profile.paths[0].frames.some((f) => f.lineNumber === 42));
  capture.partial('cleanup failed');
  assert.equal(
    capture.profile.phase,
    'complete',
    'cleanup cannot erase confirmed invocation evidence',
  );
});

test('partial/unsampled calls and malformed markers never become invented root causes', () => {
  const capture = new DeepCapture(entry, 1000);
  assert.throws(
    () => capture.marker({ ...marker(7, 'AtEnter', '0'), value: '@Object[secret]' }),
    /有效/,
  );
  capture.marker(marker(7, 'AtEnter', '-2000000'));
  capture.partial('connection lost');
  assert.equal(capture.profile.phase, 'partial');
  assert.equal(capture.profile.samples, 0);
  assert.equal(capture.profile.durationMs, undefined);
  assert.equal(capture.profile.reason, 'connection lost');
  const fast = new DeepCapture(entry, 1000);
  fast.marker(marker(7, 'AtEnter', '0'));
  fast.marker(marker(7, 'AtExit', '1000000'));
  assert.equal(fast.profile.durationMs, 1);
  assert.equal(fast.profile.samples, 0);
});

test('deep evidence distinguishes monitor locks, pool waits and database socket reads from CPU claims', () => {
  const path: DeepPath = {
    id: 'p',
    hits: 1,
    state: 'BLOCKED',
    frames: [],
    lockOwnerId: 99,
    lockOwnerName: 'holder',
  };
  assert.match(deepEvidence(path).detail, /99/);
  path.state = 'WAITING';
  assert.equal(deepEvidence(path).label, '线程等待');
  path.frames = [{ className: 'com.zaxxer.hikari.pool.HikariPool', methodName: 'getConnection' }];
  assert.equal(deepEvidence(path).label, '连接池等待线索');
  path.state = 'RUNNABLE';
  path.frames = [
    { className: 'java.net.SocketInputStream', methodName: 'socketRead0' },
    { className: 'com.mysql.cj.protocol.a.NativeProtocol', methodName: 'readMessage' },
  ];
  assert.equal(deepEvidence(path).label, '数据库网络等待线索');
  assert.match(deepEvidence(path).detail, /不能/);
  path.frames = [{ className: 'com.example.Calculate', methodName: 'compute' }];
  assert.equal(deepEvidence(path).label, '运行中采样');
  assert.match(deepEvidence(path).detail, /不能直接等同于CPU/);
  const command = deepWatchCommand(entry);
  assert.match(command, /-b -f/);
  assert.match(command, /TLDDEEP/);
  assert.ok(!command.includes('params') && !command.includes('returnObj'));
  assert.match(command, /exclude-class-pattern/);
});

test('deep conclusions merge source-line variants, omit overlapping parents and tie conditional advice to evidence', () => {
  const frames = [
    { className: 'java.net.SocketInputStream', methodName: 'socketRead0' },
    { className: 'com.mysql.cj.protocol.a.NativeProtocol', methodName: 'readMessage' },
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
    { className: 'com.example.controller.OrderController', methodName: 'export' },
  ];
  const profile: DeepProfile = {
    entryClass: 'com.example.controller.OrderController',
    entryMethod: 'export',
    intervalMs: 1000,
    phase: 'complete',
    samples: 5,
    skipped: 0,
    paths: [
      { id: 'a', hits: 2, state: 'RUNNABLE', frames },
      {
        id: 'b',
        hits: 3,
        state: 'RUNNABLE',
        frames: frames.map((f) =>
          f.className === 'com.example.OrderMapper' ? { ...f, lineNumber: 80 } : f,
        ),
      },
    ],
  };
  const conclusions = deepConclusions(profile);
  assert.equal(conclusions.length, 1, 'one actionable method rather than every parent frame');
  assert.equal(conclusions[0].method, 'com.example.OrderMapper#selectGoods');
  assert.equal(conclusions[0].callers[0].methodName, 'fillGoodsList');
  assert.equal(conclusions[0].hits, 5);
  assert.deepEqual(
    conclusions[0].locations.map((f) => f.lineNumber),
    [77, 80],
  );
  assert.match(conclusions[0].finding, /数据库驱动/);
  assert.ok(conclusions[0].suggestions.some((s) => s.includes('执行计划')));
  assert.ok(conclusions[0].suggestions.some((s) => s.startsWith('若') && s.includes('批量查询')));
  assert.deepEqual(deepConclusions({ ...profile, samples: 0, paths: [] }), []);
  const unrelated = {
    ...profile,
    paths: [{ id: 'none', hits: 1, state: 'RUNNABLE', frames: [frames[0]] }],
  };
  assert.deepEqual(deepConclusions(unrelated), [], 'do not invent a source location');
  const compute = deepConclusions({
    ...profile,
    paths: [{ id: 'compute', hits: 5, state: 'RUNNABLE', frames: [frames[2]] }],
  });
  assert.ok(compute[0].suggestions.some((s) => s.includes('结合 CPU 指标')));
  assert.ok(
    !compute[0].suggestions.some((s) => s.includes('索引')),
    'SQL advice requires matching evidence',
  );
});
