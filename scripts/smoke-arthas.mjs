import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';
import executablePath from 'electron';
import { tsImport } from 'tsx/esm/api';
const { createSshFixture } = await tsImport('../tests/helpers/ssh-fixture.ts', import.meta.url);
const { createArthasResponder } = await tsImport(
  '../tests/helpers/arthas-fixture.ts',
  import.meta.url,
);
const { createModelFixture, writeSourceFixture } = await tsImport(
  '../tests/helpers/analysis-fixture.ts',
  import.meta.url,
);
const modelFixture = await createModelFixture();
const responder = createArthasResponder();
responder.state.finish = false;
responder.state.packagePresent = false;
const assemblerMethod = {
  declaringClass: 'com.example.OrderAssembler',
  methodName: 'assembleForExport',
  classLoaderHash: 'def456',
  parameters: ['java.util.List'],
  returnType: 'void',
  descriptor: '(Ljava/util/List;)V',
  modifier: 'public',
};
responder.state.methodResults['sm -d com.example.OrderAssembler assembleForExport'] = [
  assemblerMethod,
];
const fixture = await createSshFixture({ commandOutput: responder.output });
const profile = await mkdtemp(join(tmpdir(), 'tld-ui-arthas-'));
const sourceRoot = join(profile, 'source');
await writeSourceFixture(sourceRoot);
for (const className of ['CatalogService', 'OrderAssembler', 'OrderMapper'])
  responder.state.jadSources['com.example.' + className] = await readFile(
    join(sourceRoot, 'module/src/main/java/com/example/' + className + '.java'),
    'utf8',
  );
