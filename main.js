import fs from 'node:fs/promises';
import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_CHANNELS, GUARDIAN_MESSAGES, GUARDIAN_REQUESTS } from './shared/ipc.js';
import { createInitialSessionState, formatRemaining, getDefaultSystemSafelistRules } from './shared/models.js';
import { GuardianRuntime } from './guardian/runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const localAppDataRoot = app.isPackaged ? 'Sprout' : 'Sprout-dev';
const localAppDataDir = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, localAppDataRoot)
  : path.join(__dirname, '.sprout-local');
const userDataDirOverride = path.join(localAppDataDir, 'user-data');
const sessionDataDirOverride = path.join(localAppDataDir, 'session-data');
const diskCacheDirOverride = path.join(localAppDataDir, 'cache');

app.setPath('userData', userDataDirOverride);
app.setPath('sessionData', sessionDataDirOverride);
app.commandLine.appendSwitch('disk-cache-dir', diskCacheDirOverride);

class SettingsStore {
  constructor(baseDir) {
    this.file = path.join(baseDir, 'settings.json');
    this.settings = null;
  }

  getDefaults() {
    return {
      historyDir: path.join(app.getPath('documents'), 'Sprout', 'history'),
      autoWriteHistory: true,
      systemSafelistEnabled: true,
      exitDifficulty: 'easy',
      openAtLogin: false,
      silentStart: false,
      systemSafelistRules: getDefaultSystemSafelistRules(),
    };
  }

  normalizeSettings(input = {}) {
    const defaults = this.getDefaults();
    const exitDifficulty = ['easy', 'medium', 'hard'].includes(input?.exitDifficulty)
      ? input.exitDifficulty
      : defaults.exitDifficulty;
    return {
      historyDir: String(input?.historyDir || '').trim() || defaults.historyDir,
      openAtLogin: !!input?.openAtLogin,
      silentStart: !!input?.silentStart,
      autoWriteHistory: input?.autoWriteHistory !== false,
      systemSafelistEnabled: input?.systemSafelistEnabled !== false,
      exitDifficulty,
      systemSafelistRules: defaults.systemSafelistRules,
    };
  }

  async load() {
    if (this.settings) {
      return this.settings;
    }

    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const stored = JSON.parse(raw);
      this.settings = this.normalizeSettings(stored);
      if (JSON.stringify(this.settings) !== JSON.stringify(stored)) {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(this.file, JSON.stringify(this.settings, null, 2), 'utf8');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('读取设置失败', error);
      }
      this.settings = this.normalizeSettings();
      await this.save(this.settings);
    }

    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: this.settings.openAtLogin,
        args: this.settings.silentStart ? ['--hidden'] : [],
      });
    }

    await fs.mkdir(this.settings.historyDir, { recursive: true });
    return this.settings;
  }

  async save(patch = {}) {
    const current = await this.load();
    this.settings = this.normalizeSettings({
      ...current,
      ...patch,
    });
    
    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: this.settings.openAtLogin,
        args: this.settings.silentStart ? ['--hidden'] : [],
      });
    }
    
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.settings, null, 2), 'utf8');
    await fs.mkdir(this.settings.historyDir, { recursive: true });
    return this.settings;
  }
}

