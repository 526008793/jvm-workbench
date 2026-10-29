import { contextBridge, ipcRenderer } from 'electron';
import { channels, remoteChannels } from '../shared/channels';
import type { DesktopApi } from '../shared/models';

const api: DesktopApi = {
  listConnections: () => ipcRenderer.invoke(remoteChannels.list),
  connect: (input) => ipcRenderer.invoke(remoteChannels.connect, input),
  disconnect: (id) => ipcRenderer.invoke(remoteChannels.disconnect, id),
  answerChallenge: (input) => ipcRenderer.invoke(remoteChannels.answer, input),
  choosePrivateKey: () => ipcRenderer.invoke(remoteChannels.key),
  terminalSnapshot: (id) => ipcRenderer.invoke(remoteChannels.terminal, id),
  terminalInput: (id, data) => ipcRenderer.invoke(remoteChannels.input, { id, data }),
  terminalResize: (id, cols, rows) => ipcRenderer.invoke(remoteChannels.resize, { id, cols, rows }),
  confirmTarget: (id) => ipcRenderer.invoke(remoteChannels.confirm, id),
  discoverContainers: (input) => ipcRenderer.invoke(remoteChannels.discover, input),
  startLogs: (input) => ipcRenderer.invoke(remoteChannels.logs, input),
  stopLogs: (ids) => ipcRenderer.invoke(remoteChannels.stop, ids),
  listLogTasks: () => ipcRenderer.invoke(remoteChannels.tasks),
  onRemoteEvent: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: Parameters<typeof callback>[0],
    ): void => callback(data);
    ipcRenderer.on(remoteChannels.event, listener);
    return () => ipcRenderer.removeListener(remoteChannels.event, listener);
  },
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
