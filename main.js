import fs from 'node:fs/promises';
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_CHANNELS, GUARDIAN_MESSAGES, GUARDIAN_REQUESTS } from './shared/ipc.js';
import { createGuardianStatus, createInitialSessionState, formatRemaining, getDefaultSystemSafelistRules } from './shared/models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
      closeBrowserTabOnViolation: false,
      closeBrowserTabDelayMs: 180,
      systemSafelistRules: getDefaultSystemSafelistRules(),
    };
  }

  normalizeSettings(input = {}) {
    const defaults = this.getDefaults();
    return {
      ...defaults,
      ...input,
      historyDir: String(input?.historyDir || '').trim() || defaults.historyDir,
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
      if (this.settings.historyDir !== stored?.historyDir) {
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

    await fs.mkdir(this.settings.historyDir, { recursive: true });
    return this.settings;
  }

  async save(patch = {}) {
    const current = await this.load();
    this.settings = this.normalizeSettings({
      ...current,
      ...patch,
    });
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.settings, null, 2), 'utf8');
    await fs.mkdir(this.settings.historyDir, { recursive: true });
    return this.settings;
  }
}

class GuardianBridge {
  constructor() {
    this.process = null;
    this.readline = null;
    this.pending = new Map();
    this.requestId = 0;
    this.state = createInitialSessionState();
    this.status = this.state.guardianStatus;
  }

  async start(bootstrapPayload, onPush) {
    this.bootstrapPayload = bootstrapPayload || this.bootstrapPayload;
    this.onPush = onPush;
    if (this.process) {
      return;
    }

    const nodeBinary = process.env.NODE_BINARY || process.env.npm_node_execpath || 'node';
    this.process = spawn(nodeBinary, [path.join(__dirname, 'guardian', 'child.js')], {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.process.stderr.on('data', (chunk) => {
      console.error(`[guardian] ${chunk}`.trim());
    });

    this.readline = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });

    this.readline.on('line', (line) => {
      if (!line.trim()) {
        return;
      }

      try {
        const message = JSON.parse(line);
        this.#handleMessage(message);
      } catch (error) {
        console.error('guardian 消息解析失败', error);
      }
    });

    this.process.on('error', (error) => {
      console.error('guardian 启动失败', error);
    });

    this.process.on('exit', (code, signal) => {
      console.error(`guardian 已退出: code=${code} signal=${signal ?? 'none'}`);
      for (const pending of this.pending.values()) {
        pending.reject(new Error('guardian 已退出'));
      }
      this.pending.clear();
      this.process = null;
      this.status = createGuardianStatus({
        online: false,
        note: `guardian 进程已退出（code=${code ?? 'null'} signal=${signal ?? 'none'}）`,
      });
      this.onPush?.('guardian-status', this.status);
    });

    await this.request(GUARDIAN_REQUESTS.bootstrap, this.bootstrapPayload);
  }

  async request(type, payload = {}) {
    if (!this.process?.stdin) {
      if (this.bootstrapPayload) {
        await this.start(this.bootstrapPayload, this.onPush);
      }
    }

    if (!this.process?.stdin) {
      throw new Error('guardian 尚未启动');
    }

    const requestId = `req-${++this.requestId}`;
    const packet = JSON.stringify({ requestId, type, payload });
    this.process.stdin.write(`${packet}\n`);

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });
  }

  stop() {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
  }

  #handleMessage(message) {
    if (message.type === GUARDIAN_MESSAGES.response) {
      const pending = this.pending.get(message.requestId);
      if (!pending) {
        return;
      }

      this.pending.delete(message.requestId);
      if (message.ok) {
        pending.resolve(message.payload);
      } else {
        pending.reject(new Error(message.error || 'guardian 请求失败'));
      }
      return;
    }

    if (message.type === GUARDIAN_MESSAGES.state) {
      this.state = message.payload;
      this.onPush?.('state', message.payload);
      return;
    }

    if (message.type === GUARDIAN_MESSAGES.violation) {
      this.onPush?.('violation', message.payload);
      return;
    }

    if (message.type === GUARDIAN_MESSAGES.status) {
      if (message.payload) {
        this.status = message.payload;
      }
      this.onPush?.('guardian-status', this.status);
      return;
    }

    if (message.type === GUARDIAN_MESSAGES.ready) {
      this.onPush?.('guardian-status', this.status);
    }
  }
}

