import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc.js';

function subscribe(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('forestApi', {
  getState: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.getState),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.getSettings),
  saveSettings: (payload) => ipcRenderer.invoke(IPC_CHANNELS.invoke.saveSettings, payload),
  listHistoryFiles: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.listHistoryFiles),
  readHistoryFile: (fileName) => ipcRenderer.invoke(IPC_CHANNELS.invoke.readHistoryFile, fileName),
  openHistoryFile: (fileName) => ipcRenderer.invoke(IPC_CHANNELS.invoke.openHistoryFile, fileName),
  openHistoryDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.openHistoryDirectory),
  resetSession: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.resetSession),
  captureCurrentWindow: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.captureCurrentWindow),
  getCurrentContext: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.getCurrentContext),
  startSession: (payload) => ipcRenderer.invoke(IPC_CHANNELS.invoke.startSession, payload),
  endSession: (payload) => ipcRenderer.invoke(IPC_CHANNELS.invoke.endSession, payload),
  openMainWindow: () => ipcRenderer.invoke(IPC_CHANNELS.invoke.openMainWindow),
  subscribeState: (listener) => subscribe(IPC_CHANNELS.push.state, listener),
  subscribeViolation: (listener) => subscribe(IPC_CHANNELS.push.violation, listener),
});