function parseDashboardSummaryFromMd(fileName, content) {
  const dateKey = fileName.replace(/\.md$/i, '');
  const totalDurationText = (content.match(/当日总专注时长：([^\r\n]+)/) || [])[1] || '';
  const totalSessions = Number((content.match(/当日总会话数：(\d+)/) || [])[1] || 0);
  const totalViolations = Number((content.match(/当日总违规次数：(\d+)/) || [])[1] || 0);
  const sessions = content
    .split(/\r?\n/)
    .filter((line) => line.startsWith('## ') && !line.startsWith('## 当日摘要'))
    .map((line) => line.replace(/^##\s+/, '').trim());

  return {
    dateKey,
    totalMinutes: parseChineseDurationToMinutes(totalDurationText),
    totalSessions,
    totalViolations,
    sessions,
  };
}

function parseChineseDurationToMinutes(input = '') {
  const text = String(input).trim();
  if (!text) {
    return 0;
  }

  const hours = Number((text.match(/(\d+)\s*小时/) || [])[1] || 0);
  const minutes = Number((text.match(/(\d+)\s*分钟/) || [])[1] || 0);
  if (hours || minutes) {
    return hours * 60 + minutes;
  }

  return Number((text.match(/(\d+)/) || [])[1] || 0);
}

class GuardianBridge {
  constructor() {
    this.runtime = null;
    this.started = false;
    this.startPromise = null;
    this.bootstrapPayload = null;
    this.onPush = null;
    this.state = createInitialSessionState();
  }

  async start(bootstrapPayload, onPush) {
    this.bootstrapPayload = bootstrapPayload || this.bootstrapPayload;
    this.onPush = onPush || this.onPush;
    return this.#ensureStarted();
  }

  async request(type, payload = {}) {
    await this.#ensureStarted();
    return this.runtime.handle({ type, payload });
  }

  stop() {
    if (this.runtime) {
      this.runtime.shutdown();
    }
    this.started = false;
    this.startPromise = null;
  }

  async #ensureStarted() {
    if (this.started) {
      return { ok: true };
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    if (!this.bootstrapPayload) {
      throw new Error('guardian 尚未配置启动参数');
    }

    if (!this.runtime) {
      this.runtime = new GuardianRuntime({
        send: (message) => this.#handleMessage(message),
        logger: console,
      });
    }

    this.startPromise = this.runtime.handle({
      type: GUARDIAN_REQUESTS.bootstrap,
      payload: this.bootstrapPayload,
    }).then((result) => {
      this.started = true;
      return result;
    }).finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  #handleMessage(message) {
    if (message.type === GUARDIAN_MESSAGES.state) {
      this.state = message.payload;
      this.onPush?.('state', message.payload);
      return;
    }

    if (message.type === GUARDIAN_MESSAGES.violation) {
      this.onPush?.('violation', message.payload);
      return;
    }

    if (message.type === GUARDIAN_MESSAGES.ready) {
      this.onPush?.('state', this.state);
    }
  }
}

let mainWindow = null;
let tray = null;
let forceQuit = false;
const guardian = new GuardianBridge();
let settingsStore = null;
let appSettings = null;
let lastSessionStatus = 'idle';

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }

  refreshTrayMenu();
}

function createWindow(startHidden = false) {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 980,
    minHeight: 700,
    title: 'Sprout',
    icon: path.join(__dirname, 'app', 'icon.ico'),
    backgroundColor: '#0f172a',
    show: !startHidden,
    webPreferences: {
      preload: path.join(__dirname, 'app', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));

  mainWindow.on('close', (event) => {
    if (forceQuit) {
      return;
    }

    event.preventDefault();
    mainWindow.hide();
  });
}

function ensureWindowVisible() {
  if (!mainWindow) {
    createWindow();
  }

  mainWindow.show();
  mainWindow.focus();
}

function notifySessionCompleted(state) {
  const durationMinutes = Number(state?.summary?.actualDurationMinutes ?? state?.summary?.durationMinutes ?? 0);
  const body = durationMinutes > 0
    ? `本轮专注已完成，共 ${durationMinutes} 分钟。`
    : '本轮专注已完成。';

  shell.beep();
  if (!Notification.isSupported()) {
    return;
  }

  const notification = new Notification({
    title: 'Sprout',
    body,
    silent: false,
  });
  notification.on('click', () => ensureWindowVisible());
  notification.show();
}

