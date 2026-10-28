import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';
import executablePath from 'electron';

const root = process.cwd();
const appBinary = process.env.TRACELOGDOCK_SMOKE_EXECUTABLE ?? executablePath;
const appArgs = process.env.TRACELOGDOCK_SMOKE_EXECUTABLE ? [] : ['.'];
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
  const opened = application.waitForEvent('window');
  await manager.getByRole('button', { name: `打开 ${name} 工作区`, exact: true }).click();
  const workspace = await opened;
  await workspace.getByRole('button', { name: '服务器配置', exact: false }).waitFor();
  return workspace;
}

try {
  application = await launch();
  const manager = await application.firstWindow();
  await manager.getByRole('heading', { name: '每个项目，都在自己的工作区。' }).waitFor();
  await createProject(manager, 'Project Alpha');
  await createProject(manager, 'Project Beta');
  await manager.screenshot({ path: join(output, 'projects.png') });

  const alpha = await openProject(manager, 'Project Alpha');
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
  await alpha
    .getByText("docker logs --follow --tail 0 --timestamps -- 'catalog-a'", { exact: true })
    .waitFor();
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
  await alpha.getByLabel('完整类名').fill('com.example.CatalogService');
  await alpha.getByLabel('方法名', { exact: true }).fill('query');
  await alpha
    .getByText("trace com.example.CatalogService query '#cost > 200' -n 5", { exact: true })
    .waitFor();
  await alpha.getByRole('button', { name: '复制命令', exact: true }).click();
  const copied = await application.evaluate(({ clipboard }) => clipboard.readText());
  assert.equal(copied, "trace com.example.CatalogService query '#cost > 200' -n 5");
  await alpha.screenshot({ path: join(output, 'diagnostics.png') });

  const beta = await openProject(manager, 'Project Beta');
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
  await alpha.close();
  assert.equal(beta.isClosed(), false);
  const betaContext = await beta.evaluate(() => window.tracelogdock.context());
  assert.equal(betaContext.value.projectId, betaProject.id);
  await application.close();

  application = await launch();
  const restored = await application.firstWindow();
  await restored.getByRole('heading', { name: 'Project Alpha', exact: true }).waitFor();
  await restored.getByRole('heading', { name: 'Project Beta', exact: true }).waitFor();
  const data = await restored.evaluate(() => window.tracelogdock.listProjects());
  const persisted = data.value.find((project) => project.name === 'Project Alpha');
  assert.equal(persisted.environments[0].servers[0].host, 'app-a.example.invalid');
  assert.equal(persisted.environments[0].servers[1].kind, 'jumpserver');
  assert.equal(persisted.environments[0].services[0].instances.length, 2);
  assert.equal(persisted.environments[0].services[0].instances[0].containerName, 'catalog-a');
  assert.deepEqual(pageErrors, []);
  console.log(
    'Desktop smoke passed: project creation, server/service mapping, command copy, multi-window isolation, close isolation and restart persistence.',
  );
  console.log(`Screenshots: ${output}`);
} finally {
  await application?.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
}
