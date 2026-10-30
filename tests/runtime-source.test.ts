import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectRuntimeSource } from '../src/main/analysis/runtime-source';
import { AnalysisController } from '../src/main/analysis/analysis-controller';
import { AnalysisSettingsStore } from '../src/main/analysis/settings-store';
import { ContextRegistry } from '../src/main/workspaces/context-registry';
import { emptyAnalysisSettings } from '../src/shared/analysis';
import { analysisChannels } from '../src/shared/channels';
import type { ArthasService } from '../src/main/arthas/arthas-service';
import { sourceTask, createModelFixture } from './helpers/analysis-fixture';
import { passwordEncryption } from './helpers/password-encryption';

function runtimeFixture() {
  const task = sourceTask();
  task.method = {
    className: task.deep!.entryClass,
    methodName: task.deep!.entryMethod,
    classLoaderHash: 'abc123',
    descriptor: '(Ljava/lang/String;)Ljava/lang/String;',
    parameters: ['java.lang.String'],
    returnType: 'java.lang.String',
  };
  const calls: string[] = [];
  const state = { ambiguous: false, disconnected: false, active: false };
  const sources: Record<string, string> = {
    'com.example.CatalogService':
      'package com.example; public class CatalogService { public String query(String input) { return input; } }',
    'com.example.OrderAssembler':
      'package com.example; public class OrderAssembler { public String doAssemble(String s) { return fillGoodsList(s); } private String fillGoodsList(String s) { return s; } }',
    'com.example.OrderMapper':
      'package com.example; public interface OrderMapper { String selectGoods(String input); }',
  };
  const service = {
    listTasks: (owner: number) =>
      owner === 1 ? [{ ...task, status: state.active ? 'results' : 'ended' }] : [],
    getAgent: (owner: number) => {
      if (owner !== 1 || state.disconnected) throw new Error('Arthas连接已失效');
      return {};
    },
    search: async (_owner: number, _id: string, query: string) => {
      const [className, methodName] = query.split('#');
      calls.push(`sm:${query}`);
      return [
        {
          ...task.method,
          className,
          methodName,
          classLoaderHash: className.endsWith('CatalogService') ? 'abc123' : 'def456',
        },
        ...(state.ambiguous && className.endsWith('OrderAssembler')
          ? [{ ...task.method, className, methodName, classLoaderHash: '987abc' }]
          : []),
      ];
    },
    decompile: async (_owner: number, _id: string, className: string, loader: string) => {
      calls.push(`jad:${className}:${loader}`);
      return sources[className];
    },
  } as unknown as ArthasService;
  return { service, task, calls, state };
}

test('runtime source uses each method real loader, decompiles one class once and marks reconstructed source accurately', async () => {
  const fixture = runtimeFixture();
  const bundle = await collectRuntimeSource(fixture.service, 1, fixture.task);
  assert.equal(bundle.origin, 'arthas');
  assert.equal(fixture.calls.filter((call) => call.startsWith('jad:')).length, 3);
  assert.ok(
    fixture.calls.includes('jad:com.example.OrderAssembler:def456'),
    'never copy entry loader to a supporting class',
  );
  assert.ok(
    bundle.pieces.some(
      (piece) => piece.method.endsWith('#fillGoodsList') && piece.text.includes('return s'),
    ),
  );
  assert.ok(
    bundle.pieces.every(
      (piece) =>
        piece.origin === 'arthas' && piece.match === 'runtime' && piece.kind === 'decompiled',
    ),
  );
  assert.ok(bundle.notes.some((note) => note.includes('Mapper XML')));
  assert.ok(bundle.notes.some((note) => note.includes('不是原始Java源码行号')));
});

test('ambiguous loaders are not guessed; running tasks, disconnected JVMs and cancellation stop runtime reads', async () => {
  const fixture = runtimeFixture();
  fixture.state.ambiguous = true;
  const bundle = await collectRuntimeSource(fixture.service, 1, fixture.task);
  assert.ok(!bundle.pieces.some((piece) => piece.method.includes('OrderAssembler')));
  assert.ok(bundle.notes.some((note) => note.includes('唯一的真实ClassLoader')));
  fixture.state.active = true;
  await assert.rejects(collectRuntimeSource(fixture.service, 1, fixture.task), /诊断运行/);
  fixture.state.active = false;
  fixture.state.disconnected = true;
  await assert.rejects(collectRuntimeSource(fixture.service, 1, fixture.task), /Arthas连接/);
  fixture.state.disconnected = false;
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(collectRuntimeSource(fixture.service, 1, fixture.task, abort.signal));
});

test('runtime source preview works without AI, caches the original task across disconnect, and tests a disabled AI connection without source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tld-runtime-source-'));
  const fixture = runtimeFixture();
  const model = await createModelFixture();
  const registry = new ContextRegistry();
  registry.register(1, { kind: 'workspace', projectId: 'alpha' });
  registry.register(2, { kind: 'workspace', projectId: 'other' });
  const store = new AnalysisSettingsStore(join(root, 'settings.json'), passwordEncryption());
  const controller = new AnalysisController(
    registry,
    fixture.service,
    store,
    async () => undefined,
    () => {},
  );
  const handlers = new Map<string, (owner: number, input?: unknown) => any>();
  controller.register((name, handler) => handlers.set(name, handler));
  const call = (name: string, input?: unknown, owner = 1) =>
    Promise.resolve().then(() => handlers.get(name)!(owner, input));
  try {
    const first = await call(analysisChannels.context, fixture.task.id);
    const count = fixture.calls.length;
    first.pieces.length = 0;
    fixture.state.disconnected = true;
    const cached = await call(analysisChannels.context, fixture.task.id);
    assert.ok(cached.pieces.length > 0);
    assert.equal(fixture.calls.length, count);
    await assert.rejects(call(analysisChannels.context, fixture.task.id, 2), /不属于/);
    await call(analysisChannels.save, {
      settings: { ...emptyAnalysisSettings(), baseUrl: model.baseUrl, model: 'fixture-model' },
    });
    await call(analysisChannels.test);
    assert.equal(model.state.requests.length, 1);
    assert.equal(model.state.requests[0].body.messages.length, 1);
    assert.equal((await call(analysisChannels.configuration)).enabled, false);
    await assert.rejects(call(analysisChannels.run, fixture.task.id), /未启用/);
    controller.disposeOwner(1);
    await assert.rejects(call(analysisChannels.context, fixture.task.id), /Arthas连接/);
  } finally {
    controller.disposeOwner(1);
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
