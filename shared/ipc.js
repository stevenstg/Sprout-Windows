export const IPC_CHANNELS = {
  invoke: {
    getState: 'forest:get-state',
    getSettings: 'forest:get-settings',
    saveSettings: 'forest:save-settings',
    listHistoryFiles: 'forest:list-history-files',
    readHistoryFile: 'forest:read-history-file',
    openHistoryFile: 'forest:open-history-file',
    openHistoryDirectory: 'forest:open-history-directory',
    getDashboardSummary: 'forest:get-dashboard-summary',
    resetSession: 'forest:reset-session',
    captureCurrentWindow: 'forest:capture-current-window',
    getCurrentContext: 'forest:get-current-context',
    startSession: 'forest:start-session',
    endSession: 'forest:end-session',
    openMainWindow: 'forest:open-main-window',
  },
  push: {
    state: 'forest:state',
    violation: 'forest:violation',
  },
};

export const GUARDIAN_REQUESTS = {
  bootstrap: 'bootstrap',
  getState: 'get-state',
  resetSession: 'reset-session',
  updatePreferences: 'update-preferences',
  captureCurrentWindow: 'capture-current-window',
  getCurrentContext: 'get-current-context',
  startSession: 'start-session',
  endSession: 'end-session',
  ping: 'ping',
};

export const GUARDIAN_MESSAGES = {
  response: 'response',
  state: 'state',
  violation: 'violation',
  ready: 'ready',
  log: 'log',
};
