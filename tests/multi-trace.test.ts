import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnosticCommand,
  multiTracePatterns,
  traceScopeSchema,
  type MethodCandidate,
} from '../src/shared/arthas';
const method: MethodCandidate = {
  className: 'com.example.Controller',
  methodName: 'export',
  classLoaderHash: 'abc123',
  parameters: [],
  returnType: 'void',
  descriptor: '()V',
  modifier: 'public',
};
const input = {
  agentId: 'agent',
  method,
  kind: 'trace-multi' as const,
  cost: 200,
  count: 1,
  duration: 300,
  scope: [
    method,
    { ...method, className: 'com.example.Assembler$Inner', methodName: 'fill$items' },
  ],
};
// Quoted Arthas regex arguments preserve their backslashes.
const regex = (argument: string) => new RegExp(argument.slice(1, -1));

test('multi-method trace escapes Java names literally and excludes engine-added subclasses', () => {
  const patterns = multiTracePatterns(
    input.scope.map((m) => m.className),
    input.scope.map((m) => m.methodName),
  );
  assert.ok(regex(patterns.classes).test('com.example.Controller'));
  assert.ok(regex(patterns.classes).test('com.example.Assembler$Inner'));
  assert.ok(!regex(patterns.classes).test('comXexampleXController'));
  assert.ok(regex(patterns.methods).test('fill$items'));
  assert.ok(!regex(patterns.methods).test('fillXitems'));
  assert.ok(!regex(patterns.excluded).test('com.example.Controller'));
  assert.ok(regex(patterns.excluded).test('com.example.Controller$$SpringCGLIB$$0'));
  const command = diagnosticCommand(input);
  assert.ok(command.startsWith('trace -E '));
  assert.match(command, /--exclude-class-pattern/);
  assert.ok(
    !command.includes('#cost'),
    'nested trace condition timers must not filter out a complete call',
  );
  assert.ok(command.endsWith('-n 1 -c abc123'));
});

test('multi-method scope requires actual candidates under one loader and rejects regex/command input', () => {
  assert.throws(() => diagnosticCommand({ ...input, scope: [] }), /范围/);
  assert.throws(() => diagnosticCommand({ ...input, scope: [input.scope[1]] }), /入口方法/);
  assert.throws(
    () => diagnosticCommand({ ...input, scope: [{ ...method, classLoaderHash: 'def' }] }),
    /同一ClassLoader/,
  );
  assert.throws(() => multiTracePatterns(['com.example.*'], ['export']));
  assert.throws(() => multiTracePatterns(['com.example.Controller'], ['export|stop']));
  assert.throws(() => multiTracePatterns(['com.example.Controller;stop'], ['export']));
  assert.throws(() =>
    traceScopeSchema.parse({
      agentId: 'agent',
      classLoaderHash: 'abc;stop',
      classes: [method.className],
      methods: ['export'],
    }),
  );
  const list = multiTracePatterns([method.className], ['*']);
  assert.ok(regex(list.methods).test('privateHelper'));
  assert.equal(
    diagnosticCommand({ ...input, kind: 'trace', scope: undefined }),
    "trace com.example.Controller export '#cost > 200' -n 1 -c abc123",
  );
});
