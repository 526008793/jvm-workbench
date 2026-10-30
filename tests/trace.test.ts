import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  traceSamples,
  traceDuration,
  traceMethodTarget,
  canEnhanceMethod,
} from '../src/shared/trace';
import type { MethodCandidate } from '../src/shared/arthas';

const method = (fields: Record<string, unknown>) => ({ type: 'method', ...fields });
test('trace ranks total nanosecond costs, preserves call-site lines, and does not sum nested proxy durations', () => {
  const samples = traceSamples([
    { type: 'enhancer', effect: { cost: 397 } },
    {
      type: 'trace',
      root: {
        type: 'thread',
        classloader: 'ThreadContextLoader@wrong',
        threadName: 'worker',
        timestamp: 'sample-time',
        children: [
          method({
            className: 'com.example.Service$$SpringCGLIB$$0',
            methodName: 'export',
            invoking: false,
            totalCost: 43398800380,
            children: [
              method({
                className: 'org.springframework.cglib.proxy.MethodInterceptor',
                methodName: 'intercept',
                invoking: true,
                totalCost: 43398729486,
                children: [
                  method({
                    className: 'com.example.Service',
                    methodName: 'export',
                    invoking: false,
                    totalCost: 43398139751,
                    children: [
                      method({
                        className: 'com.example.VO',
                        methodName: 'getGoodsList',
                        invoking: true,
                        lineNumber: 317,
                        cost: 990,
                        totalCost: 15620720,
                        maxCost: 186547,
                        times: 10171,
                      }),
                      method({
                        className: 'com.example.Assembler',
                        methodName: 'assembleForExport',
                        invoking: true,
                        lineNumber: 304,
                        cost: 42478227061,
                        totalCost: 42478227061,
                        times: 1,
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      },
    },
  ]);
  assert.equal(samples.length, 1);
  const sample = samples[0];
  assert.equal(traceDuration(sample.totalMs), '43.399 秒');
  assert.equal(sample.calls.length, 2);
  assert.equal(sample.calls[0].className, 'com.example.Assembler');
  assert.equal(traceDuration(sample.calls[0].totalMs), '42.478 秒');
  assert.equal(sample.calls[0].percent.toFixed(1), '97.9');
  assert.equal(sample.calls[0].lineNumber, 304);
  assert.equal(sample.calls[0].caller, 'com.example.Service#export');
  assert.equal(sample.calls[1].times, 10171);
  assert.equal(traceDuration(sample.calls[1].totalMs), '15.621 毫秒');
  assert.ok(sample.calls[1].averageMs < 0.002);
  assert.ok(
    !('classLoaderHash' in sample.calls[0]),
    'a thread context loader cannot identify the child class loader',
  );
});

test('multiple trace invocations stay separate and malformed/other results retain a safe empty view', () => {
  assert.deepEqual(traceSamples([{ type: 'trace' }, { type: 'watch', root: {} }]), []);
  const samples = traceSamples([
    {
      type: 'trace',
      root: {
        type: 'thread',
        children: [
          null,
          method({
            className: 'com.example.Service',
            methodName: 'run',
            totalCost: Number.NaN,
            cost: 1000000,
          }),
        ],
      },
    },
    { type: 'trace', root: { type: 'thread', children: [] } },
  ]);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].totalMs, 1);
  assert.equal(samples[1].totalMs, 0);
});

test('next targets strip the Spring proxy suffix and exclude constructors and invalid command input', () => {
  assert.deepEqual(
    traceMethodTarget({ className: 'com.example.Service$$SpringCGLIB$$0', methodName: 'run' }),
    { className: 'com.example.Service', methodName: 'run' },
  );
  assert.equal(
    traceMethodTarget({ className: 'com.example.Service', methodName: '<init>' }),
    undefined,
  );
  assert.equal(
    traceMethodTarget({ className: 'com.example.Service;stop', methodName: 'run' }),
    undefined,
  );
  const candidate: MethodCandidate = {
    className: 'com.example.Service',
    methodName: 'run',
    classLoaderHash: 'abc',
    descriptor: '()V',
    parameters: [],
    returnType: 'void',
  };
  assert.equal(canEnhanceMethod(candidate), true);
  assert.equal(canEnhanceMethod({ ...candidate, modifier: 'public abstract' }), false);
  assert.equal(canEnhanceMethod({ ...candidate, modifier: 'public native' }), false);
});