function refreshTrayMenu() {
  if (!tray) {
    return;
  }

  const state = guardian.state || createInitialSessionState();
  const contextLabel = state.currentContext?.title || state.currentContext?.processName || '等待前台窗口';
  const menu = Menu.buildFromTemplate([
    {
      label: state.status === 'running' ? `专注中 ${formatRemaining(state.remainingMs)}` : 'Sprout',
      enabled: false,
    },
    {
      label: contextLabel,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '打开主界面',
      click: () => ensureWindowVisible(),
    },
    {
      label: '尝试退出会话',
      click: () => ensureWindowVisible(),
    },
    { type: 'separator' },
    {
      label: '退出程序',
      click: () => {
        forceQuit = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(state.status === 'running' ? `Sprout ${formatRemaining(state.remainingMs)}` : 'Sprout');
}

function createTray() {
  const image = nativeImage.createFromPath(path.join(__dirname, 'app', 'icon.ico'));

  tray = new Tray(image);
  tray.on('click', () => ensureWindowVisible());
  refreshTrayMenu();
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    ensureWindowVisible();
  });

  app.whenReady().then(async () => {
  const userDataDir = app.getPath('userData');
  settingsStore = new SettingsStore(userDataDir);
  appSettings = await settingsStore.load();
  const logDir = path.join(userDataDir, 'logs');
  const guardianBootstrap = {
    logDir,
    historyDir: appSettings.historyDir,
    preferences: {
      autoWriteHistory: appSettings.autoWriteHistory,
      systemSafelistEnabled: appSettings.systemSafelistEnabled,
    },
  };
  const onGuardianPush = (kind, payload) => {
    if (kind === 'state') {
      const previousStatus = lastSessionStatus;
      lastSessionStatus = payload?.status || 'idle';
      broadcast(IPC_CHANNELS.push.state, payload);
      if (previousStatus === 'running' && payload?.status === 'completed') {
        notifySessionCompleted(payload);
      }
    } else if (kind === 'violation') {
      broadcast(IPC_CHANNELS.push.violation, payload);
    }
  };

  ipcMain.handle(IPC_CHANNELS.invoke.getState, async () => guardian.request(GUARDIAN_REQUESTS.getState));
  ipcMain.handle(IPC_CHANNELS.invoke.getSettings, async () => settingsStore.load());
  ipcMain.handle(IPC_CHANNELS.invoke.saveSettings, async (_event, patch) => {
    appSettings = await settingsStore.save(patch);
    await guardian.request(GUARDIAN_REQUESTS.updatePreferences, {
      preferences: {
        autoWriteHistory: appSettings.autoWriteHistory,
        systemSafelistEnabled: appSettings.systemSafelistEnabled,
      },
      historyDir: appSettings.historyDir,
    });
    return appSettings;
  });
  ipcMain.handle(IPC_CHANNELS.invoke.listHistoryFiles, async () => {
    const settings = await settingsStore.load();
    await fs.mkdir(settings.historyDir, { recursive: true });
    const entries = await fs.readdir(settings.historyDir, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map(async (entry) => {
        const fullPath = path.join(settings.historyDir, entry.name);
        const stat = await fs.stat(fullPath);
        return {
          fileName: entry.name,
          fullPath,
          modifiedAt: stat.mtime.toISOString(),
        };
      }));
    return files.sort((left, right) => right.fileName.localeCompare(left.fileName));
  });
  ipcMain.handle(IPC_CHANNELS.invoke.readHistoryFile, async (_event, fileName) => {
    const settings = await settingsStore.load();
    const safeName = path.basename(fileName || '');
    const fullPath = path.join(settings.historyDir, safeName);
    const content = await fs.readFile(fullPath, 'utf8');
    return { fileName: safeName, fullPath, content };
  });
  ipcMain.handle(IPC_CHANNELS.invoke.openHistoryFile, async (_event, fileName) => {
    const settings = await settingsStore.load();
    const safeName = path.basename(fileName || '');
    const fullPath = path.join(settings.historyDir, safeName);
    return shell.openPath(fullPath);
  });
  ipcMain.handle(IPC_CHANNELS.invoke.openHistoryDirectory, async () => {
    const settings = await settingsStore.load();
    await fs.mkdir(settings.historyDir, { recursive: true });
    return shell.openPath(settings.historyDir);
  });
  ipcMain.handle(IPC_CHANNELS.invoke.getDashboardSummary, async () => {
    const settings = await settingsStore.load();
    await fs.mkdir(settings.historyDir, { recursive: true });
    const entries = await fs.readdir(settings.historyDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a))
      .slice(0, 7);

    const days = await Promise.all(files.map(async (fileName) => {
      const fullPath = path.join(settings.historyDir, fileName);
      const content = await fs.readFile(fullPath, 'utf8');
      return parseDashboardSummaryFromMd(fileName, content);
    }));

    return days;
  });
  ipcMain.handle(IPC_CHANNELS.invoke.resetSession, async () => guardian.request(GUARDIAN_REQUESTS.resetSession));
  ipcMain.handle(IPC_CHANNELS.invoke.captureCurrentWindow, async () => guardian.request(GUARDIAN_REQUESTS.captureCurrentWindow));
  ipcMain.handle(IPC_CHANNELS.invoke.getCurrentContext, async () => guardian.request(GUARDIAN_REQUESTS.getCurrentContext));
  ipcMain.handle(IPC_CHANNELS.invoke.startSession, async (_event, payload) => guardian.request(GUARDIAN_REQUESTS.startSession, payload));
  ipcMain.handle(IPC_CHANNELS.invoke.endSession, async (_event, payload) => guardian.request(GUARDIAN_REQUESTS.endSession, payload));
  ipcMain.handle(IPC_CHANNELS.invoke.openMainWindow, async () => {
    ensureWindowVisible();
    return { ok: true };
  });

  const shouldStartHidden = app.isPackaged && !!appSettings.silentStart && process.argv.includes('--hidden');
  createWindow(shouldStartHidden);
  createTray();

  guardian.start(guardianBootstrap, onGuardianPush).catch((error) => {
    console.error('guardian 启动失败', error);
  });
});

app.on('window-all-closed', (event) => {
  if (!forceQuit) {
    event.preventDefault();
  }
});

app.on('before-quit', () => {
  forceQuit = true;
  guardian.stop();
});
}