let mainWindow = null;
let tray = null;
let forceQuit = false;
const guardian = new GuardianBridge();
let settingsStore = null;
let appSettings = null;

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }

  refreshTrayMenu();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 980,
    minHeight: 700,
    title: 'Sprout',
    icon: path.join(__dirname, 'app', 'icon.ico'),
    backgroundColor: '#0f172a',
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

function refreshTrayMenu() {
  if (!tray) {
    return;
  }

  const state = guardian.state || createInitialSessionState();
  const menu = Menu.buildFromTemplate([
    {
      label: state.status === 'running' ? `专注中 ${formatRemaining(state.remainingMs)}` : 'Sprout',
      enabled: false,
    },
    {
      label: guardian.status?.online ? 'ActivityWatch 已连接' : 'ActivityWatch 未连接',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '打开主界面',
      click: () => ensureWindowVisible(),
    },
    {
      label: '查看 AW 状态',
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

app.whenReady().then(async () => {
  const userDataDir = app.getPath('userData');
  settingsStore = new SettingsStore(userDataDir);
  appSettings = await settingsStore.load();
  const logDir = path.join(userDataDir, 'logs');
    await guardian.start({
      logDir,
      historyDir: appSettings.historyDir,
      preferences: {
        autoWriteHistory: appSettings.autoWriteHistory,
        systemSafelistEnabled: appSettings.systemSafelistEnabled,
        closeBrowserTabOnViolation: appSettings.closeBrowserTabOnViolation,
        closeBrowserTabDelayMs: appSettings.closeBrowserTabDelayMs,
      },
    }, (kind, payload) => {
    if (kind === 'state') {
      broadcast(IPC_CHANNELS.push.state, payload);
    } else if (kind === 'violation') {
      broadcast(IPC_CHANNELS.push.violation, payload);
    } else if (kind === 'guardian-status') {
      broadcast(IPC_CHANNELS.push.guardianStatus, payload);
    }
  });

  ipcMain.handle(IPC_CHANNELS.invoke.getState, async () => guardian.request(GUARDIAN_REQUESTS.getState));
  ipcMain.handle(IPC_CHANNELS.invoke.getSettings, async () => settingsStore.load());
  ipcMain.handle(IPC_CHANNELS.invoke.saveSettings, async (_event, patch) => {
    appSettings = await settingsStore.save(patch);
    await guardian.request(GUARDIAN_REQUESTS.updatePreferences, {
      preferences: {
        autoWriteHistory: appSettings.autoWriteHistory,
        systemSafelistEnabled: appSettings.systemSafelistEnabled,
        closeBrowserTabOnViolation: appSettings.closeBrowserTabOnViolation,
        closeBrowserTabDelayMs: appSettings.closeBrowserTabDelayMs,
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
  ipcMain.handle(IPC_CHANNELS.invoke.openHistoryDirectory, async () => {
    const settings = await settingsStore.load();
    await fs.mkdir(settings.historyDir, { recursive: true });
    return shell.openPath(settings.historyDir);
  });
  ipcMain.handle(IPC_CHANNELS.invoke.refreshGuardianStatus, async () => guardian.request(GUARDIAN_REQUESTS.refreshStatus));
  ipcMain.handle(IPC_CHANNELS.invoke.resetSession, async () => guardian.request(GUARDIAN_REQUESTS.resetSession));
  ipcMain.handle(IPC_CHANNELS.invoke.captureCurrentWindow, async () => guardian.request(GUARDIAN_REQUESTS.captureCurrentWindow));
  ipcMain.handle(IPC_CHANNELS.invoke.getCurrentContext, async () => guardian.request(GUARDIAN_REQUESTS.getCurrentContext));
  ipcMain.handle(IPC_CHANNELS.invoke.startSession, async (_event, payload) => guardian.request(GUARDIAN_REQUESTS.startSession, payload));
  ipcMain.handle(IPC_CHANNELS.invoke.endSession, async (_event, payload) => guardian.request(GUARDIAN_REQUESTS.endSession, payload));
  ipcMain.handle(IPC_CHANNELS.invoke.openMainWindow, async () => {
    ensureWindowVisible();
    return { ok: true };
  });

  createWindow();
  createTray();
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
