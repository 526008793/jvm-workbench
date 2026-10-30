import { arthasChannels, analysisChannels } from '../shared/channels';
import { contextBridge, ipcRenderer } from 'electron';
import { channels, remoteChannels } from '../shared/channels';
import type { DesktopApi } from '../shared/models';

const api: DesktopApi = {
  analysisConfiguration: () => ipcRenderer.invoke(analysisChannels.configuration),
  saveAnalysisConfiguration: (input) => ipcRenderer.invoke(analysisChannels.save, input),
  chooseSourceRoot: () => ipcRenderer.invoke(analysisChannels.chooseRoot),
  testAnalysisConnection: () => ipcRenderer.invoke(analysisChannels.test),
  sourceContext: (id) => ipcRenderer.invoke(analysisChannels.context, id),
  analyzeSource: (id) => ipcRenderer.invoke(analysisChannels.run, id),
  cancelSourceAnalysis: (id) => ipcRenderer.invoke(analysisChannels.cancel, id),
  sourceAnalysisState: (id) => ipcRenderer.invoke(analysisChannels.state, id),
  onSourceAnalysis: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: Parameters<typeof callback>[0],
    ): void => callback(state);
    ipcRenderer.on(analysisChannels.event, listener);
    return () => ipcRenderer.removeListener(analysisChannels.event, listener);
  },
  passwordStatus: (input) => ipcRenderer.invoke(remoteChannels.passwordStatus, input),
  forgetPassword: (input) => ipcRenderer.invoke(remoteChannels.forgetPassword, input),
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
  discoverJvms: (input) => ipcRenderer.invoke(arthasChannels.discover, input),
  attachArthas: (input) => ipcRenderer.invoke(arthasChannels.attach, input),
  listArthasAgents: () => ipcRenderer.invoke(arthasChannels.agents),
  searchMethods: (agentId, query, packageName) =>
    ipcRenderer.invoke(arthasChannels.search, { agentId, query, packageName }),
  resolveTraceScope: (input) => ipcRenderer.invoke(arthasChannels.scope, input),
  startDiagnostic: (input) => ipcRenderer.invoke(arthasChannels.start, input),
  stopDiagnostic: (id) => ipcRenderer.invoke(arthasChannels.stop, id),
  listDiagnosticTasks: () => ipcRenderer.invoke(arthasChannels.tasks),
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
