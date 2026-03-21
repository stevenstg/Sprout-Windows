import fs from 'node:fs/promises';
import path from 'node:path';
import { ActivityWatchClient } from '../integrations/activitywatch/client.js';
import { regenerateHistoryMarkdown, toLocalDateKey } from './history.js';
import {
  buildWindowAllowanceFromContext,
  createEmptyActiveContext,
  createGuardianStatus,
  createInitialSessionState,
} from '../shared/models.js';
import { decideContext } from './rules.js';
import { WindowsService } from './windows-service.js';

const MONITOR_INTERVAL_MS = 350;
const CLOCK_INTERVAL_MS = 250;
const DUPLICATE_VIOLATION_WINDOW_MS = 1500;
const DEFAULT_CLOSE_BROWSER_TAB_DELAY_MS = 180;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GuardianRuntime {
  constructor({ send, logger = console }) {
    this.send = send;
    this.logger = logger;
    this.windows = new WindowsService();
    this.activityWatch = new ActivityWatchClient();
    this.state = createInitialSessionState();
    this.monitorTimer = null;
    this.clockTimer = null;
    this.lastExternalContext = null;
    this.contextTrackingTimer = null;
    this.logDir = null;
    this.historyDir = null;
    this.preferences = {
      autoWriteHistory: true,
      systemSafelistEnabled: true,
      closeBrowserTabOnViolation: false,
      closeBrowserTabDelayMs: DEFAULT_CLOSE_BROWSER_TAB_DELAY_MS,
    };
    this.lastViolation = { signature: '', at: 0 };
    this.matchStats = {
      windowHits: {},
      categoryHits: {},
    };
  }

  async bootstrap({ logDir, historyDir, preferences } = {}) {
    this.logDir = logDir || null;
    this.historyDir = historyDir || null;
    this.preferences = {
      ...this.preferences,
      ...(preferences || {}),
    };
    if (this.logDir) {
      await fs.mkdir(this.logDir, { recursive: true });
    }
    if (this.historyDir) {
      await fs.mkdir(this.historyDir, { recursive: true });
    }

    await this.refreshGuardianStatus(true);
    this.startContextTracking();
    this.send({ type: 'ready', payload: { ok: true } });
    return { ok: true };
  }

  async handle(request) {
    switch (request.type) {
      case 'bootstrap':
        return this.bootstrap(request.payload);
      case 'get-state':
        return this.getState();
      case 'refresh-status':
        return this.refreshGuardianStatus(true);
      case 'reset-session':
        return this.resetSession();
      case 'update-preferences':
        return this.updatePreferences(request.payload);
      case 'capture-current-window':
        return this.captureCurrentWindow();
      case 'get-current-context':
        return this.resolveCurrentContext();
      case 'start-session':
        return this.startSession(request.payload);
      case 'end-session':
        return this.endSession(request.payload?.reason ?? 'cancelled');
      case 'ping':
        return { ok: true, now: new Date().toISOString() };
      default:
        throw new Error(`未知 guardian 请求：${request.type}`);
    }
  }

  getState() {
    return structuredClone(this.state);
  }

  async updatePreferences(payload = {}) {
    this.preferences = {
      ...this.preferences,
      ...(payload.preferences || payload || {}),
    };
    if (payload.historyDir) {
      this.historyDir = payload.historyDir;
      await fs.mkdir(this.historyDir, { recursive: true });
    }

    this.state.systemSafelistEnabled = this.preferences.systemSafelistEnabled !== false;
    this.sendState();
    return {
      ok: true,
      preferences: structuredClone(this.preferences),
      historyDir: this.historyDir,
    };
  }

  async refreshGuardianStatus(force = false) {
    const guardianStatus = await this.activityWatch.probe(force);
    this.state.guardianStatus = guardianStatus;
    this.send({ type: 'status', payload: guardianStatus });
    this.sendState();
    return guardianStatus;
  }

  async captureCurrentWindow() {
    const context = this.lastExternalContext?.windowId
      ? structuredClone(this.lastExternalContext)
      : this.windows.captureSystemContext();
    if (!context.windowId) {
      throw new Error('当前没有可加入的活跃窗口');
    }

    return {
      allowance: buildWindowAllowanceFromContext(context),
      context,
    };
  }

  startContextTracking() {
    if (this.contextTrackingTimer) {
      return;
    }

    this.contextTrackingTimer = setInterval(() => {
      try {
        const ctx = this.windows.captureSystemContext();
        if (ctx?.windowId && !this.isOwnApp(ctx)) {
          this.lastExternalContext = ctx;
        }
      } catch (error) {
        this.logger.error(error);
      }
    }, 1000);
  }

  isOwnApp(ctx) {
    const processPath = String(ctx?.processPath || '').toLowerCase();
    const processName = String(ctx?.processName || '').toLowerCase();
    return processPath.includes('sprout')
      || (processName === 'electron.exe' && processPath.includes('electron\\dist'));
  }

  async resolveCurrentContext() {
    const systemContext = this.windows.captureSystemContext();
    const { context, guardianStatus } = await this.activityWatch.enrichContext(systemContext);
    this.state.currentContext = context || createEmptyActiveContext();
    this.state.guardianStatus = guardianStatus || createGuardianStatus();
    this.sendState();
    return this.state.currentContext;
  }

  async startSession(payload) {
    if (this.state.status === 'running') {
      throw new Error('已有专注会话在运行');
    }

    const durationMinutes = Number(payload?.durationMinutes || 25);
    const allowedWindows = Array.isArray(payload?.allowedWindows) ? payload.allowedWindows : [];
    const allowedDomains = Array.isArray(payload?.allowedDomains) ? payload.allowedDomains : [];
    const allowedCategories = Array.isArray(payload?.allowedCategories) ? payload.allowedCategories : [];
    if (!allowedWindows.length && !allowedDomains.length && !allowedCategories.length) {
      throw new Error('至少需要一个允许窗口、允许域名或允许分类');
    }

    const now = Date.now();
    const endsAt = now + durationMinutes * 60_000;
    const currentContext = await this.resolveCurrentContext();
    this.state = {
      ...createInitialSessionState(),
      status: 'running',
      startedAt: new Date(now).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      durationMinutes,
      remainingMs: endsAt - now,
      allowedWindows,
      allowedDomains,
      allowedCategories,
      currentContext,
      recentAllowedWindow: allowedWindows[0] ?? null,
      guardianStatus: this.state.guardianStatus,
      systemSafelistEnabled: this.preferences.systemSafelistEnabled !== false,
      exitProtection: payload?.exitProtection ?? { type: 'hold', holdToExitMs: 3000 },
    };
    this.matchStats = {
      windowHits: {},
      categoryHits: {},
    };

    await this.writeLog('session-started', {
      durationMinutes,
      allowedWindows,
      allowedDomains,
      allowedCategories,
    });

    this.startLoops();
    this.sendState();
    return this.getState();
  }

  async endSession(reason = 'cancelled') {
    if (this.state.status !== 'running') {
      return this.getState();
    }

    this.stopLoops();
    const endedAt = new Date().toISOString();
    const actualDurationMinutes = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(this.state.startedAt)) / 60_000));
    const primaryWindow = this.derivePrimaryWindow();
    const primaryCategory = this.derivePrimaryCategory();
    const summary = {
      startedAt: this.state.startedAt,
      endedAt,
      durationMinutes: actualDurationMinutes,
      actualDurationMinutes,
      plannedDurationMinutes: this.state.durationMinutes,
      violationCount: this.state.violationCount,
      violations: this.state.violations,
      allowedWindows: this.state.allowedWindows,
      allowedDomains: this.state.allowedDomains,
      allowedCategories: this.state.allowedCategories,
      primaryWindow,
      primaryCategory,
      completionReason: reason,
    };

    this.state = {
      ...this.state,
      status: reason === 'completed' ? 'completed' : 'cancelled',
      remainingMs: 0,
      endsAt: endedAt,
      summary,
    };

    await this.writeLog('session-ended', summary);
    await this.writeHistory(summary);
    this.sendState();
    return this.getState();
  }

  async resetSession() {
    this.stopLoops();
    this.state = {
      ...createInitialSessionState(),
      guardianStatus: this.state.guardianStatus,
      currentContext: this.state.currentContext,
      systemSafelistEnabled: this.preferences.systemSafelistEnabled !== false,
    };
    this.matchStats = {
      windowHits: {},
      categoryHits: {},
    };
    this.sendState();
    return this.getState();
  }

  startLoops() {
    this.stopLoops();
    this.monitorTimer = setInterval(() => {
      this.monitorTick().catch((error) => {
        this.logger.error(error);
      });
    }, MONITOR_INTERVAL_MS);

    this.clockTimer = setInterval(() => {
      const remainingMs = Math.max(0, Date.parse(this.state.endsAt) - Date.now());
      this.state.remainingMs = remainingMs;
      if (remainingMs === 0 && this.state.status === 'running') {
        this.endSession('completed').catch((error) => this.logger.error(error));
      } else {
        this.sendState();
      }
    }, CLOCK_INTERVAL_MS);
  }

  stopLoops() {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }

    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  async monitorTick() {
    if (this.state.status !== 'running') {
      return;
    }

    const systemContext = this.windows.captureSystemContext();
    const { context, guardianStatus } = await this.activityWatch.enrichContext(systemContext);
    this.state.currentContext = context;
    this.state.guardianStatus = guardianStatus;

    const decision = decideContext({
      context,
      allowedWindows: this.state.allowedWindows,
      allowedDomains: this.state.allowedDomains,
      allowedCategories: this.state.allowedCategories,
      systemSafelistEnabled: this.preferences.systemSafelistEnabled !== false,
    });

    if (decision.allowed) {
      if (decision.matchedWindow) {
        this.state.recentAllowedWindow = decision.matchedWindow;
        this.trackMatch('windowHits', decision.matchedWindow.id);
      }

      if (decision.matchedCategory) {
        this.trackMatch('categoryHits', decision.matchedCategory.id);
      }

      this.sendState();
      return;
    }

    const signature = `${context.windowId}:${context.title}:${decision.reason}`;
    const now = Date.now();
    if (signature === this.lastViolation.signature && now - this.lastViolation.at < DUPLICATE_VIOLATION_WINDOW_MS) {
      this.sendState();
      return;
    }

    this.lastViolation = { signature, at: now };

    let minimized = false;
    let restored = false;
    let closedBrowserTab = false;
    let recoveredAfterClosingTab = false;

    if (this.preferences.closeBrowserTabOnViolation && context.isBrowser && context.windowId) {
      closedBrowserTab = await this.windows.closeActiveBrowserTab(context.windowId);
      if (closedBrowserTab) {
        const closeDelay = Number(this.preferences.closeBrowserTabDelayMs) || DEFAULT_CLOSE_BROWSER_TAB_DELAY_MS;
        await delay(Math.max(80, closeDelay));

        const afterSystemContext = this.windows.captureSystemContext();
        const afterResult = await this.activityWatch.enrichContext(afterSystemContext);
        this.state.currentContext = afterResult.context;
        this.state.guardianStatus = afterResult.guardianStatus;

        const afterDecision = decideContext({
          context: afterResult.context,
          allowedWindows: this.state.allowedWindows,
          allowedDomains: this.state.allowedDomains,
          allowedCategories: this.state.allowedCategories,
          systemSafelistEnabled: this.preferences.systemSafelistEnabled !== false,
        });

        if (afterDecision.allowed) {
          recoveredAfterClosingTab = true;
          if (afterDecision.matchedWindow) {
            this.state.recentAllowedWindow = afterDecision.matchedWindow;
            this.trackMatch('windowHits', afterDecision.matchedWindow.id);
          }

          if (afterDecision.matchedCategory) {
            this.trackMatch('categoryHits', afterDecision.matchedCategory.id);
          }
        } else {
          minimized = afterResult.context?.windowId ? this.windows.minimizeWindow(afterResult.context.windowId) : false;
          if (this.state.recentAllowedWindow?.windowId) {
            restored = this.windows.restoreWindow(this.state.recentAllowedWindow.windowId);
          }
        }
      }
    }

    if (!recoveredAfterClosingTab && !minimized) {
      minimized = context.windowId ? this.windows.minimizeWindow(context.windowId) : false;
      if (this.state.recentAllowedWindow?.windowId) {
        restored = this.windows.restoreWindow(this.state.recentAllowedWindow.windowId);
      }
    }

    const violation = {
      id: `violation-${now}`,
      timestamp: new Date(now).toISOString(),
      title: context.title,
      processName: context.processName,
      processPath: context.processPath,
      windowId: context.windowId,
      reason: decision.reason,
      minimized,
      restoredAllowedWindow: restored,
      domain: context.domain || '',
      closedBrowserTab,
      recoveredAfterClosingTab,
      suppressedBySystemSafelist: false,
    };

    this.state.violationCount += 1;
    this.state.violations = [...this.state.violations, violation];
    await this.writeLog('violation', violation);

    this.send({
      type: 'violation',
      payload: violation,
    });
    this.sendState();
  }

  sendState() {
    this.send({
      type: 'state',
      payload: this.getState(),
    });
  }

  async writeLog(kind, payload) {
    if (!this.logDir) {
      return;
    }

    const file = path.join(this.logDir, `forest-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const row = JSON.stringify({
      kind,
      timestamp: new Date().toISOString(),
      payload,
    });
    await fs.appendFile(file, `${row}\n`, 'utf8');
  }

  trackMatch(bucket, key) {
    if (!key) {
      return;
    }

    this.matchStats[bucket][key] = (this.matchStats[bucket][key] || 0) + 1;
  }

  derivePrimaryWindow() {
    if (this.state.allowedWindows.length > 0) {
      return this.state.allowedWindows[0];
    }

    const [primaryId] = Object.entries(this.matchStats.windowHits).sort((left, right) => right[1] - left[1])[0] || [];
    return this.state.allowedWindows.find((item) => item.id === primaryId) || this.state.recentAllowedWindow || null;
  }

  derivePrimaryCategory() {
    const [primaryId] = Object.entries(this.matchStats.categoryHits).sort((left, right) => right[1] - left[1])[0] || [];
    if (primaryId) {
      return this.state.allowedCategories.find((item) => item.id === primaryId) || null;
    }

    if (this.state.allowedCategories.length === 1) {
      return this.state.allowedCategories[0];
    }

    return null;
  }

  async writeHistory(summary) {
    if (!this.preferences.autoWriteHistory || !this.historyDir || !this.logDir) {
      return;
    }

    const dateKey = toLocalDateKey(summary.endedAt || new Date());
    await regenerateHistoryMarkdown({
      logDir: this.logDir,
      historyDir: this.historyDir,
      dateKey,
    });
  }
}

export default GuardianRuntime;
