import fs from 'node:fs/promises';
import path from 'node:path';
import { regenerateHistoryMarkdown, toLocalDateKey } from './history.js';
import {
  buildWindowAllowanceFromContext,
  createEmptyActiveContext,
  createInitialSessionState,
} from '../shared/models.js';
import { decideContext } from './rules.js';
import { WindowsService } from './windows-service.js';

const MONITOR_INTERVAL_MS = 350;
const CLOCK_INTERVAL_MS = 250;
const DUPLICATE_VIOLATION_WINDOW_MS = 8000;
const POST_VIOLATION_CONTEXT_DELAY_MS = 120;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GuardianRuntime {
  constructor({ send, logger = console }) {
    this.send = send;
    this.logger = logger;
    this.windows = new WindowsService();
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

    this.state.systemSafelistEnabled = this.preferences.systemSafelistEnabled !== false;
    await this.resolveCurrentContext();
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
    if (ctx?.processId && Number(ctx.processId) === process.pid) {
      return true;
    }
    const processPath = String(ctx?.processPath || '').toLowerCase();
    const processName = String(ctx?.processName || '').toLowerCase();
    return processPath.includes('sprout')
      || (processName === 'electron.exe' && processPath.includes('electron\\dist'));
  }

  async resolveCurrentContext() {
    const context = this.captureForegroundContext();
    this.state.currentContext = context;
    this.sendState();
    return this.state.currentContext;
  }

  captureForegroundContext() {
    return this.windows.captureSystemContext() || createEmptyActiveContext();
  }

  async resolvePostViolationContext(previousContext) {
    const immediate = this.captureForegroundContext();
    if (this.isStablePostViolationContext(immediate, previousContext)) {
      return immediate;
    }

    await delay(POST_VIOLATION_CONTEXT_DELAY_MS);
    const delayed = this.captureForegroundContext();
    if (delayed?.windowId) {
      return delayed;
    }

    return immediate?.windowId ? immediate : createEmptyActiveContext();
  }

  isStablePostViolationContext(candidate, previousContext) {
    if (!candidate?.windowId) {
      return false;
    }

    if (!previousContext?.windowId) {
      return true;
    }

    return candidate.windowId !== previousContext.windowId;
  }

  async startSession(payload) {
    if (this.state.status === 'running') {
      throw new Error('已有专注会话在运行');
    }

    const sessionMode = payload?.sessionMode === 'countup' ? 'countup' : 'countdown';
    const durationMinutes = sessionMode === 'countdown'
      ? Number(payload?.durationMinutes || 25)
      : 0;
    const allowedWindows = Array.isArray(payload?.allowedWindows) ? payload.allowedWindows : [];
    const allowedCategories = Array.isArray(payload?.allowedCategories) ? payload.allowedCategories : [];
    if (!allowedWindows.length && !allowedCategories.length) {
      throw new Error('至少需要一个允许窗口或允许分类');
    }

    const now = Date.now();
    const endsAt = sessionMode === 'countdown' ? now + durationMinutes * 60_000 : null;
    const currentContext = await this.resolveCurrentContext();
    this.state = {
      ...createInitialSessionState(),
      status: 'running',
      sessionMode,
      startedAt: new Date(now).toISOString(),
      endsAt: endsAt ? new Date(endsAt).toISOString() : null,
      durationMinutes,
      remainingMs: sessionMode === 'countdown' ? endsAt - now : 0,
      elapsedMs: 0,
      allowedWindows,
      allowedCategories,
      currentContext,
      recentAllowedWindow: allowedWindows[0] ?? null,
      systemSafelistEnabled: this.preferences.systemSafelistEnabled !== false,
      exitProtection: payload?.exitProtection ?? { type: 'hold', holdToExitMs: 3000 },
    };
    this.matchStats = {
      windowHits: {},
      categoryHits: {},
    };

    await this.writeLog('session-started', {
      sessionMode,
      durationMinutes,
      allowedWindows,
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
      sessionMode: this.state.sessionMode,
      startedAt: this.state.startedAt,
      endedAt,
      durationMinutes: actualDurationMinutes,
      actualDurationMinutes,
      plannedDurationMinutes: this.state.sessionMode === 'countdown' ? this.state.durationMinutes : null,
      violationCount: this.state.violationCount,
      violations: this.state.violations,
      allowedWindows: this.state.allowedWindows,
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
      if (this.state.sessionMode === 'countup') {
        this.state.elapsedMs = Math.max(0, Date.now() - Date.parse(this.state.startedAt));
        this.sendState();
        return;
      }

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

  shutdown() {
    this.stopLoops();
    if (this.contextTrackingTimer) {
      clearInterval(this.contextTrackingTimer);
      this.contextTrackingTimer = null;
    }
  }

  async monitorTick() {
    if (this.state.status !== 'running') {
      return;
    }

    const context = this.captureForegroundContext();
    this.state.currentContext = context;

    const decision = decideContext({
      context,
      allowedWindows: this.state.allowedWindows,
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

    const signature = `${context.windowId}:${context.processPath || context.processName}:${decision.reason}`;
    const now = Date.now();
    const minimized = context.windowId ? this.windows.minimizeWindow(context.windowId) : false;
    const restored = this.state.recentAllowedWindow?.windowId
      ? this.windows.restoreWindow(this.state.recentAllowedWindow.windowId)
      : false;
    const postContext = await this.resolvePostViolationContext(context);
    this.state.currentContext = postContext;

    const isDuplicate = signature === this.lastViolation.signature
      && now - this.lastViolation.at < DUPLICATE_VIOLATION_WINDOW_MS;

    this.lastViolation = this.isStablePostViolationContext(postContext, context)
      ? { signature: '', at: 0 }
      : { signature, at: now };

    if (isDuplicate) {
      this.sendState();
      return;
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
