import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';
import executablePath from 'electron';

const root = process.cwd();
const appBinary = process.env.TRACELOGDOCK_SMOKE_EXECUTABLE ?? executablePath;
// Workspace initialization checks secure-storage availability; keep test profiles off the real keychain.
const appArgs = [
  ...(process.env.TRACELOGDOCK_SMOKE_EXECUTABLE ? [] : ['.']),
  ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
];
const profile = await mkdtemp(join(tmpdir(), 'tracelogdock-desktop-'));
const output = resolve(root, 'output/playwright');
await mkdir(output, { recursive: true });
const environment = { ...process.env, TRACELOGDOCK_USER_DATA: profile };
delete environment.ELECTRON_RUN_AS_NODE;
const pageErrors = [];
let application;

async function launch() {
  const instance = await _electron.launch({
    executablePath: appBinary,
    args: appArgs,
    cwd: root,
    env: environment,
  });
  instance.on('window', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
  await instance.firstWindow();
  // macOS may deny foreground focus to an automated app. Verify the native focus requests
  // and deliver focus events explicitly for recency tests, without changing production policy.
  await instance.evaluate(({ BrowserWindow }) => {
    globalThis.smokeFocusRequests = [];
    const focus = BrowserWindow.prototype.focus;
    BrowserWindow.prototype.focus = function (...args) {
      globalThis.smokeFocusRequests.push(this.id);
      return focus.apply(this, args);
    };
  });
  return instance;
}

async function createProject(page, name) {
  await page.getByRole('button', { name: '＋ 新建项目', exact: true }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('项目名称').fill(name);
  await form.getByLabel('项目说明').fill('Desktop smoke fixture');
  await form.getByLabel('初始环境').fill('Staging');
  await form.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor();
}

async function openProject(manager, name) {
  await manager.evaluate(() => window.tracelogdock.openManager());
  const opened = application.waitForEvent('window');
  await manager.getByRole('button', { name: `打开 ${name} 工作区`, exact: true }).click();
  const workspace = await opened;
  await workspace.getByRole('button', { name: '服务器配置', exact: false }).waitFor();
  return workspace;
}

async function dispatchActivation(event = 'activate') {
  await application.evaluate(({ app }, event) => {
    // Native activation handlers are async. A previous focus request must not satisfy this event.
    globalThis.smokeFocusRequests.length = 0;
    app.emit(event);
  }, event);
}

async function waitWindow(title, expected) {
  const deadline = Date.now() + 6000;
  let state;
  do {
    state = await application.evaluate(({ BrowserWindow }, title) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.getTitle() === title);
      return w
        ? {
            visible: w.isVisible(),
            focusRequested: globalThis.smokeFocusRequests.at(-1) === w.id,
            minimized: w.isMinimized(),
          }
        : undefined;
    }, title);
    if (state && Object.entries(expected).every(([key, value]) => state[key] === value)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  console.error(
    'Native window states',
    await application.evaluate(({ app, BrowserWindow }) => ({
      hidden: app.isHidden?.(),
      windows: BrowserWindow.getAllWindows().map((w) => ({
        title: w.getTitle(),
        visible: w.isVisible(),
        focusRequested: globalThis.smokeFocusRequests.at(-1) === w.id,
        minimized: w.isMinimized(),
      })),
    })),
  );
  assert.fail(
    `Window ${title} state ${JSON.stringify(state)} did not match ${JSON.stringify(expected)}`,
  );
}

try {
  application = await launch();
  const manager = await application.firstWindow();
  await manager.getByRole('heading', { name: '每个项目，都在自己的工作区。' }).waitFor();
  const appVersion = await application.evaluate(({ app }) => app.getVersion());
  assert.equal(await manager.locator('.manager-top .version').innerText(), `v${appVersion}`);
  await createProject(manager, 'Project Alpha');
  await createProject(manager, 'Project Beta');
  await manager.screenshot({ path: join(output, 'projects.png') });

  const alpha = await openProject(manager, 'Project Alpha');
  await alpha.getByRole('heading', { name: '服务器配置', exact: true }).waitFor();
  assert.deepEqual(
    await alpha
      .locator('.workspace-nav > button')
      .evaluateAll((buttons) => buttons.map((button) => button.querySelector('span').textContent)),
    ['服务器配置', '服务日志', '方法诊断', 'AI 配置'],
  );
  assert.equal(await alpha.locator('.sidebar .version').innerText(), `v${appVersion}`);
  await waitWindow('TraceLogDock · 项目管理', { visible: false });
  await alpha.locator('.project-switch').click();
  await waitWindow('TraceLogDock · 项目管理', { visible: true, focusRequested: true });
  await manager.getByRole('button', { name: '打开 Project Alpha 工作区', exact: true }).click();
  await waitWindow('TraceLogDock · 项目管理', { visible: false });
  assert.equal(application.windows().length, 2, 'selecting the existing project reuses its window');
  await alpha.getByRole('button', { name: /服务器配置/ }).click();
  await alpha.getByRole('button', { name: '＋ 添加服务器', exact: true }).click();
  let form = alpha.getByRole('dialog');
  await form.getByLabel('服务器名称').fill('Server A');
  await form.getByLabel('服务器地址').fill('app-a.example.invalid');
  await form.getByLabel('登录用户').fill('operator');
  await form.getByRole('button', { name: '保存配置', exact: true }).click();
  await alpha.getByRole('cell', { name: 'Server A', exact: true }).waitFor();
  await alpha.getByRole('button', { name: '＋ 添加服务器', exact: true }).click();
  form = alpha.getByRole('dialog');
  await form.getByLabel('服务器名称').fill('Server B');
  await form.getByLabel('连接方式').selectOption('jumpserver');
  await form.getByLabel('堡垒机地址').fill('bastion.example.invalid');
  await form.getByLabel('登录用户').fill('operator');
  await form.getByLabel('目标资产名称').fill('example-app-b');
  assert.equal(await form.getByLabel('端口').inputValue(), '2222');
  await form.getByRole('button', { name: '保存配置', exact: true }).click();
  await alpha.getByRole('cell', { name: 'Server B', exact: true }).waitFor();
  await alpha.screenshot({ path: join(output, 'server-first-page.png') });

  await alpha.getByRole('button', { name: /服务日志/ }).click();
  await alpha.getByRole('button', { name: '＋ 添加服务', exact: true }).click();
  form = alpha.getByRole('dialog');
  await form.getByLabel('服务名称').fill('catalog-service');
  await form.getByRole('button', { name: '＋ 添加实例', exact: true }).click();
  await form.getByLabel('容器名称').fill('catalog-a');
  await form.getByRole('button', { name: '＋ 添加实例', exact: true }).click();
  await form.getByLabel('所在服务器').nth(1).selectOption({ label: 'Server B' });
  await form.getByLabel('容器名称').nth(1).fill('catalog-b');

  await form.getByRole('button', { name: '保存配置', exact: true }).click();
  await alpha.getByRole('heading', { name: 'catalog-service', exact: true }).waitFor();
  assert.equal(await alpha.locator('.instance-panel').count(), 0);
  assert.equal(await alpha.locator('input[name="log-instance"][type="radio"]').count(), 2);
  assert.equal(await alpha.locator('input[name="log-instance"]:checked').count(), 1);
  assert.equal(await alpha.locator('.remote-connections').isVisible(), false);
  assert.equal(await alpha.locator('.summary-grid').count(), 0);
  assert.equal(await alpha.locator('.command-list').count(), 0);
  assert.equal(await alpha.getByRole('button', { name: '复制命令', exact: true }).count(), 0);
  await alpha.getByRole('button', { name: '编辑服务 catalog-service', exact: true }).click();
  form = alpha.getByRole('dialog');
  assert.equal(
    await form.getByRole('button', { name: '移除服务配置', exact: true }).isVisible(),
    true,
  );
  await form.getByLabel('服务名称').fill('catalog-renamed');
  await form.getByRole('button', { name: '保存配置', exact: true }).click();
  await alpha.getByRole('heading', { name: 'catalog-renamed', exact: true }).waitFor();
  await alpha.getByRole('button', { name: '编辑服务 catalog-renamed', exact: true }).click();
  form = alpha.getByRole('dialog');
  assert.equal(await form.getByLabel('容器名称').first().inputValue(), 'catalog-a');
  await form.getByLabel('服务名称').fill('catalog-service');
  await form.getByRole('button', { name: '保存配置', exact: true }).click();
  await alpha.getByRole('heading', { name: 'catalog-service', exact: true }).waitFor();
  for (const deleteCurrent of [false, true]) {
    await alpha.getByRole('button', { name: '新增服务', exact: true }).click();
    form = alpha.getByRole('dialog');
    await form.getByLabel('服务名称').fill('temporary-service');
    await form.getByRole('button', { name: '保存配置', exact: true }).click();
    await alpha.getByRole('heading', { name: 'temporary-service', exact: true }).waitFor();
    if (!deleteCurrent)
      await alpha.locator('.service-link').filter({ hasText: 'catalog-service' }).click();
    await alpha.getByRole('button', { name: '删除服务 temporary-service', exact: true }).click();
    await alpha
      .getByRole('button', { name: '删除服务 temporary-service', exact: true })
      .waitFor({ state: 'detached' });
    await alpha.getByRole('heading', { name: 'catalog-service', exact: true }).waitFor();
    assert.equal(
      await alpha.getByRole('button', { name: '删除服务 temporary-service', exact: true }).count(),
      0,
    );
  }
  await alpha.screenshot({ path: join(output, 'workspace.png') });
  await alpha.getByRole('button', { name: '＋ 新环境', exact: true }).click();
  form = alpha.getByRole('dialog');
  await form.getByLabel('环境名称').fill('Production');
  await form.getByRole('button', { name: '保存配置', exact: true }).click();
  await alpha.getByLabel('当前环境', { exact: true }).selectOption({ label: 'Production' });
  const isolatedEnvironment = await alpha.evaluate(() => window.tracelogdock.listProjects());
  const production = isolatedEnvironment.value[0].environments.find((e) => e.name === 'Production');
  assert.deepEqual(production.servers, []);
  assert.deepEqual(production.services, []);
  await alpha.getByRole('heading', { name: '服务日志', exact: true }).waitFor();
  await alpha.getByRole('button', { name: '删除当前环境', exact: true }).click();
  await alpha.getByRole('heading', { name: 'catalog-service', exact: true }).waitFor();
  const environmentSelection = await alpha.getByLabel('当前环境', { exact: true }).inputValue();
  const remaining = await alpha.evaluate(() => window.tracelogdock.listProjects());
  assert.equal(environmentSelection, remaining.value[0].environments[0].id);
  await alpha.getByRole('heading', { name: 'catalog-service', exact: true }).waitFor();

  await alpha.getByRole('button', { name: /方法诊断/ }).click();
  await alpha.getByRole('heading', { name: 'Arthas 方法诊断', exact: true }).waitFor();
  assert.equal(
    await alpha.getByRole('button', { name: '接入 Arthas', exact: true }).isDisabled(),
    true,
  );
  await alpha.getByRole('button', { name: '2 · 方法诊断', exact: true }).click();
  assert.equal(
    await alpha.getByRole('button', { name: '执行诊断', exact: true }).isDisabled(),
    true,
  );
  await alpha.screenshot({ path: join(output, 'diagnostics.png') });

  const beta = await openProject(manager, 'Project Beta');
  await beta.getByRole('heading', { name: '服务器配置', exact: true }).waitFor();
  await beta.getByRole('button', { name: '新增服务', exact: true }).click();
  form = beta.getByRole('dialog');
  await form.getByLabel('服务名称').fill('temporary-only');
  await form.getByRole('button', { name: '保存配置', exact: true }).click();
  await beta.locator('.service-link').filter({ hasText: 'temporary-only' }).click();
  await beta.getByRole('heading', { name: 'temporary-only', exact: true }).waitFor();
  await beta.getByRole('button', { name: '删除服务 temporary-only', exact: true }).click();
  await beta.getByRole('heading', { name: '服务日志', exact: true }).waitFor();
  assert.equal(await beta.locator('.service-entry').count(), 0);
  assert.equal(
    await beta.getByRole('button', { name: '开始日志', exact: true }).isDisabled(),
    true,
  );
  await waitWindow('TraceLogDock · 项目管理', { visible: false });
  const all = await manager.evaluate(() => window.tracelogdock.listProjects());
  assert.equal(all.ok, true);
  const betaProject = all.value.find((project) => project.name === 'Project Beta');
  const alphaProject = all.value.find((project) => project.name === 'Project Alpha');
  const scoped = await alpha.evaluate(() => window.tracelogdock.listProjects());
  assert.deepEqual(
    scoped.value.map((project) => project.name),
    ['Project Alpha'],
  );
  const forbidden = await alpha.evaluate(
    (project) => window.tracelogdock.saveProject(project),
    betaProject,
  );
  assert.equal(forbidden.ok, false);
  assert.match(forbidden.error, /其他项目/);
  const deniedCreate = await alpha.evaluate(() =>
    window.tracelogdock.createProject({
      name: 'Forbidden',
      description: '',
      environmentName: 'Staging',
    }),
  );
  assert.equal(deniedCreate.ok, false);

  const windowCount = application.windows().length;
  await alpha.evaluate((id) => window.tracelogdock.openProject(id), alphaProject.id);
  assert.equal(application.windows().length, windowCount);
  await waitWindow('Project Alpha · TraceLogDock', { focusRequested: true });
  await alpha.locator('.project-switch').click();
  await waitWindow('TraceLogDock · 项目管理', { visible: true });
  // Emit the actual Electron event handled for a Dock click; manager must not become the target.
  await dispatchActivation();
  await waitWindow('Project Alpha · TraceLogDock', { focusRequested: true });
  await waitWindow('TraceLogDock · 项目管理', { visible: false });
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() === 'Project Alpha · TraceLogDock')
      .minimize(),
  );
  await waitWindow('Project Alpha · TraceLogDock', { minimized: true });
  // Windows can focus Beta when Alpha is minimized. Establish the intended recent window
  // explicitly before testing restoration, as the other focus-recency scenarios do below.
  await application.evaluate(({ app, BrowserWindow }) => {
    globalThis.smokeFocusRequests.length = 0;
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() === 'Project Alpha · TraceLogDock')
      .emit('focus');
    app.emit('activate');
  });
  await waitWindow('Project Alpha · TraceLogDock', {
    visible: true,
    minimized: false,
    focusRequested: true,
  });
  // Focus, not creation order, decides which existing project is brought back.
  await application.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(
      (w) => w.getTitle() === 'Project Beta · TraceLogDock',
    );
    w.focus();
    w.emit('focus');
  });
  await waitWindow('Project Beta · TraceLogDock', { focusRequested: true });
  await application.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(
      (w) => w.getTitle() === 'Project Alpha · TraceLogDock',
    );
    w.focus();
    w.emit('focus');
  });
  await waitWindow('Project Alpha · TraceLogDock', { focusRequested: true });
  await dispatchActivation('second-instance');
  await waitWindow('Project Alpha · TraceLogDock', { focusRequested: true });
  await waitWindow('TraceLogDock · 项目管理', { visible: false });
  await alpha.close();
  assert.equal(beta.isClosed(), false);
  await dispatchActivation();
  await waitWindow('Project Beta · TraceLogDock', { focusRequested: true });
  const betaContext = await beta.evaluate(() => window.tracelogdock.context());
  assert.equal(betaContext.value.projectId, betaProject.id);
  await beta.close();
  const reopened = application.waitForEvent('window');
  await dispatchActivation();
  const betaAgain = await reopened;
  await betaAgain.getByRole('button', { name: /服务器配置/ }).waitFor();
  assert.equal(
    (await betaAgain.evaluate(() => window.tracelogdock.context())).value.projectId,
    betaProject.id,
  );
  await waitWindow('TraceLogDock · 项目管理', { visible: false });
  await manager.close();
  assert.equal(betaAgain.isClosed(), false);
  await dispatchActivation();
  await waitWindow('Project Beta · TraceLogDock', { focusRequested: true });
  assert.equal(
    application.windows().length,
    1,
    'activation with a workspace does not recreate the manager',
  );
  await application.close();

  application = await launch();
  const restored = await application.firstWindow();
  await restored.getByRole('button', { name: /服务器配置/ }).waitFor();
  const restoredContext = await restored.evaluate(() => window.tracelogdock.context());
  assert.equal(restoredContext.value.kind, 'workspace');
  assert.equal(restoredContext.value.projectId, betaProject.id);
  assert.equal(application.windows().length, 1, 'restart opens only the recent project');
  const pickerOpened = application.waitForEvent('window');
  await restored.locator('.project-switch').click();
  const picker = await pickerOpened;
  await picker.getByRole('heading', { name: 'Project Alpha', exact: true }).waitFor();
  await picker.getByRole('heading', { name: 'Project Beta', exact: true }).waitFor();
  const data = await picker.evaluate(() => window.tracelogdock.listProjects());
  const persisted = data.value.find((project) => project.name === 'Project Alpha');
  assert.equal(persisted.environments[0].servers[0].host, 'app-a.example.invalid');
  assert.equal(persisted.environments[0].servers[1].kind, 'jumpserver');
  assert.equal(persisted.environments[0].services[0].instances.length, 2);
  assert.equal(persisted.environments[0].services[0].instances[0].containerName, 'catalog-a');
  // Deleting a remembered project must not leave startup stuck on a nonexistent workspace.
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  const removedWorkspace = restored.waitForEvent('close');
  await picker.evaluate((id) => window.tracelogdock.deleteProject(id), betaProject.id);
  await removedWorkspace;
  await application.close();
  application = await launch();
  const fallback = await application.firstWindow();
  await fallback.getByRole('heading', { name: '每个项目，都在自己的工作区。' }).waitFor();
  assert.equal(
    (await fallback.evaluate(() => window.tracelogdock.context())).value.kind,
    'manager',
  );
  assert.deepEqual(pageErrors, []);
  console.log(
    'Desktop smoke passed: project creation, server/service mapping, diagnostic prerequisites, multi-window isolation, picker hide/show, recent-focus Dock/second-instance activation, minimized restore, closed-project reopen, recent-project restart, deletion fallback and configuration persistence.',
  );
  console.log(`Screenshots: ${output}`);
} finally {
  await application?.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
}
