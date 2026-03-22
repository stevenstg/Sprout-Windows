import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { regenerateHistoryMarkdown } from '../guardian/history.js';
import { GuardianRuntime } from '../guardian/runtime.js';
import { decideContext } from '../guardian/rules.js';
import {
  buildWindowAllowanceFromContext,
  createCategoryRule,
  createInitialSessionState,
  getDefaultCategoryRules,
} from '../shared/models.js';

const initialState = createInitialSessionState();
assert.equal(Array.isArray(initialState.allowedWindows), true);
assert.equal(Array.isArray(initialState.allowedCategories), true);
assert.equal('allowedDomains' in initialState, false);

const defaultCategories = getDefaultCategoryRules();
assert.deepEqual(
  defaultCategories.map((item) => item.name),
  ['Programming', 'AI', 'Notes', 'Paper', 'Office', 'Creative', 'Comms'],
);
assert.equal(defaultCategories.find((item) => item.id === 'cat-programming')?.pattern.includes('Cursor'), true);
assert.equal(defaultCategories.find((item) => item.id === 'cat-ai')?.pattern.includes('Codex'), true);
assert.equal(defaultCategories.find((item) => item.id === 'cat-comms')?.pattern.includes('Zoom'), true);

const windowContext = {
  timestamp: new Date().toISOString(),
  source: 'windows',
  title: 'Visual Studio Code',
  windowId: 101,
  processId: 1,
  processName: 'Code',
  processPath: 'C:/Program Files/Microsoft VS Code/Code.exe',
  confidence: 0.7,
};
const allowance = buildWindowAllowanceFromContext(windowContext);
const decision = decideContext({
  context: windowContext,
  allowedWindows: [allowance],
  allowedCategories: [],
  systemSafelistEnabled: true,
});
assert.equal(decision.allowed, true);

const categoryDecision = decideContext({
  context: {
    ...windowContext,
    title: 'Claude - Project draft',
    processName: 'msedge.exe',
    processPath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  },
  allowedWindows: [],
  allowedCategories: [createCategoryRule({ name: 'AI', pattern: 'Claude|ChatGPT|Gemini' })],
  systemSafelistEnabled: true,
});
assert.equal(categoryDecision.allowed, true);

const systemDecision = decideContext({
  context: {
    ...windowContext,
    title: 'Windows 资源管理器',
    processName: 'explorer.exe',
    processPath: 'C:/Windows/explorer.exe',
  },
  allowedWindows: [],
  allowedCategories: [],
  systemSafelistEnabled: true,
});
assert.equal(systemDecision.allowed, true);
assert.equal(Boolean(systemDecision.matchedSystemRule), true);

const blockedDecision = decideContext({
  context: {
    ...windowContext,
    title: 'Bilibili - 首页',
    processName: 'msedge.exe',
    processPath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  },
  allowedWindows: [],
  allowedCategories: [],
  systemSafelistEnabled: true,
});
assert.equal(blockedDecision.allowed, false);

const runtimeEvents = [];
const runtime = new GuardianRuntime({
  send: (message) => runtimeEvents.push(message),
  logger: console,
});
const violationContext = {
  timestamp: new Date().toISOString(),
  source: 'windows',
  title: 'Distraction Window',
  windowId: 201,
  processId: 9,
  processName: 'DistractionApp',
  processPath: 'C:/Apps/DistractionApp.exe',
  confidence: 0.7,
};
const postContext = {
  timestamp: new Date().toISOString(),
  source: 'windows',
  title: 'Visual Studio Code',
  windowId: 101,
  processId: 1,
  processName: 'Code',
  processPath: 'C:/Program Files/Microsoft VS Code/Code.exe',
  confidence: 0.7,
};
let captureCount = 0;
runtime.windows = {
  captureSystemContext() {
    captureCount += 1;
    return captureCount === 1 ? violationContext : postContext;
  },
  minimizeWindow() {
    return true;
  },
  restoreWindow() {
    return true;
  },
};
runtime.state = {
  ...createInitialSessionState(),
  status: 'running',
  allowedWindows: [buildWindowAllowanceFromContext(postContext)],
  allowedCategories: [],
  recentAllowedWindow: buildWindowAllowanceFromContext(postContext),
};
await runtime.monitorTick();
assert.equal(runtime.state.currentContext.windowId, postContext.windowId);
assert.equal(runtime.state.violations.length, 1);
await runtime.monitorTick();
assert.equal(runtime.state.violations.length, 1);

const tempRoot = await fs.mkdtemp(path.join(process.cwd(), 'tmp-forest-history-'));
const logDir = path.join(tempRoot, 'logs');
const historyDir = path.join(tempRoot, 'history');
await fs.mkdir(logDir, { recursive: true });
await fs.writeFile(
  path.join(logDir, 'forest-2026-03-18.jsonl'),
  `${JSON.stringify({ kind: 'session-ended', payload: {
    startedAt: '2026-03-18T01:00:00.000Z',
    endedAt: '2026-03-18T01:25:00.000Z',
    durationMinutes: 25,
    actualDurationMinutes: 12,
    plannedDurationMinutes: 25,
    violationCount: 2,
    violations: [],
    allowedWindows: [{ label: 'Visual Studio Code' }],
    allowedCategories: [{ name: 'AI', pattern: 'ChatGPT' }],
    primaryWindow: { label: 'Visual Studio Code' },
    primaryCategory: { name: 'AI' },
    completionReason: 'completed',
  } })}\n`,
  'utf8',
);
const historyResult = await regenerateHistoryMarkdown({ logDir, historyDir, dateKey: '2026-03-18' });
const markdown = await fs.readFile(historyResult.historyFile, 'utf8');
assert.equal(markdown.includes('## 当日摘要'), true);
assert.equal(markdown.includes('## '), true);
assert.equal(markdown.includes('Visual Studio Code'), true);
assert.equal(markdown.includes('实际时长：12 分钟'), true);
assert.equal(markdown.includes('计划时长：25 分钟'), true);
assert.equal(markdown.includes('允许域名'), false);

console.log('smoke 通过');

