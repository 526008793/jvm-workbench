import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';
import executablePath from 'electron';
import { tsImport } from 'tsx/esm/api';
const { createSshFixture } = await tsImport('../tests/helpers/ssh-fixture.ts', import.meta.url);
const fixture = await createSshFixture({ mfaAfterPassword: true, interruptDelayMs: 1800 });
const profile = await mkdtemp(join(tmpdir(), 'tld-ui-multi-logs-'));
const output = resolve('output/playwright');
await mkdir(output, { recursive: true });
const env = { ...process.env, TRACELOGDOCK_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
const errors = [];
async function selectTarget() {
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '确认已进入目标服务器', exact: true }).click();
}
async function waitTasks(order, goods) {
  await page.waitForFunction(
    ({ order, goods }) =>
      window.tracelogdock
        .listLogTasks()
        .then(
          (r) =>
            r.ok &&
            r.value.some((t) => t.serviceId === 'order' && t.status === order) &&
            r.value.some((t) => t.serviceId === 'goods' && t.status === goods),
        ),
    { order, goods },
  );
}
try {
  app = await _electron.launch({
    executablePath: process.env.TRACELOGDOCK_SMOKE_EXECUTABLE ?? executablePath,
    // Keep this log UI test isolated from the user's macOS keychain.
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
  await manager.evaluate(async (port) => {
    const c = await window.tracelogdock.createProject({
      name: 'Parallel logs',
      description: 'Independent target PTYs',
      environmentName: 'Staging',
    });
    if (!c.ok) throw new Error(c.error);
    const p = c.value;
    p.environments[0].servers = ['order', 'goods'].map((id) => ({
      id: id + '-node',
      name: id === 'order' ? 'Order node' : 'Goods node',
      kind: 'jumpserver',
      host: '127.0.0.1',
      port,
      username: 'operator',
      assetName: id,
    }));
    p.environments[0].services = ['order', 'goods'].map((id) => ({
      id,
      name: 'mall-' + id,
      instances: [{ id: id + '-instance', serverId: id + '-node', containerName: 'mall-' + id }],
    }));
    p.environments.push({ id: 'production', name: 'Production', servers: [], services: [] });
    const saved = await window.tracelogdock.saveProject(p);
    if (!saved.ok) throw new Error(saved.error);
  }, fixture.port);
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开 Parallel logs 工作区', exact: true }).click();
  page = await opened;
  await page.getByRole('heading', { name: '服务器配置', exact: true }).waitFor();
  await page.getByRole('button', { name: '连接 Order node', exact: true }).click();
  await page.getByLabel('SSH密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '建立连接', exact: true }).click();
  await page.getByRole('button', { name: '信任并连接', exact: true }).click();
  await page.getByLabel('OTP Code:', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '提交认证', exact: true }).click();
  await page.waitForFunction(() =>
    window.tracelogdock
      .listConnections()
      .then((r) => r.ok && r.value.some((c) => c.serverId === 'order-node' && c.terminalReady)),
  );
  await selectTarget();
  await page.getByRole('button', { name: '复用登录 Goods node', exact: true }).click();
  await page.waitForFunction(() =>
    window.tracelogdock
      .listConnections()
      .then((r) => r.ok && r.value.some((c) => c.serverId === 'goods-node' && c.terminalReady)),
  );
  await selectTarget();
  await page
    .locator('.workspace-nav')
    .getByRole('button', { name: /服务日志/ })
    .click();
  await page.getByRole('button', { name: '开始日志', exact: true }).click();
  await page.locator('.live-log-row code').filter({ hasText: 'fixture-pty-live-log' }).waitFor();
  await page.getByRole('button', { name: /^mall-goods\s+1$/ }).click();
  const orderStillRunning = await page.evaluate(() => window.tracelogdock.listLogTasks());
  assert.equal(orderStillRunning.value.find((t) => t.serviceId === 'order').status, 'running');
  assert.equal(await page.locator('.live-log-row').count(), 0);
  fixture.emitLog('order-background-retained');
  await page.getByRole('button', { name: '开始日志', exact: true }).click();
  await waitTasks('running', 'running');
  await page.getByLabel('合并查看本环境服务日志', { exact: true }).check();
  await page
    .locator('.live-log-row')
    .filter({ hasText: 'mall-order' })
    .filter({ hasText: 'order-background-retained' })
    .waitFor();
  fixture.emitLog('both-services-live');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.live-log-row code')].filter((e) =>
        e.textContent.includes('both-services-live'),
      ).length === 2,
  );
  assert.equal(
    await page
      .locator('.live-log-row')
      .filter({ hasText: 'mall-order' })
      .filter({ hasText: 'both-services-live' })
      .count(),
    1,
  );
  assert.equal(
    await page
      .locator('.live-log-row')
      .filter({ hasText: 'mall-goods' })
      .filter({ hasText: 'both-services-live' })
      .count(),
    1,
  );
  await page.getByLabel('筛选日志').fill('mall-order');
  assert.equal(await page.locator('.live-log-row').filter({ hasText: 'mall-goods' }).count(), 0);
  await page.getByLabel('筛选日志').fill('');
  await page.screenshot({ path: join(output, 'multi-service-logs.png') });
  await page
    .locator('.log-task-list > div')
    .filter({ hasText: 'mall-order' })
    .getByRole('button', { name: '停止此实例', exact: true })
    .click();
  await waitTasks('stopped', 'running');
  fixture.emitLog('goods-keeps-running');
  await page
    .locator('.live-log-row')
    .filter({ hasText: 'mall-goods' })
    .filter({ hasText: 'goods-keeps-running' })
    .waitFor();
  await page.getByRole('button', { name: /^mall-order\s+1$/ }).click();
  await waitTasks('stopped', 'running');
  await page.getByLabel('合并查看本环境服务日志', { exact: true }).uncheck();
  await page.getByRole('button', { name: '清空显示', exact: true }).click();
  await page.getByLabel('合并查看本环境服务日志', { exact: true }).check();
  assert.equal(await page.locator('.live-log-row').filter({ hasText: 'mall-order' }).count(), 0);
  assert.ok((await page.locator('.live-log-row').filter({ hasText: 'mall-goods' }).count()) > 0);
  await page.getByRole('button', { name: '停止全部服务日志', exact: true }).click();
  await waitTasks('stopped', 'stopped');
  const confirmedTargets = await page.evaluate(() => window.tracelogdock.listConnections());
  assert.ok(confirmedTargets.value.every((connection) => connection.status === 'ready'));
  await page.getByRole('button', { name: /^mall-order\s+1$/ }).click();
  await page.getByRole('button', { name: '开始日志', exact: true }).click();
  await waitTasks('running', 'stopped');
  await page.getByRole('button', { name: /^mall-goods\s+1$/ }).click();
  await page.getByRole('button', { name: '开始日志', exact: true }).click();
  await waitTasks('running', 'running');
  await page.getByRole('button', { name: '停止全部服务日志', exact: true }).click();
  await waitTasks('stopped', 'stopped');
  const repeatedStop = await page.evaluate(() => window.tracelogdock.listConnections());
  assert.ok(repeatedStop.value.every((connection) => connection.status === 'ready'));
  await page.getByRole('button', { name: /^mall-goods\s+1$/ }).click();
  await page.getByRole('button', { name: '开始日志', exact: true }).click();
  await waitTasks('stopped', 'running');
  await page.getByLabel('当前环境', { exact: true }).selectOption('production');
  await page.waitForFunction(() =>
    window.tracelogdock
      .listLogTasks()
      .then(
        (r) =>
          r.ok && r.value.every((t) => ['stopped', 'ended', 'error', 'unknown'].includes(t.status)),
      ),
  );
  assert.deepEqual(errors, []);
  console.log(
    'Multi-service Electron smoke passed: one gateway login, independent target PTYs, switch without stop, background row retention, merged sources, filtering, scoped stop/clear and environment cleanup.',
  );
} catch (error) {
  await page
    ?.screenshot({ path: join(output, 'multi-service-failure.png'), fullPage: true })
    .catch(() => undefined);
  throw error;
} finally {
  await app?.close().catch(() => undefined);
  await fixture.close();
  await rm(profile, { recursive: true, force: true });
}
