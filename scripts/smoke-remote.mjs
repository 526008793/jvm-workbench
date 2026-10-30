import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';
import executablePath from 'electron';
import { tsImport } from 'tsx/esm/api';
const { createSshFixture } = await tsImport('../tests/helpers/ssh-fixture.ts', import.meta.url);
const direct = await createSshFixture();
const jump = await createSshFixture({ mfaAfterPassword: true });
const profile = await mkdtemp(join(tmpdir(), 'tracelogdock-ui-ssh-'));
const output = resolve('output/playwright');
await mkdir(output, { recursive: true });
const env = { ...process.env, TRACELOGDOCK_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [];
let app;
async function createProject(manager, name, servers) {
  return manager.evaluate(
    async ({ name, servers }) => {
      const created = await window.tracelogdock.createProject({
        name,
        description: 'Isolated SSH fixture',
        environmentName: 'Staging',
      });
      if (!created.ok) throw new Error(created.error);
      const project = created.value;
      project.environments[0].servers = servers;
      project.environments[0].services = [
        {
          id: 'catalog',
          name: 'catalog-service',
          instances: servers.map((server) => ({
            id: `instance-${server.id}`,
            serverId: server.id,
            containerName: 'catalog-a',
          })),
        },
      ];
      const saved = await window.tracelogdock.saveProject(project);
      if (!saved.ok) throw new Error(saved.error);
      return saved.value;
    },
    { name, servers },
  );
}
async function open(manager, name) {
  await manager.evaluate(() => window.tracelogdock.openManager());
  const promise = app.waitForEvent('window');
  await manager.getByRole('button', { name: `打开 ${name} 工作区`, exact: true }).click();
  const page = await promise;
  await page.getByRole('heading', { name: '服务器配置', exact: true }).waitFor();
  await page
    .locator('.workspace-nav')
    .getByRole('button', { name: /服务日志/ })
    .click();
  await page.getByRole('heading', { name: 'catalog-service', exact: true }).waitFor();
  return page;
}
async function connect(page, name, mfa, trust) {
  await page
    .locator('.workspace-nav')
    .getByRole('button', { name: /服务器配置/ })
    .click();
  await page.getByRole('button', { name: `连接 ${name}`, exact: true }).click();
  const form = page.getByRole('dialog', { name: `连接 ${name}`, exact: true });
  await form.getByLabel('SSH密码').fill('fixture-password');
  await form.getByRole('button', { name: '建立连接', exact: true }).click();
  if (trust) await page.getByRole('button', { name: '信任并连接', exact: true }).click();
  if (mfa) {
    await page.getByLabel('OTP Code:', { exact: true }).fill('123456');
    await page.getByRole('button', { name: '提交认证', exact: true }).click();
  }
  await page.waitForFunction(
    ({ name, mfa }) =>
      window.tracelogdock
        .listConnections()
        .then(
          (r) =>
            r.ok &&
            r.value.some(
              (c) =>
                c.serverId === name &&
                c.status === (mfa ? 'awaiting-target' : 'ready') &&
                (!mfa || c.terminalReady),
            ),
        ),
    { name: name === 'Direct A' ? 'direct-a' : name === 'Jump B' ? 'jump-b' : 'beta', mfa },
  );
}
try {
  app = await _electron.launch({
    executablePath: process.env.TRACELOGDOCK_SMOKE_EXECUTABLE ?? executablePath,
    // This UI fixture must not access the user's macOS keychain.
    args: [
      ...(process.env.TRACELOGDOCK_SMOKE_EXECUTABLE ? [] : ['.']),
      ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    ],
    cwd: process.cwd(),
    env,
  });
  app.on('window', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const manager = await app.firstWindow();
  await manager.getByRole('heading', { name: '每个项目，都在自己的工作区。' }).waitFor();
  const a = {
    id: 'direct-a',
    name: 'Direct A',
    kind: 'ssh',
    host: '127.0.0.1',
    port: direct.port,
    username: 'operator',
    assetName: '',
  };
  const b = {
    id: 'jump-b',
    name: 'Jump B',
    kind: 'jumpserver',
    host: '127.0.0.1',
    port: jump.port,
    username: 'operator',
    assetName: 'example-app-a',
  };
  await createProject(manager, 'Remote Alpha', [a, b]);
  await createProject(manager, 'Remote Beta', [{ ...a, id: 'beta', name: 'Beta server' }]);
  const alpha = await open(manager, 'Remote Alpha');
  assert.equal(await alpha.locator('.instance-panel').count(), 0);
  const instances = alpha.locator('input[name="log-instance"]');
  assert.equal(await instances.count(), 2);
  assert.equal(await alpha.locator('input[name="log-instance"][type="radio"]').count(), 2);
  assert.equal(await alpha.locator('input[name="log-instance"]:checked').count(), 1);
  await instances.nth(1).check();
  assert.equal(await instances.first().isChecked(), false);
  await instances.first().check();
  await connect(alpha, 'Direct A', false, true);
  // Exercise actual Chromium wheel defaults, including xterm's custom scrollbar boundaries.
  await alpha.setViewportSize({ width: 1320, height: 900 });
  const terminal = alpha.locator('.ssh-terminal');
  await terminal.scrollIntoViewIfNeeded();
  const workspace = alpha.locator('.workspace-content');
  const outerTop = () => workspace.evaluate((el) => el.scrollTop);
  const beforeEmpty = await outerTop();
  await terminal.hover();
  await alpha.mouse.wheel(0, -500);
  await alpha.waitForTimeout(150);
  assert.equal(
    await outerTop(),
    beforeEmpty,
    'terminal without scrollback must not scroll the page',
  );
  await alpha.evaluate(async () => {
    const r = await window.tracelogdock.listConnections();
    if (!r.ok) throw new Error(r.error);
    await window.tracelogdock.terminalInput(
      r.value[0].id,
      Array.from({ length: 220 }, (_, i) => `scroll-line-${String(i).padStart(3, '0')}\r`).join(''),
    );
  });
  await alpha.waitForFunction(() =>
    document.querySelector('.xterm-rows')?.textContent.includes('scroll-line-219'),
  );
  const screen = alpha.locator('.xterm-rows');
  // Check geometry, not just DOM text: clipped terminal rows still exist in the DOM.
  async function assertTerminalBottom() {
    const dimensions = await terminal.evaluate((el) => {
      const mount = el.querySelector('.terminal-mount') ?? el;
      const screen = el.querySelector('.xterm-screen');
      const cursor = el.querySelector('.xterm-cursor');
      const bounds = mount.getBoundingClientRect();
      return {
        bottom: bounds.bottom,
        right: bounds.right,
        screenBottom: screen.getBoundingClientRect().bottom,
        screenRight: screen.getBoundingClientRect().right,
        cursorBottom: cursor?.getBoundingClientRect().bottom,
      };
    });
    assert.ok(
      dimensions.screenBottom <= dimensions.bottom + 1,
      `terminal rows clipped: ${JSON.stringify(dimensions)}`,
    );
    assert.ok(
      dimensions.screenRight <= dimensions.right + 1,
      `terminal columns clipped: ${JSON.stringify(dimensions)}`,
    );
    if (dimensions.cursorBottom)
      assert.ok(
        dimensions.cursorBottom <= dimensions.bottom + 1,
        'last-line cursor must be fully visible',
      );
  }
  await assertTerminalBottom();
  for (const size of [
    { width: 1100, height: 760 },
    { width: 1440, height: 1000 },
    { width: 1320, height: 900 },
  ]) {
    await alpha.setViewportSize(size);
    await alpha.waitForTimeout(150);
    await assertTerminalBottom();
  }
  await terminal.scrollIntoViewIfNeeded();
  await terminal.screenshot({ path: join(output, 'terminal-last-line.png') });
  const bottomText = await screen.textContent();
  const beforeWheel = await outerTop();
  await terminal.hover();
  await alpha.mouse.wheel(0, -400);
  await alpha.waitForFunction(
    (text) => document.querySelector('.xterm-rows')?.textContent !== text,
    bottomText,
  );
  assert.equal(await outerTop(), beforeWheel, 'scrollback should consume wheel internally');
  for (const delta of [-100000, -600, 100000, 600]) {
    await alpha.mouse.wheel(0, delta);
    await alpha.waitForTimeout(150);
    assert.equal(
      await outerTop(),
      beforeWheel,
      `terminal boundary wheel ${delta} must stay inside`,
    );
  }
  const box = await workspace.boundingBox();
  await alpha.mouse.move(box.x + 12, box.y + box.height / 2);
  await alpha.mouse.wheel(0, 350);
  await alpha.waitForFunction(
    (top) => document.querySelector('.workspace-content').scrollTop > top,
    beforeWheel,
  );
  console.log(
    'Terminal smoke passed: last row/cursor bounds across window sizes, empty history, internal scrollback, top/bottom boundaries, outside page scrolling.',
  );
  await alpha.getByRole('button', { name: '发现容器', exact: true }).click();
  await alpha.getByRole('cell', { name: 'fixture/catalog:1', exact: true }).waitFor();
  const discoveries = direct.commands.filter((c) => c.includes('docker ps')).length;
  await alpha.getByRole('button', { name: '关闭容器列表', exact: true }).click();
  assert.equal(await alpha.locator('.discovered-containers').count(), 0);
  await alpha.getByRole('button', { name: '显示容器列表', exact: true }).click();
  await alpha.getByRole('cell', { name: 'fixture/catalog:1', exact: true }).waitFor();
  assert.equal(direct.commands.filter((c) => c.includes('docker ps')).length, discoveries);
  await alpha.getByRole('button', { name: '关闭容器列表', exact: true }).click();
  await connect(alpha, 'Jump B', true, true);
  await alpha.locator('.xterm-helper-textarea').focus();
  await alpha.keyboard.type('1');
  await alpha.keyboard.press('Enter');
  await alpha.getByRole('button', { name: '确认已进入目标服务器', exact: true }).click();
  await alpha.getByText('fixture-target', { exact: true }).waitFor();
  await alpha
    .locator('.workspace-nav')
    .getByRole('button', { name: /服务日志/ })
    .click();
  assert.equal(await alpha.locator('.remote-connections').isVisible(), false);
  assert.equal(await alpha.locator('.summary-grid').count(), 0);
  assert.equal(await alpha.locator('.command-list').count(), 0);
  const waitDirect = (status) =>
    alpha.waitForFunction(
      (status) =>
        window.tracelogdock
          .listLogTasks()
          .then(
            (r) =>
              r.ok &&
              r.value.some((t) => t.instanceId === 'instance-direct-a' && t.status === status),
          ),
      status,
    );
  await alpha.getByLabel('日志范围', { exact: true }).selectOption('since');
  await alpha.getByLabel('最近时间', { exact: true }).selectOption('1h');
  await alpha.getByRole('button', { name: '开始日志', exact: true }).click();
  await waitDirect('running');
  assert.match(
    direct.commands.filter((c) => c.startsWith('docker logs')).at(-1),
    /--follow --since '1h'/,
  );
  await alpha.getByRole('button', { name: '停止日志', exact: true }).click();
  await waitDirect('stopped');
  await alpha.getByLabel('日志范围', { exact: true }).selectOption('range');
  await alpha.getByLabel('开始时间', { exact: true }).fill('2026-10-29T09:00:01');
  await alpha.getByLabel('结束时间（可选）', { exact: true }).fill('2026-10-29T08:00:01');
  const beforeInvalid = direct.commands.length;
  await alpha.getByRole('button', { name: '开始日志', exact: true }).click();
  await alpha.getByRole('status').filter({ hasText: '日志结束时间必须晚于开始时间' }).waitFor();
  assert.equal(
    direct.commands.length,
    beforeInvalid,
    'invalid window must not open a remote channel',
  );
  await alpha.getByLabel('结束时间（可选）', { exact: true }).fill('2026-10-29T09:30:01');
  const times = await alpha.evaluate(() =>
    [...document.querySelectorAll('input[type="datetime-local"]')].map((el) =>
      new Date(el.value).toISOString(),
    ),
  );
  await alpha.getByRole('button', { name: '开始日志', exact: true }).click();
  await waitDirect('ended');
  const historyCommand = direct.commands.filter((c) => c.startsWith('docker logs')).at(-1);
  assert.ok(historyCommand.includes(`--since '${times[0]}' --until '${times[1]}'`));
  assert.ok(!historyCommand.includes('--follow'));
  await alpha
    .getByRole('status')
    .filter({ hasText: '日志结束时间必须晚于开始时间' })
    .waitFor({ state: 'hidden' });
  await alpha.locator('.log-panel').scrollIntoViewIfNeeded();
  await alpha.screenshot({ path: join(output, 'log-time-range.png') });
  await alpha.getByLabel('结束时间（可选）', { exact: true }).fill('');
  await alpha.getByRole('button', { name: '开始日志', exact: true }).click();
  await waitDirect('running');
  assert.match(
    direct.commands.filter((c) => c.startsWith('docker logs')).at(-1),
    /--follow --since/,
  );
  await alpha.getByRole('button', { name: '停止日志', exact: true }).click();
  await waitDirect('stopped');
  await alpha.getByLabel('日志范围', { exact: true }).selectOption('new');
  console.log(
    'Log controls smoke passed: single selection, dismiss/reopen container list, relative time, UTC window, invalid order blocked before SSH, bounded completion and open-end follow.',
  );
  const merge = alpha.getByLabel('合并查看本环境服务日志', { exact: true });
  await merge.check();
  await instances.nth(1).check();
  assert.equal(
    await alpha.locator('input[name="log-instance"][type="checkbox"]:checked').count(),
    2,
  );
  await alpha.getByRole('button', { name: '开始日志', exact: true }).click();
  await alpha.locator('.live-log-row code').filter({ hasText: '你好 fixture-live-log' }).waitFor();
  await alpha.locator('.live-log-row code').filter({ hasText: 'fixture-pty-live-log' }).waitFor();
  await merge.uncheck();
  assert.equal(await alpha.locator('input[name="log-instance"]:checked').count(), 1);
  assert.equal(
    await alpha.locator('.live-log-row code').filter({ hasText: 'fixture-pty-live-log' }).count(),
    0,
  );
  await instances.nth(1).check();
  await alpha.locator('.live-log-row code').filter({ hasText: 'fixture-pty-live-log' }).waitFor();
  assert.equal(
    await alpha.locator('.live-log-row code').filter({ hasText: '你好 fixture-live-log' }).count(),
    0,
  );
  const bothRunning = await alpha.evaluate(() => window.tracelogdock.listLogTasks());
  assert.equal(bothRunning.value.filter((t) => t.status === 'running').length, 2);
  await merge.check();
  await alpha.screenshot({ path: join(output, 'remote-logs.png') });
  await alpha.evaluate(() => {
    window.__smokeRows = [];
    window.tracelogdock.onRemoteEvent((e) => {
      if (e.type === 'logs') window.__smokeRows.push(...e.rows);
    });
  });
  await alpha.getByRole('button', { name: '暂停显示', exact: true }).click();
  direct.emitLog('2026-10-29T01:00:03Z fixture-after-pause');
  await alpha.waitForFunction(() =>
    window.__smokeRows.some((r) => r.text.includes('fixture-after-pause')),
  );
  assert.equal(
    await alpha.locator('.live-log-row code').filter({ hasText: 'fixture-after-pause' }).count(),
    0,
  );
  await alpha.getByRole('button', { name: '继续显示', exact: true }).click();
  await alpha.locator('.live-log-row code').filter({ hasText: 'fixture-after-pause' }).waitFor();
  await alpha.getByLabel('筛选日志').fill('fixture-pty');
  assert.equal(await alpha.locator('.live-log-row code').count(), 1);
  await alpha.getByLabel('筛选日志').fill('');
  const sqlHeader =
    '2026-10-29T15:42:21.704+08:00 INFO 6 --- [mall-business] [nio-8087-exec-1] SQL日志';
  direct.emitLog(`2026-10-29T07:42:21.704000000Z ${sqlHeader}`);
  const sql = alpha.locator('.live-log-row').filter({ hasText: 'SQL日志' });
  await sql.waitFor();
  // Deliver the rest after the first UI update; the same row must grow instead of duplicating.
  direct.emitLog(
    '2026-10-29T07:42:21.704000001Z ================= SQL日志开始 =================\n2026-10-29T07:42:21.704000002Z SQL类型：SELECT\n2026-10-29T07:42:21.704000003Z 执行时间：2ms\n2026-10-29T07:42:21.704000004Z Mapper方法：com.example.ShopBaseMapper.selectList\n2026-10-29T07:42:21.704000005Z 完整SQL：SELECT shop_id FROM shop_base\n2026-10-29T07:42:21.704000006Z =============================================',
  );
  await sql.locator('code').filter({ hasText: '完整SQL' }).waitFor();
  assert.equal(await sql.count(), 1);
  assert.equal(await sql.locator('.log-source').count(), 1);
  const sqlText = await sql.locator('code').textContent();
  assert.ok(sqlText.startsWith(sqlHeader));
  assert.ok(sqlText.includes('SQL类型：SELECT\n执行时间：2ms\nMapper方法：'));
  assert.ok(!sqlText.includes('2026-10-29T07:42:'), 'Docker timestamps belong to metadata');
  await alpha.getByLabel('筛选日志').fill('ShopBaseMapper');
  assert.equal(await alpha.locator('.live-log-row').count(), 1);
  assert.equal(
    await sql.locator('code').textContent(),
    sqlText,
    'filtering retains the whole SQL event',
  );
  await alpha.getByRole('button', { name: '暂停显示', exact: true }).click();
  direct.emitLog('2026-10-29T07:42:21.704000007Z delayed SQL continuation');
  await alpha.waitForFunction(() =>
    window.__smokeRows.some((r) => r.text.includes('delayed SQL continuation')),
  );
  assert.equal(
    await sql.locator('code').textContent(),
    sqlText,
    'pause preserves the earlier snapshot',
  );
  await alpha.getByRole('button', { name: '继续显示', exact: true }).click();
  await sql.locator('code').filter({ hasText: 'delayed SQL continuation' }).waitFor();
  await alpha.getByLabel('筛选日志').fill('');
  direct.emitLog(
    '2026-10-29T07:42:21.704000008Z 2026-10-29T15:42:21.704+08:00 ERROR 6 --- stack-event\n2026-10-29T07:42:21.704000009Z java.lang.IllegalStateException: fixture-failure\n2026-10-29T07:42:21.704000010Z \tat com.example.Service.query(Service.java:7)',
  );
  const stack = alpha.locator('.live-log-row').filter({ hasText: 'stack-event' });
  await stack.locator('code').filter({ hasText: 'Service.java:7' }).waitFor();
  assert.equal(await stack.count(), 1);
  assert.equal(await sql.count(), 1);
  assert.ok(!(await sql.locator('code').textContent()).includes('stack-event'));
  await alpha
    .locator('.live-log-view')
    .screenshot({ path: join(output, 'multiline-log-events.png') });
  console.log(
    'Multiline logs smoke passed: SQL as one event, live append/upsert, whole-event filtering, pause snapshot and separate stack trace.',
  );
  await alpha.getByRole('button', { name: '停止全部服务日志', exact: true }).click();
  await alpha.waitForFunction(() =>
    window.tracelogdock
      .listLogTasks()
      .then((r) => r.ok && r.value.length === 2 && r.value.every((t) => t.status === 'stopped')),
  );
  const alphaConnections = await alpha.evaluate(() => window.tracelogdock.listConnections());
  assert.equal(alphaConnections.value.filter((c) => c.status === 'ready').length, 2);
  await alpha.evaluate(async (server) => {
    const result = await window.tracelogdock.listProjects();
    if (!result.ok) throw new Error(result.error);
    const project = result.value[0];
    project.environments[0].servers.push({
      ...server,
      id: 'jump-c',
      name: 'Jump C',
      assetName: 'another-target',
    });
    const saved = await window.tracelogdock.saveProject(project);
    if (!saved.ok) throw new Error(saved.error);
    window.__reuseChallenges = [];
    window.tracelogdock.onRemoteEvent((event) => {
      if (event.type === 'challenge') window.__reuseChallenges.push(event.challenge);
    });
  }, b);
  await alpha
    .locator('.workspace-nav')
    .getByRole('button', { name: /服务器配置/ })
    .click();
  await alpha.getByRole('button', { name: '复用登录 Jump C', exact: true }).waitFor();
  await alpha.screenshot({ path: join(output, 'remote-reuse-login.png') });
  await alpha.getByRole('button', { name: '复用登录 Jump C', exact: true }).click();
  await alpha.waitForFunction(() =>
    window.tracelogdock
      .listConnections()
      .then((r) => r.ok && r.value.some((c) => c.serverId === 'jump-c' && c.terminalReady)),
  );
  assert.equal(await alpha.getByRole('dialog').count(), 0);
  await alpha.locator('.xterm-helper-textarea').focus();
  await alpha.keyboard.type('1');
  await alpha.keyboard.press('Enter');
  await alpha.getByRole('button', { name: '确认已进入目标服务器', exact: true }).click();
  await alpha.waitForFunction(() =>
    window.tracelogdock
      .listConnections()
      .then((r) => r.ok && r.value.filter((c) => c.status === 'ready').length === 3),
  );
  assert.deepEqual(await alpha.evaluate(() => window.__reuseChallenges), []);
  await alpha.getByRole('button', { name: '断开', exact: true }).click();
  const afterDisconnect = await alpha.evaluate(() => window.tracelogdock.listConnections());
  assert.equal(afterDisconnect.value.find((c) => c.serverId === 'jump-b').status, 'ready');
  const beta = await open(manager, 'Remote Beta');
  await connect(beta, 'Beta server', false, false);
  const deniedTarget = await beta.evaluate(
    (target) => window.tracelogdock.discoverContainers(target),
    {
      projectId: alphaConnections.value[0].projectId,
      environmentId: alphaConnections.value[0].environmentId,
      serverId: alphaConnections.value[0].serverId,
    },
  );
  assert.equal(deniedTarget.ok, false);
  const denied = await beta.evaluate(
    (id) => window.tracelogdock.disconnect(id),
    alphaConnections.value[0].id,
  );
  assert.equal(denied.ok, false);
  await beta
    .locator('.workspace-nav')
    .getByRole('button', { name: /服务日志/ })
    .click();
  await beta.getByRole('button', { name: '开始日志', exact: true }).click();
  await beta.locator('.live-log-row code').filter({ hasText: 'fixture-live-log' }).waitFor();
  await alpha.close();
  const betaConnections = await beta.evaluate(() => window.tracelogdock.listConnections());
  assert.equal(betaConnections.value[0].status, 'ready');
  direct.emitLog('2026-10-29T01:00:04Z beta-still-streaming');
  await beta.locator('.live-log-row code').filter({ hasText: 'beta-still-streaming' }).waitFor();
  await beta.reload();
  await beta.getByRole('heading', { name: '服务器配置', exact: true }).waitFor();
  const reset = await beta.evaluate(() => window.tracelogdock.listConnections());
  assert.equal(reset.value.length, 0);
  const persisted = await readFile(join(profile, 'projects.json'), 'utf8');
  assert.ok(!persisted.includes('fixture-password'));
  assert.ok(!persisted.includes('123456'));
  assert.deepEqual(errors, []);
  console.log(
    'Remote desktop smoke passed: host trust, password, MFA, reused gateway login with independent PTYs, manual target selection, Docker discovery, dual-source live logs, pause/filter/stop, cross-window isolation and reload cleanup.',
  );
} catch (error) {
  for (const page of app?.windows() ?? [])
    await page
      .screenshot({ path: join(output, `remote-failure-${Date.now()}.png`) })
      .catch(() => undefined);
  throw error;
} finally {
  await app?.close().catch(() => undefined);
  await direct.close();
  await jump.close();
  await rm(profile, { recursive: true, force: true });
}
