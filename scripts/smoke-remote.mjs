import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';
import executablePath from 'electron';
import { tsImport } from 'tsx/esm/api';
const { createSshFixture } = await tsImport('../tests/helpers/ssh-fixture.ts', import.meta.url);
const direct = await createSshFixture();
const jump = await createSshFixture({ mfa: true });
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
  const promise = app.waitForEvent('window');
  await manager.getByRole('button', { name: `打开 ${name} 工作区`, exact: true }).click();
  const page = await promise;
  await page.getByRole('heading', { name: 'catalog-service', exact: true }).waitFor();
  return page;
}
async function connect(page, name, mfa, trust) {
  await page.getByRole('button', { name: `连接 ${name}`, exact: true }).click();
  const form = page.getByRole('dialog', { name: `连接 ${name}`, exact: true });
  if (!mfa) await form.getByLabel('SSH密码').fill('fixture-password');
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
    args: process.env.TRACELOGDOCK_SMOKE_EXECUTABLE ? [] : ['.'],
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
  await connect(alpha, 'Direct A', false, true);
  await alpha.getByRole('button', { name: '发现容器', exact: true }).click();
  await alpha.getByRole('cell', { name: 'fixture/catalog:1', exact: true }).waitFor();
  await connect(alpha, 'Jump B', true, true);
  await alpha.locator('.xterm-helper-textarea').focus();
  await alpha.keyboard.type('1');
  await alpha.keyboard.press('Enter');
  await alpha.getByRole('button', { name: '确认已进入目标服务器', exact: true }).click();
  await alpha.getByText('fixture-target', { exact: true }).waitFor();
  await alpha.getByRole('button', { name: '开始日志', exact: true }).click();
  await alpha.locator('.live-log-row code').filter({ hasText: '你好 fixture-live-log' }).waitFor();
  await alpha.locator('.live-log-row code').filter({ hasText: 'fixture-pty-live-log' }).waitFor();
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
  await alpha.getByRole('button', { name: '停止日志', exact: true }).click();
  await alpha.waitForFunction(() =>
    window.tracelogdock
      .listLogTasks()
      .then((r) => r.ok && r.value.length === 2 && r.value.every((t) => t.status === 'stopped')),
  );
  const alphaConnections = await alpha.evaluate(() => window.tracelogdock.listConnections());
  assert.equal(alphaConnections.value.filter((c) => c.status === 'ready').length, 2);
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
  await beta.getByRole('button', { name: '开始日志', exact: true }).click();
  await beta.locator('.live-log-row code').filter({ hasText: 'fixture-live-log' }).waitFor();
  await alpha.close();
  const betaConnections = await beta.evaluate(() => window.tracelogdock.listConnections());
  assert.equal(betaConnections.value[0].status, 'ready');
  direct.emitLog('2026-10-29T01:00:04Z beta-still-streaming');
  await beta.locator('.live-log-row code').filter({ hasText: 'beta-still-streaming' }).waitFor();
  await beta.reload();
  await beta.getByRole('heading', { name: 'catalog-service', exact: true }).waitFor();
  const reset = await beta.evaluate(() => window.tracelogdock.listConnections());
  assert.equal(reset.value.length, 0);
  const persisted = await readFile(join(profile, 'projects.json'), 'utf8');
  assert.ok(!persisted.includes('fixture-password'));
  assert.ok(!persisted.includes('123456'));
  assert.deepEqual(errors, []);
  console.log(
    'Remote desktop smoke passed: host trust, password, MFA, manual target selection, Docker discovery, dual-source live logs, pause/filter/stop, cross-window isolation and reload cleanup.',
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
