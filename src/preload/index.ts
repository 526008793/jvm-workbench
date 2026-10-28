import { contextBridge, ipcRenderer } from 'electron';
import { channels } from '../shared/channels';
import type { DesktopApi } from '../shared/models';

const api: DesktopApi = {
  context: () => ipcRenderer.invoke(channels.context),
  listProjects: () => ipcRenderer.invoke(channels.list),
  createProject: (input) => ipcRenderer.invoke(channels.create, input),
  saveProject: (project) => ipcRenderer.invoke(channels.save, project),
  deleteProject: (id) => ipcRenderer.invoke(channels.remove, id),
  openProject: (id) => ipcRenderer.invoke(channels.open, id),
  openManager: () => ipcRenderer.invoke(channels.manager),
  copyCommand: (command) => ipcRenderer.invoke(channels.copy, command),
  onProjectsChanged: (callback) => {
    const listener = (): void => callback();
    ipcRenderer.on(channels.changed, listener);
    return () => ipcRenderer.removeListener(channels.changed, listener);
  },
};
contextBridge.exposeInMainWorld('tracelogdock', api);
