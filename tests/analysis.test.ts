import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AnalysisSettingsStore } from '../src/main/analysis/settings-store';
import { collectSourceContext, verifySourceContext } from '../src/main/analysis/source-context';
import { analyzeSource, modelEndpoint } from '../src/main/analysis/model-client';
import { AnalysisController } from '../src/main/analysis/analysis-controller';
import { ContextRegistry } from '../src/main/workspaces/context-registry';
import { emptyAnalysisSettings, type AnalysisState } from '../src/shared/analysis';
import { analysisChannels } from '../src/shared/channels';
import { deepConclusions } from '../src/shared/deep';
import { passwordEncryption } from './helpers/password-encryption';
import { createModelFixture, sourceTask, writeSourceFixture } from './helpers/analysis-fixture';
import type { ArthasService } from '../src/main/arthas/arthas-service';

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('analysis fixture timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('analysis configuration encrypts credentials, isolates projects and never moves a saved key to a changed endpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tld-analysis-key-'));
  try {
    const file = join(root, 'settings.json');
    const encryption = passwordEncryption();
    const store = new AnalysisSettingsStore(file, encryption);
    assert.equal((await store.configuration('alpha')).enabled, false);
    const settings = {
      ...emptyAnalysisSettings(),
      enabled: true,
      baseUrl: 'https://example.invalid/v1',
      model: 'fixture-model',
    };
    await store.save('alpha', { settings, apiKey: 'fixture-model-secret' });
    assert.ok(!(await readFile(file, 'utf8')).includes('fixture-model-secret'));
    assert.equal((await store.configuration('alpha')).keySaved, true);
    assert.ok(!JSON.stringify(await store.configuration('alpha')).includes('ciphertext'));
    assert.equal((await store.configuration('beta')).keySaved, false);
    const restarted = new AnalysisSettingsStore(file, encryption);
    assert.equal((await restarted.credentials('alpha')).apiKey, 'fixture-model-secret');
    await assert.rejects(
      store.save('alpha', { settings: { ...settings, baseUrl: 'https://other.invalid/v1' } }),
      /重新填写密钥/,
    );
    await store.save('alpha', {
      settings: { ...settings, baseUrl: 'https://other.invalid/v1' },
      clearKey: true,
    });
    assert.equal((await store.credentials('alpha')).apiKey, '');
    await store.remove('alpha');
    assert.equal((await store.configuration('alpha')).enabled, false);
    await writeFile(file, '{broken');
    await assert.rejects(store.save('alpha', { settings }), /已有配置未被覆盖/);
    assert.equal(await readFile(file, 'utf8'), '{broken');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source context reads actual methods and direct Mapper SQL/includes, ignores configuration and rejects changed/ambiguous source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tld-analysis-source-'));
  try {
    await writeSourceFixture(root);
    const task = sourceTask();
    const bundle = await collectSourceContext(root, task);
    assert.ok(
      bundle.pieces.some(
        (piece) =>
          piece.method === 'com.example.OrderAssembler#fillGoodsList' &&
          piece.text.includes('orderMapper.selectGoods(input)'),
      ),
    );
    assert.ok(
      bundle.pieces.some(
        (piece) => piece.method === 'com.example.OrderMapper#selectGoods' && piece.kind === 'sql',
      ),
    );
    assert.ok(bundle.pieces.some((piece) => piece.method === 'com.example.OrderMapper#columns'));
    assert.ok(
      bundle.pieces.every(
        (piece) => piece.kind === 'sql' || !piece.text.includes('public class CatalogService'),
      ),
    );
    assert.ok(!JSON.stringify(bundle).includes('NEVER_SEND_CONFIGURATION'));
    await verifySourceContext(root, bundle);
    const changed = join(root, 'module/src/main/java/com/example/CatalogService.java');
    await writeFile(changed, (await readFile(changed, 'utf8')) + '\n// modified\n');
    await assert.rejects(verifySourceContext(root, bundle), /源码已修改/);
    const duplicate = join(root, 'another/src/main/java/com/example');
    await mkdir(duplicate, { recursive: true });
    await writeFile(join(duplicate, 'CatalogService.java'), await readFile(changed, 'utf8'));
    const ambiguous = await collectSourceContext(root, task);
    assert.ok(ambiguous.notes.some((note) => note.includes('匹配多个模块')));
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(collectSourceContext(root, task, abort.signal));
    if (process.platform !== 'win32') {
      await symlink('/etc', join(root, 'external'));
      const safe = await collectSourceContext(root, task);
      assert.ok(safe.pieces.every((piece) => !piece.path.includes('external')));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model calls use configured protocol and real cited source, reject hallucinated citations and redact provider errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tld-analysis-model-'));
  const fixture = await createModelFixture();
  try {
    await writeSourceFixture(root);
    const task = sourceTask();
    const bundle = await collectSourceContext(root, task);
    const settings = {
      ...emptyAnalysisSettings(),
      enabled: true,
      sourceRoot: root,
      baseUrl: fixture.baseUrl,
      model: 'configured-model',
    };
    const report = await analyzeSource(
      settings,
      'fixture-secret',
      task.deep!,
      bundle,
      AbortSignal.timeout(5000),
    );
    assert.equal(report.model, 'configured-model');
    assert.ok(report.sources.length > 0);
    assert.equal(fixture.state.requests[0].headers.authorization, 'Bearer fixture-secret');
    const prompt = JSON.parse(fixture.state.requests[0].body.messages[1].content);
    assert.ok(
      prompt.sources.some((source: any) => source.text.includes('orderMapper.selectGoods')),
    );
    assert.ok(!JSON.stringify(prompt).includes('fixture-secret'));
    assert.ok(!JSON.stringify(prompt).includes('NEVER_SEND_CONFIGURATION'));
    assert.equal(
      modelEndpoint(fixture.baseUrl + '/chat/completions'),
      fixture.baseUrl + '/chat/completions',
    );
    assert.equal(modelEndpoint('http://localhost:8080/'), 'http://localhost:8080/chat/completions');
    assert.equal(
      modelEndpoint(fixture.baseUrl + '/chat/completions/'),
      fixture.baseUrl + '/chat/completions',
    );
    fixture.state.mode = 'invalid-reference';
    await assert.rejects(
      analyzeSource(settings, '', task.deep!, bundle, AbortSignal.timeout(5000)),
      /未提供的源码/,
    );
    fixture.state.mode = 'invalid-json';
    await assert.rejects(
      analyzeSource(settings, '', task.deep!, bundle, AbortSignal.timeout(5000)),
      /格式/,
    );
    fixture.state.mode = 'error';
    await assert.rejects(
      analyzeSource(settings, '', task.deep!, bundle, AbortSignal.timeout(5000)),
      (error) => {
        assert.match(String(error), /HTTP 401/);
        assert.ok(!String(error).includes('MODEL_MUST_NOT_ECHO_KEY'));
        return true;
      },
    );
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('source method extraction respects overload line ranges, comments, strings and Java text blocks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tld-analysis-overload-'));
  try {
    const directory = join(root, 'src/main/java/com/example');
    await mkdir(directory, { recursive: true });
    const text = `package com.example;
public class Overloads {
  public String work(String input) { return "string overload"; }
  // work() { fake declaration }
  public String work(int input) {
    String sql = """
      SELECT '{ fake() { } }'
      """;
    if (input > 0) { return sql; }
    return "done";
  }
}`;
    await writeFile(join(directory, 'Overloads.java'), text);
    const task = sourceTask();
    task.deep!.entryClass = 'com.example.Overloads';
    task.deep!.entryMethod = 'work';
    task.deep!.paths[0].frames = [
      { className: 'com.example.Overloads', methodName: 'work', lineNumber: 9 },
    ];
    const bundle = await collectSourceContext(root, task);
    assert.equal(bundle.pieces.length, 1);
    assert.ok(bundle.pieces[0].text.includes('work(int input)'));
    assert.ok(bundle.pieces[0].text.includes('return "done"'));
    assert.ok(!bundle.pieces[0].text.includes('string overload'));
    assert.equal(bundle.pieces[0].match, 'line');
    task.deep!.paths[0].frames[0].lineNumber = 999;
    const mismatch = await collectSourceContext(root, task);
    assert.equal(mismatch.pieces.length, 2);
    assert.ok(mismatch.notes.some((note) => note.includes('运行时行号')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('analysis IPC preserves local advice without AI and scopes model work, cancellation and disposal to the task owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tld-analysis-controller-'));
  const fixture = await createModelFixture();
  const registry = new ContextRegistry();
  registry.register(1, { kind: 'workspace', projectId: 'alpha' });
  registry.register(2, { kind: 'workspace', projectId: 'beta' });
  registry.register(3, { kind: 'manager' });
  const task = sourceTask();
  const states: AnalysisState[] = [];
  const settings = new AnalysisSettingsStore(join(root, 'settings.json'), passwordEncryption());
  const controller = new AnalysisController(
    registry,
    {
      listTasks: (owner: number) => (owner === 1 ? [structuredClone(task)] : []),
    } as unknown as ArthasService,
    settings,
    async () => root,
    (_owner, state) => states.push(state),
  );
  const handlers = new Map<string, (owner: number, input?: unknown) => any>();
  controller.register((name, handler) => handlers.set(name, handler));
  const call = (name: string, owner = 1, input?: unknown) =>
    Promise.resolve().then(() => handlers.get(name)!(owner, input));
  try {
    await writeSourceFixture(root);
    assert.ok(deepConclusions(task.deep!).length > 0);
    await assert.rejects(call(analysisChannels.run, 1, task.id), /未启用/);
    assert.equal(fixture.state.requests.length, 0, 'no model traffic without AI');
    await assert.rejects(call(analysisChannels.configuration, 3), /项目工作区/);
    await assert.rejects(call(analysisChannels.run, 2, task.id), /不属于/);
    await call(analysisChannels.save, 1, {
      settings: {
        ...emptyAnalysisSettings(),
        enabled: true,
        sourceMode: 'local',
        sourceRoot: root,
        baseUrl: fixture.baseUrl,
        model: 'fixture-model',
      },
    });
    await call(analysisChannels.test);
    await Promise.all([
      call(analysisChannels.run, 1, task.id),
      call(analysisChannels.run, 1, task.id),
    ]);
    await until(() => states.at(-1)?.status === 'done');
    assert.equal(
      fixture.state.requests.length,
      2,
      'one test connection and one deduplicated source analysis',
    );
    assert.ok((await call(analysisChannels.state, 1, task.id)).report.sources.length > 0);
    fixture.state.mode = 'hold';
    const before = fixture.state.requests.length;
    await call(analysisChannels.run, 1, task.id);
    await until(() => fixture.state.requests.length > before);
    await call(analysisChannels.run, 1, task.id);
    assert.equal(
      fixture.state.requests.length,
      before + 1,
      'repeated clicks do not send duplicate requests',
    );
    await call(analysisChannels.cancel, 1, task.id);
    assert.equal((await call(analysisChannels.state, 1, task.id)).status, 'cancelled');
    fixture.state.release?.();
    const beforeChanged = fixture.state.requests.length;
    await call(analysisChannels.run, 1, task.id);
    await until(() => fixture.state.requests.length > beforeChanged);
    const source = join(root, 'module/src/main/java/com/example/OrderAssembler.java');
    await writeFile(
      source,
      (await readFile(source, 'utf8')) + '\n// changed while model was running\n',
    );
    fixture.state.release?.();
    await until(() => states.at(-1)?.status === 'error');
    assert.match(states.at(-1)!.error!, /源码已修改/);
    assert.equal(states.at(-1)!.report, undefined);
    const beforeDisposed = fixture.state.requests.length;
    await call(analysisChannels.run, 1, task.id);
    await until(() => fixture.state.requests.length > beforeDisposed);
    const eventCount = states.length;
    controller.disposeOwner(1);
    fixture.state.release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(states.length, eventCount, 'disposed owners receive no completion/error results');
    fixture.state.mode = 'normal';
    await call(analysisChannels.save, 1, {
      settings: { ...emptyAnalysisSettings(), sourceRoot: root },
    });
    assert.ok(deepConclusions(task.deep!).length > 0, 'disabling AI retains local suggestions');
    await assert.rejects(call(analysisChannels.run, 1, task.id), /未启用/);
    controller.disposeOwner(1);
    assert.equal((await call(analysisChannels.state, 1, task.id)).status, 'idle');
  } finally {
    controller.disposeOwner(1);
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
