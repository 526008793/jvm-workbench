import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';
import executablePath from 'electron';
import { tsImport } from 'tsx/esm/api';
const { createSshFixture } = await tsImport('../tests/helpers/ssh-fixture.ts', import.meta.url);
const fixture = await createSshFixture({ mfaAfterPassword: true });
const profile = await mkdtemp(join(tmpdir(), 'tld-ui-passwords-'));
const output = resolve('output/playwright');
await mkdir(output, { recursive: true });
const env = { ...process.env, TRACELOGDOCK_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
const errors = [];
async function launch() {
  app = await _electron.launch({
    executablePath: process.env.TRACELOGDOCK_SMOKE_EXECUTABLE ?? executablePath,
    args: process.env.TRACELOGDOCK_SMOKE_EXECUTABLE ? [] : ['.'],
    cwd: process.cwd(),
    env,
  });
  app.on('window', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  let manager = await app.firstWindow();
  await manager.waitForFunction(() => Boolean(window.tracelogdock));
  const context = await manager.evaluate(() => window.tracelogdock.context());
  if (context.value.kind === 'workspace') {
    const next = app.waitForEvent('window');
    await manager.evaluate(() => window.tracelogdock.openManager());
    manager = await next;
  }
  await manager.getByRole('heading', { name: '每个项目，都在自己的工作区。' }).waitFor();
  return manager;
}
async function open(manager) {
  const next = app.windows().find((window) => window !== manager) ?? app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开 Password Fixture 工作区', exact: true }).click();
  page = await next;
  await page.getByRole('button', { name: '连接 Gateway', exact: true }).click();
  const form = page.getByRole('dialog', { name: '连接 Gateway', exact: true });
  await form.getByRole('button', { name: '建立连接', exact: true }).waitFor({ state: 'visible' });
  return form;
}
async function mfa(trust) {
  if (trust) await page.getByRole('button', { name: '信任并连接', exact: true }).click();
  await page.getByLabel('OTP Code:', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '提交认证', exact: true }).click();
  await page.waitForFunction(() =>
    window.tracelogdock
      .listConnections()
      .then((r) => r.ok && r.value.some((c) => c.status === 'awaiting-target')),
  );
}
try {
  let manager = await launch();
  await manager.evaluate(async (port) => {
    const c = await window.tracelogdock.createProject({
      name: 'Password Fixture',
      description: 'OS-encrypted fixture only',
      environmentName: 'Staging',
    });
    if (!c.ok) throw new Error(c.error);
    c.value.environments[0].servers = [
      {
        id: 'gateway',
        name: 'Gateway',
        kind: 'jumpserver',
        host: '127.0.0.1',
        port,
        username: 'operator',
        assetName: '',
      },
    ];
    const s = await window.tracelogdock.saveProject(c.value);
    if (!s.ok) throw new Error(s.error);
  }, fixture.port);
  let form = await open(manager);
  await form.getByLabel('SSH密码', { exact: true }).fill('fixture-password');
  await form.getByLabel('在此设备上记住密码', { exact: true }).check();
  await form.getByRole('button', { name: '建立连接', exact: true }).click();
  await mfa(true);
  await page.waitForFunction(async () => {
    const p = await window.tracelogdock.listProjects();
    if (!p.ok) return false;
    const project = p.value[0],
      environment = project.environments[0],
      server = environment.servers[0];
    const s = await window.tracelogdock.passwordStatus({
      projectId: project.id,
      environmentId: environment.id,
      serverId: server.id,
      binding: JSON.stringify([
        server.kind,
        server.host,
        server.port,
        server.username,
        server.assetName,
      ]),
    });
    return s.ok && s.value.remembered;
  });
  const ciphertext = await readFile(join(profile, 'passwords.json'), 'utf8');
  assert.ok(!ciphertext.includes('fixture-password'));
  assert.ok(!ciphertext.includes('123456'));
  assert.ok(!(await readFile(join(profile, 'projects.json'), 'utf8')).includes('fixture-password'));
  await app.close();
  app = undefined;
  manager = await launch();
  form = await open(manager);
  await form.getByRole('button', { name: '忘记密码', exact: true }).waitFor();
  assert.equal(await form.getByLabel('SSH密码', { exact: true }).inputValue(), '');
  assert.equal(await form.getByLabel('在此设备上记住密码', { exact: true }).isChecked(), true);
  await form.screenshot({ path: join(output, 'password-remembered.png') });
  await form.getByRole('button', { name: '建立连接', exact: true }).click();
  await mfa(false);
  const views = await page.evaluate(() => window.tracelogdock.listConnections());
  await page.evaluate((id) => window.tracelogdock.disconnect(id), views.value[0].id);
  await page.getByRole('button', { name: '连接 Gateway', exact: true }).click();
  form = page.getByRole('dialog', { name: '连接 Gateway', exact: true });
  await form.getByRole('button', { name: '忘记密码', exact: true }).click();
  await form.getByRole('button', { name: '忘记密码', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await form.getByLabel('在此设备上记住密码', { exact: true }).isChecked(), false);
  await app.close();
  app = undefined;
  manager = await launch();
  form = await open(manager);
  await form.getByRole('button', { name: '建立连接', exact: true }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('[role="dialog"] button.primary')?.disabled,
  );
  assert.equal(await form.getByRole('button', { name: '忘记密码', exact: true }).count(), 0);
  assert.equal(await form.getByLabel('在此设备上记住密码', { exact: true }).isChecked(), false);
  assert.equal(await form.getByLabel('SSH密码', { exact: true }).inputValue(), '');
  assert.deepEqual(errors, []);
  console.log(
    'Password Electron smoke passed: real OS encryption, successful-auth save, restart with opaque saved password, MFA still required, forget and restart removal.',
  );
} catch (error) {
  await page
    ?.screenshot({ path: join(output, 'password-failure.png'), fullPage: true })
    .catch(() => undefined);
  throw error;
} finally {
  await app?.close().catch(() => undefined);
  await fixture.close();
  await rm(profile, { recursive: true, force: true });
}
