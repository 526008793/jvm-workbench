import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } from 'electron';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { channels } from '../shared/channels';
import { type ApiResult, type WindowContext, projectSchema } from '../shared/models';
import { remoteChannels } from '../shared/channels';
import { RemoteController } from './connections/remote-controller';
import { ProjectStore } from './storage/project-store';
import { ContextRegistry } from './workspaces/context-registry';

if (process.env.TRACELOGDOCK_USER_DATA)
  app.setPath('userData', resolve(process.env.TRACELOGDOCK_USER_DATA));
app.setName('TraceLogDock');
const registry = new ContextRegistry();
const workspaces = new Map<string, BrowserWindow>();
let manager: BrowserWindow | undefined;
let store: ProjectStore;
let remote: RemoteController;

function broadcast(): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channels.changed);
}

function createWindow(context: WindowContext, title: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1060,
    minHeight: 700,
    title,
    backgroundColor: '#0d1118',
    show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const senderId = window.webContents.id;
  registry.register(senderId, context);
  window.on('closed', () => {
    remote.disposeOwner(senderId);
    registry.remove(senderId);
  });
  window.webContents.on('render-process-gone', () => remote.disposeOwner(senderId));
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) remote.disposeOwner(senderId);
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, detail) => {
    console.error('[workspace] renderer stopped', { senderId, reason: detail.reason });
  });
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
  return window;
}

function openManager(): void {
  if (manager && !manager.isDestroyed()) {
    manager.show();
    manager.focus();
    return;
  }
  manager = createWindow({ kind: 'manager' }, 'TraceLogDock · 项目管理');
  manager.on('closed', () => {
    manager = undefined;
  });
}

async function openProject(id: string): Promise<void> {
  const project = (await store.list()).find((value) => value.id === id);
  if (!project) throw new Error('项目不存在');
  const existing = workspaces.get(id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }
  const window = createWindow(
    { kind: 'workspace', projectId: id },
    `${project.name} · TraceLogDock`,
  );
  workspaces.set(id, window);
  window.on('closed', () => workspaces.delete(id));
}

function registerHandlers(): void {
  const handle = <T>(
    channel: string,
    action: (senderId: number, input: unknown) => T | Promise<T>,
  ): void => {
    ipcMain.handle(channel, async (event, input): Promise<ApiResult<T>> => {
      try {
        registry.get(event.sender.id);
        if (event.senderFrame !== event.sender.mainFrame) throw new Error('请求不来自工作区主页面');
        return { ok: true, value: await action(event.sender.id, input) };
      } catch (error) {
        const message =
          error instanceof z.ZodError
            ? error.issues.map((issue) => issue.message).join('；')
            : error instanceof Error
              ? error.message
              : '操作失败';
        return { ok: false, error: message };
      }
    });
  };
  remote.register(handle);
  handle(channels.context, (sender) => registry.get(sender));
  handle(channels.list, async (sender) => {
    const context = registry.get(sender);
    const projects = await store.list();
    return context.kind === 'manager'
      ? projects
      : projects.filter((project) => project.id === context.projectId);
  });
  handle(channels.create, async (sender, input) => {
    registry.assertManager(sender);
    const project = await store.create(input as Parameters<ProjectStore['create']>[0]);
    console.info('[projects] created', { projectId: project.id });
    broadcast();
    return project;
  });
  handle(channels.save, async (sender, input) => {
    const project = projectSchema.parse(input);
    registry.assertProject(sender, project.id);
    const saved = await store.save(project);
    remote.reconcile(saved);
    workspaces.get(project.id)?.setTitle(`${saved.name} · TraceLogDock`);
    console.info('[projects] saved', { projectId: saved.id, revision: saved.revision });
    broadcast();
    return saved;
  });
  handle(channels.remove, async (sender, input) => {
    registry.assertManager(sender);
    const id = z.string().parse(input);
    const project = (await store.list()).find((value) => value.id === id);
    if (!project) throw new Error('项目不存在');
    const result = await dialog.showMessageBox({
      type: 'question',
      title: '删除项目',
      message: `删除“${project.name}”及本地配置？`,
      detail: '这不会删除远程服务器、容器或日志。',
      buttons: ['取消', '删除项目'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response !== 1) return;
    await store.remove(id);
    console.info('[projects] removed', { projectId: id });
    workspaces.get(id)?.close();
    broadcast();
  });
  handle(channels.open, async (sender, input) => {
    const id = z.string().parse(input);
    registry.assertProject(sender, id);
    await openProject(id);
  });
  handle(channels.manager, () => openManager());
  handle(channels.copy, (_sender, input) => clipboard.writeText(z.string().parse(input)));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => openManager());
  void app
    .whenReady()
    .then(() => {
      store = new ProjectStore(join(app.getPath('userData'), 'projects.json'));
      remote = new RemoteController(
        store,
        registry,
        join(app.getPath('userData'), 'known-hosts.json'),
        (owner, event) => {
          const contents = BrowserWindow.getAllWindows().find(
            (window) => window.webContents.id === owner,
          )?.webContents;
          if (contents && !contents.isDestroyed()) contents.send(remoteChannels.event, event);
        },
        async (owner) => {
          const window = BrowserWindow.getAllWindows().find(
            (window) => window.webContents.id === owner,
          );
          if (!window) throw new Error('工作区已关闭');
          const result = await dialog.showOpenDialog(window, {
            title: '选择SSH私钥',
            properties: ['openFile'],
          });
          return result.canceled ? undefined : result.filePaths[0];
        },
      );
      registerHandlers();
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(process.platform === 'darwin'
            ? [
                {
                  label: 'TraceLogDock',
                  submenu: [
                    { role: 'about' as const },
                    { type: 'separator' as const },
                    { role: 'hide' as const },
                    { role: 'quit' as const },
                  ],
                },
              ]
            : []),
          {
            label: '文件',
            submenu: [
              { label: '项目管理', accelerator: 'CmdOrCtrl+N', click: openManager },
              { role: 'close' },
            ],
          },
          {
            label: '编辑',
            submenu: [
              { role: 'undo' },
              { role: 'redo' },
              { type: 'separator' },
              { role: 'cut' },
              { role: 'copy' },
              { role: 'paste' },
              { role: 'selectAll' },
            ],
          },
          { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
        ]),
      );
      openManager();
      app.on('activate', openManager);
    })
    .catch((error: unknown) => {
      console.error('[app] startup failed', error);
      app.quit();
    });
}
app.on('before-quit', () => {
  for (const window of BrowserWindow.getAllWindows()) remote?.disposeOwner(window.webContents.id);
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