const output = resolve('output/playwright');
await mkdir(output, { recursive: true });
const env = { ...process.env, TRACELOGDOCK_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
const errors = [];
try {
  app = await _electron.launch({
    executablePath: process.env.TRACELOGDOCK_SMOKE_EXECUTABLE ?? executablePath,
    // Isolate fixture credentials from the user's macOS keychain and its access prompts.
    args: [
      ...(process.env.TRACELOGDOCK_SMOKE_EXECUTABLE ? [] : ['.']),
      ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    ],
    cwd: process.cwd(),
    env,
  });
  app.on('window', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  const manager = await app.firstWindow();
  await manager.getByRole('heading', { name: '每个项目，都在自己的工作区。' }).waitFor();
  await manager.evaluate(
    async ({ port }) => {
      for (const name of ['Arthas Alpha', 'Arthas Beta']) {
        const created = await window.tracelogdock.createProject({
          name,
          description: 'Isolated Arthas protocol fixture',
          environmentName: 'Staging',
        });
        if (!created.ok) throw new Error(created.error);
        const p = created.value;
        p.environments[0].servers = [
          {
            id: 'server',
            name: 'Fixture SSH',
            kind: 'ssh',
            host: '127.0.0.1',
            port,
            username: 'operator',
            assetName: '',
          },
        ];
        p.environments[0].services = [
          {
            id: 'service',
            name: 'Catalog',
            instances: [{ id: 'instance', serverId: 'server', containerName: 'catalog-a' }],
          },
        ];
        const saved = await window.tracelogdock.saveProject(p);
        if (!saved.ok) throw new Error(saved.error);
      }
    },
    { port: fixture.port },
  );
  async function open(name) {
    await manager.evaluate(() => window.tracelogdock.openManager());
    const pending = app.waitForEvent('window');
    await manager.getByRole('button', { name: `打开 ${name} 工作区`, exact: true }).click();
    const p = await pending;
    await p.getByRole('heading', { name: '服务器配置', exact: true }).waitFor();
    return p;
  }
  page = await open('Arthas Alpha');
  await page.setViewportSize({ width: 1320, height: 900 });
  const methodTab = () => page.getByRole('button', { name: '2 · 方法诊断', exact: true }).click();
  const connectionTab = () =>
    page.getByRole('button', { name: '1 · 接入 JVM', exact: true }).click();
  const resultTab = () => page.getByRole('button', { name: /^3 · 诊断结果/ }).click();
  const aiPage = () =>
    page.locator('.workspace-nav').getByRole('button', { name: 'AI 配置', exact: true }).click();
  const diagnosticPage = async () => {
    await page
      .locator('.workspace-nav')
      .getByRole('button', { name: /方法诊断/ })
      .click();
    await resultTab();
  };

  await page.getByRole('button', { name: '连接 Fixture SSH', exact: true }).click();
  await page.getByLabel('SSH密码').fill('fixture-password');
  await page.getByRole('button', { name: '建立连接', exact: true }).click();
  await page.getByRole('button', { name: '信任并连接', exact: true }).click();
  await page.waitForFunction(() =>
    window.tracelogdock
      .listConnections()
      .then((r) => r.ok && r.value.some((c) => c.status === 'ready')),
  );
  await page.getByRole('button', { name: /方法诊断/ }).click();
  await page.getByRole('button', { name: '发现 JVM', exact: true }).click();
  await page.getByLabel('Java进程', { exact: true }).selectOption('7');
  await page.getByRole('button', { name: '接入 Arthas', exact: true }).click();
  await page.getByLabel('搜索方法', { exact: true }).waitFor();
  assert.equal(responder.state.installs, 1);
  await connectionTab();
  await page.getByRole('button', { name: '重新核对接入', exact: true }).click();
  await page.getByLabel('搜索方法', { exact: true }).waitFor();
  assert.equal(responder.state.installs, 1);
  await page.getByLabel('业务包名', { exact: true }).fill('com.example');
  await page.getByLabel('搜索方法', { exact: true }).fill('query');
  await page.getByRole('button', { name: '搜索已加载方法', exact: true }).click();
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: '慢调用', exact: true }).click();
  await page.getByLabel('采集次数', { exact: true }).fill('5');
  const expected = "trace com.example.CatalogService query '#cost > 200' -n 5 -c abc123";
  await page.getByText(expected, { exact: true }).waitFor();
  await page.getByRole('button', { name: '复制命令', exact: true }).click();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), expected);
  await page.getByRole('button', { name: '执行诊断', exact: true }).click();
  await page.getByText('增强完成，等待调用', { exact: true }).waitFor();
  const beta = await open('Arthas Beta');
  const foreign = await page.evaluate(() => window.tracelogdock.listDiagnosticTasks());
  const denied = await beta.evaluate(
    (id) => window.tracelogdock.stopDiagnostic(id),
    foreign.value[0].id,
  );
  assert.equal(denied.ok, false);
  assert.match(denied.error, /不属于/);
  await page.getByRole('button', { name: '停止此诊断', exact: true }).click();
  await page.getByText('已停止', { exact: true }).waitFor();
  responder.state.finish = true;
  await methodTab();
  await page.getByRole('button', { name: '执行诊断', exact: true }).click();
  await page.getByText('已结束', { exact: true }).waitFor();
  const completed = page.locator('.diagnostic-task').first();
  const rows = completed.locator('.trace-table tbody tr');
  await rows.first().getByText('42.478 秒', { exact: true }).waitFor();
  assert.match(await rows.first().textContent(), /OrderAssembler/);
  assert.match(await rows.first().textContent(), /97.9%/);
  assert.match(await rows.first().textContent(), /第 304 行/);
  assert.equal(
    await rows
      .filter({ hasText: 'getGoodsList' })
      .getByText('15.621 毫秒', { exact: true })
      .count(),
    1,
  );
  assert.equal(await completed.locator('.diagnostic-raw').evaluate((el) => el.open), false);
  await completed.locator('.diagnostic-raw > summary').click();
  await completed.getByText(/slow query 你好/).waitFor();
  await completed.locator('.diagnostic-raw > summary').click();
  await completed.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'arthas-diagnostics.png') });
  const executionsBefore = responder.state.requests.filter((r) => r.action === 'async_exec').length;
  // Change the selection away from the source PID; drilldown must return to the original task's JVM.
  await connectionTab();
  await page.getByLabel('Java进程', { exact: true }).selectOption('42');
  await resultTab();
  await rows.first().getByRole('button', { name: '继续诊断', exact: true }).click();
  const nextCommand =
    "trace com.example.OrderAssembler assembleForExport '#cost > 200' -n 5 -c def456";
  await page.locator('.command-preview code').filter({ hasText: nextCommand }).waitFor();
  assert.equal(await page.getByLabel('Java进程', { exact: true }).inputValue(), '7');
  assert.equal(
    await page.getByLabel('搜索方法', { exact: true }).inputValue(),
    'com.example.OrderAssembler#assembleForExport',
  );
  assert.equal(await page.getByLabel('业务包名', { exact: true }).inputValue(), 'com.example');
  assert.equal(
    responder.state.requests.filter((r) => r.action === 'async_exec').length,
    executionsBefore,
    'drilldown prepares parameters without executing instrumentation',
  );
  await page.waitForFunction(() => {
    const y = document
      .querySelector('.diagnostic-config input[placeholder*=queryCatalog]')
      .getBoundingClientRect().y;
    return (
      y > document.querySelector('.workspace-content').getBoundingClientRect().top + 20 &&
      y < window.innerHeight
    );
  });
  const inputBounds = await page.getByLabel('搜索方法', { exact: true }).boundingBox();
  assert.ok(
    inputBounds.y >= 0 && inputBounds.y < page.viewportSize().height,
    'parameter input must be scrolled into view',
  );
  await page.screenshot({ path: join(output, 'arthas-next-step.png') });
  await page.getByRole('button', { name: '执行诊断', exact: true }).click();
  await page.waitForFunction(() =>
    window.tracelogdock
      .listDiagnosticTasks()
      .then((r) => r.ok && r.value.length === 3 && r.value[2].status === 'ended'),
  );
  assert.match(
    await page.locator('.diagnostic-task').first().locator('.diagnostic-command').textContent(),
    /OrderAssembler/,
  );
  assert.equal(
    await page
      .locator('.diagnostic-task')
      .nth(1)
      .locator(':scope > details')
      .evaluate((el) => el.open),
    false,
    'old tasks collapse when a new task appears',
  );
  // Abstract/interface methods need an explicit concrete implementation choice.
  responder.state.methodResults['sm -d com.example.OrderMapper selectAll'] = [
    {
      ...assemblerMethod,
      declaringClass: 'com.example.OrderMapper',
      methodName: 'selectAll',
      modifier: 'public abstract',
    },
  ];
  responder.state.methodResults['sm -d com.example.* selectAll'] = [
    {
      ...assemblerMethod,
      declaringClass: 'com.example.OrderMapper',
      methodName: 'selectAll',
      modifier: 'public abstract',
    },
    {
      ...assemblerMethod,
      declaringClass: 'com.example.impl.OrderMapperA',
      methodName: 'selectAll',
      classLoaderHash: 'c0ffee',
    },
    {
      ...assemblerMethod,
      declaringClass: 'com.example.impl.OrderMapperB',
      methodName: 'selectAll',
      classLoaderHash: 'babe',
    },
  ];
  const currentTask = page.locator('.diagnostic-task').first();
  await resultTab();
  await currentTask
    .locator('.trace-table tbody tr')
    .filter({ hasText: 'OrderMapper' })
    .getByRole('button', { name: '继续诊断', exact: true })
    .click();
  await page.getByRole('radio').nth(2).waitFor();
  assert.equal(await page.getByRole('radio').first().isDisabled(), true);
  assert.equal(await page.locator('input[type=radio]:checked').count(), 0);
  assert.equal(
    await page.getByRole('button', { name: '执行诊断', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('radio').nth(1).check();
  await page
    .locator('.command-preview code')
    .filter({ hasText: 'com.example.impl.OrderMapperA selectAll' })
    .waitFor();
  // Multiple real loaders are ambiguous; never silently reuse the caller/thread loader.
  responder.state.methodResults['sm -d com.example.OrderAssembler assembleForExport'] = [
    assemblerMethod,
    { ...assemblerMethod, classLoaderHash: 'babe' },
  ];
  await resultTab();
  await currentTask
    .locator('.trace-table tbody tr')
    .first()
    .getByRole('button', { name: '继续诊断', exact: true })
    .click();
  await page.getByRole('radio').nth(1).waitFor();
  await page.waitForFunction(
    () =>
      !document
        .querySelector('.diagnostic-panel button:disabled')
        ?.textContent?.includes('搜索已加载方法'),
  );
  assert.equal(await page.locator('input[type=radio]:checked').count(), 0);
  assert.equal(
    await page.getByRole('button', { name: '执行诊断', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: '调用统计', exact: true }).click();
  await page
    .getByText('monitor -c 5 com.example.OrderAssembler assembleForExport --classloader def456', {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.locator('body').evaluate((el) => el.scrollWidth > window.innerWidth),
    false,
  );
  // One task can contain multiple classes/private methods and every matching overload.
  responder.state.scopeResults = [
    assemblerMethod,
    ...['doAssemble', 'fillGoodsList', 'fillPackages', 'fillPlatformOrderType'].map(
      (methodName) => ({ ...assemblerMethod, methodName, modifier: 'private' }),
    ),
    {
      ...assemblerMethod,
      declaringClass: 'com.example.CatalogService',
      methodName: 'query',
      parameters: ['java.lang.String'],
      descriptor: '(Ljava/lang/String;)Ljava/lang/String;',
    },
    {
      ...assemblerMethod,
      declaringClass: 'com.example.CatalogService',
      methodName: 'query',
      parameters: [],
      descriptor: '()Ljava/lang/String;',
    },
    { ...assemblerMethod, methodName: '<init>', constructor: true },
  ];
  responder.state.methodResults['sm -d com.example.CatalogService query'] =
    responder.state.scopeResults.filter(
      (method) => method.declaringClass === 'com.example.CatalogService',
    );
  await page.getByLabel('搜索方法', { exact: true }).fill('com.example.CatalogService#query');
  await page.getByRole('button', { name: '搜索已加载方法', exact: true }).click();
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: '多层追踪', exact: true }).click();
  assert.equal(await page.getByLabel('采集次数', { exact: true }).inputValue(), '1');
  assert.equal(await page.getByLabel('最长运行（秒）', { exact: true }).inputValue(), '300');
  assert.equal(
    await page.getByRole('button', { name: '执行诊断', exact: true }).isDisabled(),
    true,
  );
  await page
    .getByLabel('搜索方法', { exact: true })
    .fill('com.example.OrderAssembler#assembleForExport');
  await page.getByRole('button', { name: '搜索已加载方法', exact: true }).click();
  await page.getByRole('radio').first().check();
  assert.match(
    await page.locator('.multi-trace-entry').textContent(),
    /com.example.CatalogService#query/,
  );
  await page.getByRole('button', { name: '加入当前候选', exact: true }).click();
  await page.getByRole('button', { name: '列出当前类方法', exact: true }).click();
  for (const name of ['doAssemble', 'fillGoodsList', 'fillPackages', 'fillPlatformOrderType'])
    await page.getByLabel(`追踪 com.example.OrderAssembler#${name}`, { exact: true }).check();
  await page
    .getByLabel('追踪类', { exact: true })
    .fill('com.example.OrderAssembler\ncom.example.CatalogService');
  const names = await page.getByLabel('追踪方法名', { exact: true }).inputValue();
  await page.getByLabel('追踪方法名', { exact: true }).fill(names + ', query');
  await page.getByRole('button', { name: '核对追踪范围', exact: true }).click();
  await page
    .locator('.multi-trace-preview strong')
    .filter({ hasText: '已核对 2 个类 · 7 个方法' })
    .waitFor();
  const multiPreview = await page.locator('.command-preview code').textContent();
  assert.ok(multiPreview.startsWith('trace -E '));
  assert.ok(!multiPreview.includes('#cost'));
  assert.ok(multiPreview.includes('clazz.name=="com.example.CatalogService"'));
  assert.ok(multiPreview.includes('method.name=="query"'));
  assert.ok(multiPreview.includes('--exclude-class-pattern'));
  assert.ok(multiPreview.endsWith('-n 1 -c def456'));
  const tasksBeforeMulti = await page.evaluate(() => window.tracelogdock.listDiagnosticTasks());
  assert.equal(tasksBeforeMulti.value.length, 3, 'scope inspection never starts a task');
  const sourceAgents = await page.evaluate(() => window.tracelogdock.listArthasAgents());
  const deniedScope = await beta.evaluate((input) => window.tracelogdock.resolveTraceScope(input), {
    agentId: sourceAgents.value[0].id,
    classLoaderHash: 'def456',
    classes: ['com.example.OrderAssembler'],
    methods: ['assembleForExport'],
  });
  assert.equal(deniedScope.ok, false);
  assert.match(deniedScope.error, /不属于/);
  await page.getByLabel('追踪方法名', { exact: true }).fill(names + ', query, changed');
  assert.equal(
    await page.getByRole('button', { name: '执行诊断', exact: true }).isDisabled(),
    true,
    'editing scope invalidates the checked preview',
  );
  await page.getByLabel('追踪方法名', { exact: true }).fill(names + ', query');
  await page.getByRole('button', { name: '核对追踪范围', exact: true }).click();
  await page
    .locator('.multi-trace-preview strong')
    .filter({ hasText: '已核对 2 个类 · 7 个方法' })
    .waitFor();
  responder.state.traceRoot = {
    type: 'thread',
    threadName: 'multi-worker',
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
            className: 'com.example.OrderAssembler',
            methodName: 'assembleForExport',
            invoking: true,
            lineNumber: 304,
            totalCost: 42478227061,
            children: [
              {
                type: 'method',
                className: 'com.example.OrderAssembler',
                methodName: 'assembleForExport',
                invoking: false,
                totalCost: 42478227061,
                children: [
                  {
                    type: 'method',
                    className: 'com.example.OrderAssembler',
                    methodName: 'doAssemble',
                    invoking: true,
                    totalCost: 42478227061,
                    children: [
                      {
                        type: 'method',
                        className: 'com.example.OrderAssembler',
                        methodName: 'doAssemble',
                        invoking: false,
                        totalCost: 42478227061,
                        children: [
                          {
                            type: 'method',
                            className: 'com.example.OrderAssembler',
                            methodName: 'fillGoodsList',
                            invoking: true,
                            lineNumber: 129,
                            totalCost: 14361000000,
                            times: 1,
                          },
                          {
                            type: 'method',
                            className: 'com.example.OrderAssembler',
                            methodName: 'fillPackages',
                            invoking: true,
                            lineNumber: 131,
                            totalCost: 13926000000,
                            times: 1,
                          },
                          {
                            type: 'method',
                            className: 'com.example.OrderAssembler',
                            methodName: 'fillPlatformOrderType',
                            invoking: true,
                            lineNumber: 133,
                            totalCost: 14250000000,
                            times: 1,
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  await page.screenshot({ path: join(output, 'multi-trace-scope.png') });
  await page.getByRole('button', { name: '执行诊断', exact: true }).click();
  await page.waitForFunction(() =>
    window.tracelogdock
      .listDiagnosticTasks()
      .then((r) => r.ok && r.value.length === 4 && r.value[3].status === 'ended'),
  );
  const multiTask = page.locator('.diagnostic-task').first();
  assert.match(await multiTask.locator('summary').first().textContent(), /多层.*7 方法/);
  await multiTask
    .locator('.trace-table tbody tr')
    .filter({ hasText: 'fillGoodsList' })
    .getByText('14.361 秒', { exact: true })
    .waitFor();
  assert.equal(
    await multiTask.locator('.trace-table tbody tr').filter({ hasText: 'fillPackages' }).count(),
    1,
  );
  assert.equal(
    await multiTask
      .locator('.trace-table tbody tr')
      .filter({ hasText: 'fillPlatformOrderType' })
      .count(),
    1,
  );
  await multiTask.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'multi-trace-results.png') });
  const originalConnection = (await page.evaluate(() => window.tracelogdock.listConnections()))
    .value[0].id;
  // Deployments may reuse PID 7: discovery must clear old methods/loader/scope and select the new agent.
  for (const change of [
    { containerId: 'b'.repeat(64) },
    { startedAt: '2026-10-30T02:00:00Z' },
    { startTicks: '123456' },
  ]) {
    await methodTab();
    await page.getByRole('button', { name: '多层追踪', exact: true }).click();
    await connectionTab();
    Object.assign(responder.state, change);
    await page.getByRole('button', { name: '发现 JVM', exact: true }).click();
    await page.getByRole('button', { name: '接入 Arthas', exact: true }).waitFor();
    await methodTab();
    assert.equal(await page.getByRole('radio').count(), 0);
    assert.equal(
      await page.getByRole('button', { name: '搜索已加载方法', exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole('button', { name: '执行诊断', exact: true }).isDisabled(),
      true,
    );
    assert.equal(await page.getByLabel('追踪类', { exact: true }).inputValue(), '');
    const before = (await page.evaluate(() => window.tracelogdock.listArthasAgents())).value;
    assert.deepEqual(before, []);
    await connectionTab();
    await page.getByRole('button', { name: '接入 Arthas', exact: true }).click();
    await page.getByLabel('搜索方法', { exact: true }).waitFor();
    await page.getByRole('button', { name: '慢调用', exact: true }).click();
    await page.getByLabel('搜索方法', { exact: true }).fill('query');
    await page.getByRole('button', { name: '搜索已加载方法', exact: true }).click();
    await page.getByRole('radio').first().check();
    await page
      .locator('.command-preview code')
      .filter({ hasText: 'CatalogService query' })
      .waitFor();
    const current = await page.evaluate(() => window.tracelogdock.listArthasAgents());
    assert.equal(current.value.length, 1);
    assert.equal(current.value[0].jvm.containerId, responder.state.containerId);
    assert.equal(current.value[0].jvm.startedAt, responder.state.startedAt);
    assert.equal(current.value[0].jvm.startTicks, responder.state.startTicks);
    assert.equal(current.value[0].jvm.connectionId, originalConnection);
  }
  await page.screenshot({ path: join(output, 'arthas-after-restart.png') });
  delete responder.state.methodResults['sm -d com.example.CatalogService query'];
  await page.getByRole('button', { name: '深入追踪（单次请求）', exact: true }).click();
  assert.equal(await page.getByLabel('最长运行（秒）', { exact: true }).inputValue(), '600');
  assert.equal(await page.getByLabel('采集次数', { exact: true }).count(), 0);
  assert.match(await page.locator('.command-preview code').textContent(), /深入追踪.*单次请求/);
  assert.equal(await page.getByLabel('追踪类', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '执行诊断', exact: true }).click();
  const deepTask = page.locator('.diagnostic-task').first();
  await deepTask.getByText('正在诊断，完成后显示结论', { exact: true }).waitFor();
  await deepTask.locator('.diagnosis-summary').getByText('诊断结论', { exact: true }).waitFor();
  await deepTask
    .locator('.diagnosis-summary')
    .getByText('总耗时 45.000 秒', { exact: true })
    .waitFor();
  await deepTask
    .locator('.diagnosis-finding h3')
    .filter({ hasText: 'OrderMapper#selectGoods' })
    .waitFor();
  assert.equal(await deepTask.locator('.diagnosis-details').evaluate((el) => el.open), false);
  assert.equal(await deepTask.locator('.deep-hotspots').isVisible(), false);
  assert.equal(await deepTask.locator('.deep-stack').isVisible(), false);
  assert.match(await deepTask.locator('.diagnosis-summary').textContent(), /数据库驱动/);
  assert.match(await deepTask.locator('.diagnosis-summary').textContent(), /批量查询/);
  assert.match(
    await deepTask.locator('.diagnosis-summary').textContent(),
    /OrderAssembler.java:129/,
  );
  assert.match(await deepTask.locator('.diagnosis-summary').textContent(), /初步线索/);
  assert.equal(await deepTask.locator('.diagnostic-raw').evaluate((el) => el.open), false);
  await deepTask.locator('.deep-results').evaluate((el) => {
    const viewport = el.closest('.workspace-content');
    viewport.scrollTop +=
      el.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 18;
  });
  await page.screenshot({ path: join(output, 'deep-diagnosis-results.png') });
  await deepTask.getByText('查看诊断依据', { exact: true }).click();
  await deepTask.getByText('单次请求采集完成', { exact: true }).waitFor();
  assert.equal(await deepTask.locator('.deep-hotspots').isVisible(), true);
  assert.match(await deepTask.locator('.deep-stack').textContent(), /doAssemble/);
  await deepTask.getByText('查看诊断依据', { exact: true }).click();
  assert.equal(modelFixture.state.requests.length, 0, 'local advice must not call a model');
  await deepTask.getByRole('button', { name: '查看运行源码', exact: true }).click();
  await deepTask.locator('.source-preview').waitFor();
  assert.match(await deepTask.locator('.source-preview').textContent(), /Arthas反编译/);
  assert.match(await deepTask.locator('.source-preview').textContent(), /fillGoodsList/);
  const jadCount = responder.state.requests.filter((r) =>
    String(r.command).startsWith('jad '),
  ).length;
  assert.ok(jadCount > 0);
  await deepTask.getByRole('button', { name: '查看运行源码', exact: true }).click();
  assert.equal(
    responder.state.requests.filter((r) => String(r.command).startsWith('jad ')).length,
    jadCount,
    'runtime source is cached per task',
  );
  assert.equal(
    modelFixture.state.requests.length,
    0,
    'viewing Arthas source does not require a model',
  );
  const configurationPanel = page.locator('.analysis-settings');
  const saveAI = async () => {
    await configurationPanel.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
    await configurationPanel
      .getByText('已保存；未启用AI时仍会显示本地建议', { exact: true })
      .waitFor();
  };
  await aiPage();
  await page.getByRole('heading', { name: 'AI 配置', exact: true }).waitFor();
  assert.equal(await page.locator('.diagnostic-tabs').isVisible(), false);
  assert.equal(
    await page.getByRole('button', { name: '发现 JVM', exact: true }).isVisible(),
    false,
  );
  await configurationPanel.getByLabel('分析源码来源', { exact: true }).selectOption('local');
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  }, sourceRoot);
  await configurationPanel.getByRole('button', { name: '选择源码目录', exact: true }).click();
  await page.waitForFunction(
    (root) => document.querySelector('input[aria-label="本地源码目录"]').value === root,
    sourceRoot,
  );
  await configurationPanel.getByLabel('AI API地址', { exact: true }).fill(modelFixture.baseUrl);
  await configurationPanel.getByLabel('AI模型名称', { exact: true }).fill('fixture-model');
  await saveAI();
  await configurationPanel.getByRole('button', { name: '测试连通性', exact: true }).click();
  await configurationPanel.getByText(/模型服务连接成功/).waitFor();
  assert.equal(modelFixture.state.requests.length, 1);
  assert.equal(
    modelFixture.state.requests[0].body.messages.length,
    1,
    'connection test contains no source',
  );
  assert.equal(
    (await page.evaluate(() => window.tracelogdock.analysisConfiguration())).value.enabled,
    false,
    'connection test does not enable AI',
  );
  await configurationPanel.getByLabel('启用 AI 源码分析', { exact: true }).check();
  await saveAI();
  await page.screenshot({ path: join(output, 'ai-settings-page.png') });
  await diagnosticPage();
  assert.equal(
    await configurationPanel.isVisible(),
    false,
    'AI configuration is not mixed into diagnosis',
  );
  assert.match(await deepTask.locator('.diagnosis-summary').textContent(), /OrderMapper/);
  await deepTask.getByRole('button', { name: '查看关联源码', exact: true }).click();
  await deepTask
    .locator('.source-preview details > summary')
    .filter({ hasText: 'OrderMapper.xml' })
    .first()
    .waitFor();
  assert.match(await deepTask.locator('.source-preview').textContent(), /OrderMapper.xml/);
  assert.equal(modelFixture.state.requests.length, 1, 'local preview is not sent to a model');
  await deepTask.getByRole('button', { name: 'AI 源码分析', exact: true }).click();
  await deepTask.locator('.ai-report').waitFor();
  assert.equal(await deepTask.locator('.local-suggestions').evaluate((el) => el.open), false);
  const deepId = (await page.evaluate(() => window.tracelogdock.listDiagnosticTasks())).value.at(
    -1,
  ).id;
  assert.equal(
    (await beta.evaluate((id) => window.tracelogdock.sourceAnalysisState(id), deepId)).ok,
    false,
  );
  assert.equal(
    (await beta.evaluate(() => window.tracelogdock.analysisConfiguration())).value.enabled,
    false,
  );
  const prompt = JSON.parse(modelFixture.state.requests.at(-1).body.messages[1].content);
  assert.ok(prompt.sources.some((source) => source.kind === 'sql'));
  assert.ok(!JSON.stringify(prompt).includes('NEVER_SEND_CONFIGURATION'));
  await deepTask.locator('.source-preview > summary').click();
  await page.screenshot({ path: join(output, 'source-ai-result.png') });
  const beforeDisable = modelFixture.state.requests.length;
  await aiPage();
  await configurationPanel.getByLabel('启用 AI 源码分析', { exact: true }).uncheck();
  await saveAI();
  await diagnosticPage();
  await deepTask.locator('.diagnosis-summary').waitFor({ state: 'visible' });
  assert.equal(await deepTask.locator('.ai-report').count(), 0);
  await aiPage();
  await configurationPanel.getByLabel('启用 AI 源码分析', { exact: true }).check();
  await saveAI();
  await diagnosticPage();
  await deepTask.locator('.ai-report').waitFor();
  assert.equal(
    modelFixture.state.requests.length,
    beforeDisable,
    'toggling AI or pages must not resend source',
  );
  modelFixture.state.mode = 'error';
  await deepTask.getByRole('button', { name: '重新分析源码', exact: true }).click();
  await deepTask.getByText(/模型服务返回HTTP 401/).waitFor();
  assert.equal(await deepTask.locator('.diagnosis-summary').isVisible(), true);
  await aiPage();
  await configurationPanel.getByLabel('启用 AI 源码分析', { exact: true }).uncheck();
  await saveAI();
  await diagnosticPage();
  assert.equal(await deepTask.getByRole('button', { name: 'AI 源码分析', exact: true }).count(), 0);
  assert.equal(await deepTask.locator('.diagnosis-summary').isVisible(), true);
  assert.equal(await deepTask.locator('.task-analysis > .remote-error').count(), 0);
  const beforeAutomatic = modelFixture.state.requests.length;
  modelFixture.state.mode = 'normal';
  await aiPage();
  await configurationPanel.getByLabel('分析源码来源', { exact: true }).selectOption('arthas');
  await configurationPanel.getByLabel('启用 AI 源码分析', { exact: true }).check();
  await configurationPanel
    .getByLabel('新诊断完成后自动发送相关源码并分析', { exact: true })
    .check();
  await saveAI();
  await diagnosticPage();
  assert.equal(
    modelFixture.state.requests.length,
    beforeAutomatic,
    'automatic mode must not replay history',
  );
  await methodTab();
  assert.equal(
    await page.getByLabel('搜索方法', { exact: true }).inputValue(),
    'query',
    'page switches preserve method parameters',
  );
  await page.getByRole('button', { name: '执行诊断', exact: true }).click();
  await page.locator('.diagnostic-task').first().locator('.ai-report').waitFor();
  assert.equal(modelFixture.state.requests.length, beforeAutomatic + 1);
  const runtimePrompt = JSON.parse(modelFixture.state.requests.at(-1).body.messages[1].content);
  assert.ok(
    runtimePrompt.sources.every(
      (source) => source.kind === 'decompiled' && source.origin === 'arthas',
    ),
  );
  await page.screenshot({ path: join(output, 'arthas-runtime-analysis.png') });
  const configured = await page.evaluate(() => window.tracelogdock.analysisConfiguration());
  assert.equal(configured.value.keySaved, false);
  assert.ok(!JSON.stringify(configured).includes('ciphertext'));
  const connections = await page.evaluate(() => window.tracelogdock.listConnections());
  await page.evaluate((id) => window.tracelogdock.disconnect(id), connections.value[0].id);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.trace-table button')].every((button) => button.disabled),
  );
  const finalTask = page.locator('.diagnostic-task').first();
  const cachedJad = responder.state.requests.filter((r) =>
    String(r.command).startsWith('jad '),
  ).length;
  await finalTask.getByRole('button', { name: '查看运行源码', exact: true }).click();
  assert.match(await finalTask.locator('.source-preview').textContent(), /Arthas反编译/);
  assert.equal(
    responder.state.requests.filter((r) => String(r.command).startsWith('jad ')).length,
    cachedJad,
    'cached source remains bound to the old task after disconnect',
  );
  assert.equal(
    responder.state.requests.filter((r) => r.action === 'async_exec').length,
    executionsBefore + 4,
  );
  await page.reload();
  await page.getByRole('heading', { name: '服务器配置', exact: true }).waitFor();
  const cleared = await page.evaluate(async () => ({
    agents: await window.tracelogdock.listArthasAgents(),
    tasks: await window.tracelogdock.listDiagnosticTasks(),
  }));
  assert.deepEqual(cleared.agents.value, []);
  assert.deepEqual(cleared.tasks.value, []);
  assert.deepEqual(errors, []);
  console.log(
    'Arthas Electron smoke passed: discovery, missing-package installation/reuse, attach verification, overload selection, copy, execute/stop/results, parsed trace timing, drilldown/source PID/real loader, explicit interface and loader choices, no automatic execution, history collapse, multi-class/private-method scope resolution, preview invalidation, one multi-layer task and parsed results, same-PID container rebuild/restart and JVM restart recovery without SSH reconnect, single-invocation deep sampling with live hotspots/source lines/database wait evidence and automatic scoped stop, optional model settings, native source chooser fixture, no-model local advice, local-only source preview, source/SQL citations, model failure fallback, opt-in automatic analysis without history replay, cross-window isolation and reload cleanup.',
  );
} catch (error) {
  await page
    ?.screenshot({ path: join(output, 'arthas-failure.png'), fullPage: true })
    .catch(() => undefined);
  throw error;
} finally {
  await app?.close().catch(() => undefined);
  await fixture.close();
  await modelFixture.close();
  await rm(profile, { recursive: true, force: true });
}
