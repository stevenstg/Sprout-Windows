import { getDefaultCategoryRules } from '../shared/models.js';

const DEFAULT_CATEGORY_RULES = getDefaultCategoryRules();
const api = window.forestApi;
const state = {
  session: null,
  settings: null,
  currentContext: null,
  allowedWindows: [],
  categoryRules: loadCategoryRules(),
  allowedCategories: [],
  sessionMode: 'countdown',
  exitDifficulty: 'easy',
  challengeTimer: null,
  historyFiles: [],
  selectedHistoryFile: null,
  historyContent: '',
  lastCategoryRuleAnchorId: null,
};

const el = (id) => document.getElementById(id);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeCategoryRules(input) {
  const defaults = clone(DEFAULT_CATEGORY_RULES);
  if (!Array.isArray(input) || !input.length) {
    return defaults;
  }

  const list = input
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: String(item.id || `category-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`),
      name: String(item.name || '未命名分类').trim(),
      color: String(item.color || '#38bdf8'),
      pattern: String(item.pattern || '').trim(),
      enabled: item.enabled !== false,
      createdAt: item.createdAt || new Date().toISOString(),
    }))
    .filter((item) => item.name && item.pattern);

  if (!list.length) {
    return defaults;
  }

  defaults.forEach((item) => {
    if (!list.some((rule) => rule.id === item.id)) {
      list.push(clone(item));
    }
  });
  return list;
}

function loadCategoryRules() {
  try {
    const saved = localStorage.getItem('forest-category-rules');
    if (!saved) return clone(DEFAULT_CATEGORY_RULES);
    const parsed = JSON.parse(saved);
    return normalizeCategoryRules(parsed);
  } catch {
    return clone(DEFAULT_CATEGORY_RULES);
  }
}

function persistCategoryRules() {
  localStorage.setItem('forest-category-rules', JSON.stringify(state.categoryRules));
}

function loadLastRules() {
  try {
    const saved = localStorage.getItem('sprout-last-rules');
    if (!saved) return null;
    return JSON.parse(saved);
  } catch {
    return null;
  }
}

function persistLastRules() {
  localStorage.setItem('sprout-last-rules', JSON.stringify({
    allowedWindows: state.allowedWindows,
    allowedCategories: state.allowedCategories,
  }));
}

function reconcileAllowedCategories() {
  const library = new Map(state.categoryRules.map((rule) => [rule.id, rule]));
  state.allowedCategories = state.allowedCategories
    .map((item) => {
      const source = library.get(item.id);
      return source ? clone(source) : null;
    })
    .filter(Boolean);
}

function formatTime(ms) {
  const total = Math.max(0, Math.ceil((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatWhen(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function formatDurationMinutes(minutes) {
  const safe = Math.max(0, Math.round(Number(minutes || 0)));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (hours <= 0) return `${rest} 分钟`;
  if (rest === 0) return `${hours} 小时`;
  return `${hours} 小时 ${rest} 分钟`;
}

function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function summarizeRules() {
  const parts = [];
  if (state.allowedWindows.length) parts.push(`${state.allowedWindows.length} 个窗口`);
  if (state.allowedCategories.length) parts.push(state.allowedCategories.map((c) => c.name).join(', '));
  return parts;
}

function formatContextMeta(current = {}) {
  const parts = [];
  if (current.processName) parts.push(current.processName);
  if (current.windowId != null) parts.push(`窗口 ${current.windowId}`);
  return parts.join(' · ') || '—';
}

function formatContextDetail(current = {}) {
  return current.processPath || '—';
}

function formatContextKind(current = {}) {
  if (current.processName) return '前台窗口';
  return '未检测到前台窗口';
}

function showToast(message, tone = 'normal') {
  const toast = el('toast');
  toast.textContent = message;
  toast.classList.toggle('danger', tone === 'danger');
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function scrollCategoryEditorIntoView() {
  const target = el('category-name-input');
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => target.focus(), 180);
}

function scrollCategoryRuleIntoView(id) {
  if (!id) return;
  const row = document.querySelector(`[data-category-rule-id="${id}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function syncDrawerScrollLock() {
  const anyOpen = ['rules', 'history', 'settings']
    .some((name) => !el(`${name}-drawer-overlay`)?.classList.contains('hidden'));
  document.body.classList.toggle('drawer-open', anyOpen);
}

function openDrawer(name) {
  el(`${name}-drawer-overlay`).classList.remove('hidden');
  syncDrawerScrollLock();
  if (name === 'rules') renderDrawerActiveSummary();
}

function closeDrawer(name) {
  el(`${name}-drawer-overlay`).classList.add('hidden');
  syncDrawerScrollLock();
  if (name === 'rules') {
    renderCompactRuleSummary();
    renderDraftSummary();
  }
}

function switchRulesTab(name) {
  document.querySelectorAll('.drawer-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  ['windows', 'categories'].forEach((tab) => {
    el(`drawer-tab-${tab}`)?.classList.toggle('hidden', tab !== name);
  });
}

function renderDrawerActiveSummary() {
  const container = el('drawer-active-summary');
  if (!container) return;
  container.innerHTML = '';

  const hasAny = state.allowedWindows.length || state.allowedCategories.length;
  if (!hasAny) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = '尚未选择任何规则';
    container.appendChild(p);
    return;
  }

  function addGroup(label, items) {
    if (!items.length) return;
    const row = document.createElement('div');
    row.className = 'drawer-summary-row';
    const lbl = document.createElement('span');
    lbl.className = 'drawer-summary-label';
    lbl.textContent = label;
    row.appendChild(lbl);
    const wrap = document.createElement('div');
    wrap.className = 'drawer-summary-chips';
    items.forEach(({ text, color }) => {
      const chip = document.createElement('span');
      chip.className = 'drawer-summary-chip';
      if (color) {
        const dot = document.createElement('span');
        dot.className = 'color-dot';
        dot.style.background = color;
        chip.appendChild(dot);
      }
      chip.appendChild(document.createTextNode(text));
      wrap.appendChild(chip);
    });
    row.appendChild(wrap);
    container.appendChild(row);
  }

  addGroup('窗口', state.allowedWindows.map((w) => ({ text: w.label || w.initialTitle || w.processName || '未命名窗口' })));
  addGroup('分类', state.allowedCategories.map((c) => ({ text: c.name, color: c.color })));
}

function updateHeroIdleTimer() {
  if (state.sessionMode === 'countup') {
    el('hero-idle-timer').textContent = '00:00';
  } else {
    const minutes = Number(el('duration-minutes')?.value || 25);
    el('hero-idle-timer').textContent = `${String(minutes).padStart(2, '0')}:00`;
  }
}

function renderSessionModeSwitch() {
  const mode = state.sessionMode || 'countdown';
  document.querySelectorAll('#session-mode-switch .mode-switch-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  el('duration-minutes').closest('.duration-picker').classList.toggle('hidden', mode === 'countup');
}

function renderFocusView() {
  const status = state.session?.status || 'idle';
  const headings = { idle: '准备专注', running: '专注中...', completed: '专注完成', cancelled: '专注结束' };
  el('main-heading').textContent = headings[status] || '准备专注';
  el('compact-main-heading').textContent = headings[status] || '准备专注';
  el('live-context-panel').classList.toggle('hidden', status !== 'running');
  el('violations-panel').classList.toggle('hidden', status === 'idle');
  el('edit-rules-btn').classList.toggle('hidden', status === 'running');
  el('compact-context-card').classList.toggle('hidden', status === 'running');
  renderCompactRuleSummary();
}

function renderCompactRuleSummary() {
  const parts = summarizeRules();
  const hasRules = !!(state.allowedWindows.length || state.allowedCategories.length);
  const summaryText = hasRules ? parts.join(' · ') : '尚未配置规则';
  el('rule-summary-text').textContent = summaryText;
  el('compact-rule-summary').textContent = summaryText;

  const chips = el('rule-summary-chips');
  chips.innerHTML = '';
  state.allowedWindows.forEach((w) => {
    chips.appendChild(makeChip(w.label || w.processName || '未命名窗口'));
  });
  state.allowedCategories.forEach((c) => {
    chips.appendChild(makeChip(c.name, { category: true, color: c.color }));
  });

  const startBtn = el('start-session-btn');
  if (startBtn) startBtn.disabled = !hasRules;
  const hint = el('hero-rules-hint');
  if (hint) hint.classList.toggle('hidden', hasRules);
  renderSessionModeSwitch();
}

function renderDraftSummary() {
  el('draft-window-count').textContent = String(state.allowedWindows.length);
  el('draft-category-count').textContent = String(state.allowedCategories.length);
  el('draft-system-safelist').textContent = state.settings?.systemSafelistEnabled === false ? '关' : '开';
  el('compact-draft-window-count').textContent = String(state.allowedWindows.length);
  el('compact-draft-category-count').textContent = String(state.allowedCategories.length);
}

function renderContext(context) {
  state.currentContext = context || state.currentContext;
  const current = state.currentContext || {};
  const title = current.title || '等待检测';
  const meta = formatContextMeta(current);
  const detail = formatContextDetail(current);
  const kind = formatContextKind(current);
  el('context-title').textContent = title;
  el('context-meta').textContent = meta;
  el('context-detail').textContent = detail;
  el('live-context-title').textContent = title;
  el('live-context-meta').textContent = meta;
  el('live-context-detail').textContent = detail;
  el('compact-context-title').textContent = title;
  el('compact-context-meta').textContent = meta;
  el('compact-context-detail').textContent = detail;
  el('compact-context-kind').textContent = kind;
  el('context-json').textContent = JSON.stringify(current, null, 2);
}

function makeChip(label, options = {}) {
  const chip = document.createElement('div');
  chip.className = `chip ${options.category ? 'category-chip' : ''}`.trim();
  if (options.color) {
    chip.style.setProperty('--chip-color', options.color);
  }
  const span = document.createElement('span');
  span.textContent = label;
  chip.appendChild(span);
  if (options.onRemove) {
    const btn = document.createElement('button');
    btn.textContent = '×';
    btn.addEventListener('click', options.onRemove);
    chip.appendChild(btn);
  }
  return chip;
}

function renderAllowedLists() {
  const windowsList = el('windows-list');
  const categoriesList = el('selected-categories-list');
  windowsList.innerHTML = '';
  categoriesList.innerHTML = '';
  el('windows-empty').style.display = state.allowedWindows.length ? 'none' : 'block';
  el('selected-categories-empty').style.display = state.allowedCategories.length ? 'none' : 'block';

  state.allowedWindows.forEach((item) => windowsList.appendChild(makeChip(item.label || item.initialTitle || item.processName || '未命名窗口', {
    onRemove: () => {
      state.allowedWindows = state.allowedWindows.filter((row) => row.id !== item.id);
      renderAllowedLists();
    },
  })));

  state.allowedCategories.forEach((item) => categoriesList.appendChild(makeChip(`${item.name} · ${item.pattern}`, {
    category: true,
    color: item.color,
    onRemove: () => toggleCategorySelection(item.id),
  })));

  persistLastRules();
  renderDraftSummary();
  renderCompactRuleSummary();
  renderDrawerActiveSummary();
}

function renderCategoryRules() {
  const list = el('category-rule-list');
  list.innerHTML = '';
  state.categoryRules.forEach((rule) => {
    const selected = state.allowedCategories.some((item) => item.id === rule.id);
    const row = document.createElement('div');
    row.className = 'rule-row';
    row.dataset.categoryRuleId = rule.id;
    row.innerHTML = `
      <div class="rule-main">
        <div><span class="color-dot" style="background:${rule.color}"></span><strong>${rule.name}</strong></div>
        <p class="muted small">Rule: ${rule.pattern || '—'}</p>
      </div>
      <div class="rule-actions">
        <button class="btn small ${selected ? 'ghost' : 'primary'}" data-action="toggle">${selected ? '移出' : '加入'}</button>
        <button class="btn small ghost" data-action="edit">编辑</button>
        <button class="btn small ghost" data-action="delete">删除</button>
      </div>
    `;
    row.querySelector('[data-action="toggle"]').addEventListener('click', () => toggleCategorySelection(rule.id));
    row.querySelector('[data-action="edit"]').addEventListener('click', () => fillCategoryEditor(rule));
    row.querySelector('[data-action="delete"]').addEventListener('click', () => removeCategoryRule(rule.id));
    list.appendChild(row);
  });
  if (state.lastCategoryRuleAnchorId) {
    requestAnimationFrame(() => scrollCategoryRuleIntoView(state.lastCategoryRuleAnchorId));
    state.lastCategoryRuleAnchorId = null;
  }
}

function renderSystemSafelist(rules = []) {
  const list = el('system-safelist-list');
  list.innerHTML = '';
  rules.forEach((rule) => {
    const row = document.createElement('div');
    row.className = 'rule-row';
    row.innerHTML = `
      <div class="rule-main">
        <h4>${rule.name}</h4>
        <p class="muted small">${rule.description || '系统关键窗口保护'}</p>
        <p class="muted small">进程：${(rule.processPatterns || []).join(' | ') || '—'}</p>
        <p class="muted small">标题：${(rule.titlePatterns || []).join(' | ') || '—'}</p>
      </div>
      <div class="rule-actions"><button class="btn ghost" disabled>默认锁定</button></div>
    `;
    list.appendChild(row);
  });
}

function renderViolations(violations = [], targetId, emptyId) {
  const list = el(targetId);
  list.innerHTML = '';
  const empty = emptyId ? el(emptyId) : null;
  if (empty) empty.style.display = violations.length ? 'none' : 'block';
  if (!violations.length && !emptyId) {
    list.innerHTML = '<div class="empty">本轮没有违规。</div>';
    return;
  }
  violations.slice().reverse().forEach((item) => {
    const row = document.createElement('div');
    row.className = 'timeline-item';
    row.innerHTML = `
      <h4>${item.title || item.processName || '未知窗口'}</h4>
      <p class="muted small">${formatWhen(item.timestamp)} · ${item.reason || '已拦截'}</p>
      <p class="muted small">${item.processPath || '无附加信息'}</p>
    `;
    list.appendChild(row);
  });
}

function renderFocusState(session) {
  const idle = el('focus-state-idle');
  const running = el('focus-state-running');
  const result = el('focus-state-result');
  const resultSummaryGrid = el('result-summary-grid');
  [idle, running, result].forEach((node) => node.classList.remove('active'));
  resultSummaryGrid.classList.add('hidden');

  if (!session || session.status === 'idle') {
    hideExitChallenge();
    el('latest-violation-title').textContent = '暂无';
    el('latest-violation-reason').textContent = '还没有拦截记录。';
    idle.classList.add('active');
    updateHeroIdleTimer();
    return;
  }

  if (session.status === 'running') {
    running.classList.add('active');
    el('running-timer').textContent = session.sessionMode === 'countup'
      ? formatClock(session.elapsedMs)
      : formatTime(session.remainingMs);
    el('running-subtitle').textContent = `${session.sessionMode === 'countup' ? '正计时中' : '正在守住你这轮允许规则'} · 窗口 ${session.allowedWindows.length} 个，分类 ${session.allowedCategories.length} 条`;
    el('metric-violations').textContent = String(session.violationCount || 0);
    el('metric-allowed-windows').textContent = String(session.allowedWindows.length || 0);
    el('metric-allowed-categories').textContent = String(session.allowedCategories.length || 0);
    const latest = (session.violations || []).slice(-1)[0];
    el('latest-violation-title').textContent = latest?.title || latest?.processName || '暂无';
    el('latest-violation-reason').textContent = latest ? `${latest.reason} · ${formatWhen(latest.timestamp)}` : '还没有拦截记录。';
    return;
  }

  hideExitChallenge();
  result.classList.add('active');
  resultSummaryGrid.classList.remove('hidden');
  const summary = session.summary || {};
  const reasonMap = { completed: '倒计时结束', cancelled: '手动结束' };
  const actualDurationMinutes = Number(summary.actualDurationMinutes ?? summary.durationMinutes ?? 0);
  const plannedDurationMinutes = Number(summary.plannedDurationMinutes ?? 0);
  el('result-title').textContent = session.status === 'completed' ? '本轮专注完成' : '本轮专注已结束';
  el('result-subtitle').textContent = `${(summary.primaryCategory?.name || '未分类')} / ${(summary.primaryWindow?.label || summary.primaryWindow?.initialTitle || summary.primaryWindow?.processName || '未记录窗口')}`;
  el('result-duration').textContent = formatDurationMinutes(actualDurationMinutes);
  el('result-violations').textContent = String(summary.violationCount || 0);
  el('result-reason').textContent = reasonMap[summary.completionReason] || '—';
  if (summary.sessionMode !== 'countup' && plannedDurationMinutes && plannedDurationMinutes !== actualDurationMinutes) {
    el('result-subtitle').textContent = `${el('result-subtitle').textContent} · 计划 ${formatDurationMinutes(plannedDurationMinutes)}`;
  }
  const latest = (summary.violations || []).slice(-1)[0];
  el('latest-violation-title').textContent = latest?.title || latest?.processName || '暂无';
  el('latest-violation-reason').textContent = latest ? `${latest.reason} · ${formatWhen(latest.timestamp)}` : '还没有拦截记录。';
}

function renderSummaryLists(summary) {
  const windows = el('result-windows');
  const categories = el('result-categories');
  windows.innerHTML = '';
  categories.innerHTML = '';
  (summary.allowedWindows || []).forEach((item) => windows.appendChild(makeChip(item.label || item.initialTitle || item.processName || '未命名窗口')));
  (summary.allowedCategories || []).forEach((item) => categories.appendChild(makeChip(item.name, { category: true, color: item.color })));
  if (!(summary.allowedWindows || []).length) windows.innerHTML = '<div class="empty">没有窗口规则</div>';
  if (!(summary.allowedCategories || []).length) categories.innerHTML = '<div class="empty">没有分类规则</div>';
}

function renderSession(session) {
  state.session = session;
  if (session?.status === 'running') {
    state.sessionMode = session.sessionMode || state.sessionMode || 'countdown';
  }
  renderContext(session.currentContext);
  renderFocusState(session);
  renderViolations(session.violations || [], 'violations-list', 'violations-empty');
  renderViolations(session.violations || (session.summary?.violations) || [], 'violations-result-list', 'violations-result-empty');
  renderSummaryLists(session.summary || {
    allowedWindows: session.allowedWindows,
    allowedCategories: session.allowedCategories,
  });
  renderFocusView();
}
function fillCategoryEditor(rule) {
  el('category-name-input').value = rule.name || '';
  el('category-pattern-input').value = rule.pattern || '';
  el('category-color-input').value = rule.color || '#a78bfa';
  el('save-category-btn').dataset.editingId = rule.id;
  scrollCategoryEditorIntoView();
  showToast(`正在编辑分类：${rule.name}`);
}

function resetCategoryEditor() {
  el('category-name-input').value = '';
  el('category-pattern-input').value = '';
  el('category-color-input').value = '#e2ebd7';
  delete el('save-category-btn').dataset.editingId;
}

function upsertCategoryRule() {
  const name = el('category-name-input').value.trim();
  const pattern = el('category-pattern-input').value.trim();
  const color = el('category-color-input').value;
  if (!name || !pattern) {
    showToast('分类名和 pattern 都不能为空', 'danger');
    return;
  }

  const editingId = el('save-category-btn').dataset.editingId;
  if (editingId) {
    state.categoryRules = state.categoryRules.map((rule) => rule.id === editingId ? { ...rule, name, pattern, color } : rule);
    state.allowedCategories = state.allowedCategories.map((rule) => rule.id === editingId ? { ...rule, name, pattern, color } : rule);
    state.lastCategoryRuleAnchorId = editingId;
    showToast(`已更新分类：${name}`);
  } else {
    const createdId = `category-${Date.now()}`;
    state.categoryRules = [...state.categoryRules, {
      id: createdId,
      name,
      pattern,
      color,
      enabled: true,
      createdAt: new Date().toISOString(),
    }];
    state.lastCategoryRuleAnchorId = createdId;
    showToast(`已新增分类：${name}`);
  }

  persistCategoryRules();
  reconcileAllowedCategories();
  resetCategoryEditor();
  renderCategoryRules();
  renderAllowedLists();
}

function removeCategoryRule(id) {
  const target = state.categoryRules.find((rule) => rule.id === id);
  state.categoryRules = state.categoryRules.filter((rule) => rule.id !== id);
  state.allowedCategories = state.allowedCategories.filter((rule) => rule.id !== id);
  persistCategoryRules();
  renderCategoryRules();
  renderAllowedLists();
  showToast(`已删除分类：${target?.name || '未命名分类'}`);
}

function toggleCategorySelection(id) {
  const existing = state.allowedCategories.find((rule) => rule.id === id);
  if (existing) {
    state.allowedCategories = state.allowedCategories.filter((rule) => rule.id !== id);
  } else {
    const source = state.categoryRules.find((rule) => rule.id === id);
    if (!source) return;
    state.allowedCategories = [...state.allowedCategories, clone(source)];
  }
  renderCategoryRules();
  renderAllowedLists();
}

function restoreDefaultCategories() {
  state.categoryRules = clone(DEFAULT_CATEGORY_RULES);
  const validIds = new Set(state.categoryRules.map((item) => item.id));
  state.allowedCategories = state.allowedCategories.filter((item) => validIds.has(item.id));
  reconcileAllowedCategories();
  persistCategoryRules();
  resetCategoryEditor();
  renderCategoryRules();
  renderAllowedLists();
  showToast('已恢复默认分类');
}

async function loadSettings() {
  state.settings = await api.getSettings();
  el('history-dir-input').value = state.settings.historyDir || '';
  el('auto-write-history-input').checked = state.settings.autoWriteHistory !== false;
  el('system-safelist-enabled-input').checked = state.settings.systemSafelistEnabled !== false;
  el('exit-difficulty-input').value = state.settings.exitDifficulty || 'easy';
  state.exitDifficulty = state.settings.exitDifficulty || 'easy';
  renderSystemSafelist(state.settings.systemSafelistRules || []);
  renderDraftSummary();
}

async function saveSettings() {
  const patch = {
    historyDir: el('history-dir-input').value.trim() || state.settings?.historyDir || '',
    autoWriteHistory: el('auto-write-history-input').checked,
    systemSafelistEnabled: el('system-safelist-enabled-input').checked,
    exitDifficulty: el('exit-difficulty-input').value,
  };
  state.settings = await api.saveSettings(patch);
  state.exitDifficulty = state.settings.exitDifficulty || 'easy';
  renderSystemSafelist(state.settings.systemSafelistRules || []);
  renderDraftSummary();
  showToast('设置已保存');
  await refreshHistoryFiles();
}

async function refreshHistoryFiles() {
  const files = await api.listHistoryFiles();
  state.historyFiles = files.slice(0, 3);
  if (state.selectedHistoryFile && !state.historyFiles.some((file) => file.fileName === state.selectedHistoryFile)) {
    state.selectedHistoryFile = null;
  }
  const list = el('history-files-list');
  list.innerHTML = '';
  el('history-files-empty').style.display = state.historyFiles.length ? 'none' : 'block';
  state.historyFiles.forEach((file) => {
    const row = document.createElement('div');
    row.className = `history-file ${state.selectedHistoryFile === file.fileName ? 'active' : ''}`;
    const btn = document.createElement('button');
    btn.innerHTML = `<h4>${file.fileName}</h4><p class="muted small">${formatWhen(file.modifiedAt)}</p>`;
    btn.addEventListener('click', () => loadHistoryFile(file.fileName));
    const openBtn = document.createElement('button');
    openBtn.className = 'history-open-btn';
    openBtn.type = 'button';
    openBtn.title = '打开这个 Markdown 文件';
    openBtn.setAttribute('aria-label', `打开 ${file.fileName}`);
    openBtn.textContent = '↗';
    openBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await api.openHistoryFile(file.fileName);
    });
    row.appendChild(btn);
    row.appendChild(openBtn);
    list.appendChild(row);
  });

  if (!state.selectedHistoryFile && state.historyFiles.length) {
    await loadHistoryFile(state.historyFiles[0].fileName);
  }
}

async function loadHistoryFile(fileName) {
  const payload = await api.readHistoryFile(fileName);
  state.selectedHistoryFile = payload.fileName;
  state.historyContent = payload.content;
  el('history-preview-title').textContent = payload.fileName;
  el('history-preview').textContent = payload.content;
  document.querySelectorAll('.history-file').forEach((node) => {
    node.classList.toggle('active', node.textContent.includes(payload.fileName));
  });
}

async function refreshCurrentContext(showTip = false) {
  if (!api) return;
  try {
    const context = await api.getCurrentContext();
    renderContext(context);
    if (showTip) {
      showToast('已刷新当前上下文');
    }
  } catch (error) {
    if (showTip) {
      showToast(error.message || '刷新失败', 'danger');
    }
  }
}

async function refreshInitialState() {
  if (!api) {
    showToast('preload 注入失败', 'danger');
    return;
  }

  const lastRules = loadLastRules();
  if (lastRules) {
    state.allowedWindows = lastRules.allowedWindows || [];
    state.allowedCategories = lastRules.allowedCategories || [];
    reconcileAllowedCategories();
  }

  try {
    const [session, context] = await Promise.all([api.getState(), api.getCurrentContext()]);
    if (session?.status === 'running') {
      state.sessionMode = session.sessionMode || state.sessionMode || 'countdown';
    }
    renderSession(session);
    renderContext(context);
    renderAllowedLists();
    renderCategoryRules();
    await loadSettings();
    await refreshHistoryFiles();
  } catch (error) {
    console.error(error);
    showToast('初始化状态失败，请稍后重试', 'danger');
  }
}

async function handleCaptureWindow() {
  try {
    const payload = await api.captureCurrentWindow();
    const allowance = payload.allowance;
    if (state.allowedWindows.some((item) => item.windowId === allowance.windowId)) {
      showToast('这个窗口已经在允许列表里了');
      return;
    }
    state.allowedWindows.push(allowance);
    renderAllowedLists();
    renderContext(payload.context);
    showToast(`已加入：${allowance.label}`);
  } catch (error) {
    showToast(error.message || '加入窗口失败', 'danger');
  }
}

async function handleStartSession() {
  const durationMinutes = state.sessionMode === 'countdown'
    ? Number(el('duration-minutes').value || 25)
    : 0;
  if (!state.allowedWindows.length && !state.allowedCategories.length) {
    showToast('至少要有一个允许窗口或分类', 'danger');
    return;
  }

  try {
    persistLastRules();
    const session = await api.startSession({
      sessionMode: state.sessionMode,
      durationMinutes,
      allowedWindows: state.allowedWindows,
      allowedCategories: state.allowedCategories,
      exitProtection: { type: 'typing' },
    });
    renderSession(session);
    showToast('专注已开始');
  } catch (error) {
    showToast(error.message || '开始专注失败', 'danger');
  }
}

async function stopSession() {
  try {
    const session = await api.endSession({ reason: 'cancelled' });
    renderSession(session);
    await refreshHistoryFiles();
    showToast('已结束本轮专注');
  } catch (error) {
    showToast(error.message || '结束专注失败', 'danger');
  }
}

async function backToRules() {
  const summary = state.session?.summary || {};
  state.allowedWindows = clone(summary.allowedWindows || state.allowedWindows);
  state.allowedCategories = clone(summary.allowedCategories || state.allowedCategories);
  state.sessionMode = summary.sessionMode || state.sessionMode || 'countdown';
  try {
    const idle = await api.resetSession();
    renderSession(idle);
    state.sessionMode = summary.sessionMode || state.sessionMode || 'countdown';
    updateHeroIdleTimer();
    renderSessionModeSwitch();
    renderAllowedLists();
    renderCategoryRules();
    showToast('规则已保留，可以开始新专注');
  } catch (error) {
    console.error(error);
    showToast(error.message || '重置失败', 'danger');
  }
}

const CHALLENGE_MEDIUM_BASE = '23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz`-=[]/.,:;<>?!@#$%^&*()_+\'"';
const CHALLENGE_HARD_POOL = '龘靐齉齾爩鱻麤龗灪龖厵滟爨癵籱饢驫鸜麷顟顠饙騳饐';

function generateChallenge(difficulty) {
  if (difficulty === 'hard') {
    let s = '';
    while (s.length < 3) {
      const ch = CHALLENGE_HARD_POOL[Math.floor(Math.random() * CHALLENGE_HARD_POOL.length)];
      if (!s.includes(ch)) s += ch;
    }
    return { phrase: s, seconds: 15 };
  }
  if (difficulty === 'medium') {
    const len = 8 + Math.floor(Math.random() * 3);
    let s = '';
    for (let i = 0; i < len; i += 1) {
      s += CHALLENGE_MEDIUM_BASE[Math.floor(Math.random() * CHALLENGE_MEDIUM_BASE.length)];
    }
    return { phrase: s, seconds: 20 };
  }
  return { phrase: '我要暂停专注', seconds: 20 };
}

function showExitChallenge() {
  if (state.session?.status !== 'running') return;
  const { phrase, seconds } = generateChallenge(state.exitDifficulty || 'easy');
  el('challenge-phrase').textContent = phrase;
  el('challenge-input').value = '';
  el('challenge-error').classList.add('hidden');
  el('challenge-countdown').textContent = seconds;
  el('challenge-confirm-btn').disabled = false;
  el('exit-challenge-overlay').classList.remove('hidden');
  el('challenge-input').focus();

  let remaining = seconds;
  if (state.challengeTimer) clearInterval(state.challengeTimer);
  state.challengeTimer = setInterval(() => {
    remaining -= 1;
    el('challenge-countdown').textContent = remaining;
    if (remaining <= 0) {
      clearInterval(state.challengeTimer);
      state.challengeTimer = null;
      el('challenge-confirm-btn').disabled = true;
      el('challenge-error').textContent = '时间到，请重新尝试。';
      el('challenge-error').classList.remove('hidden');
    }
  }, 1000);
}

function hideExitChallenge() {
  el('exit-challenge-overlay').classList.add('hidden');
  if (state.challengeTimer) {
    clearInterval(state.challengeTimer);
    state.challengeTimer = null;
  }
  el('challenge-confirm-btn').disabled = false;
}

async function confirmExitChallenge() {
  if (el('challenge-confirm-btn').disabled) {
    el('challenge-error').textContent = '时间到，请重新尝试。';
    el('challenge-error').classList.remove('hidden');
    return;
  }
  const phrase = el('challenge-phrase').textContent;
  const input = el('challenge-input').value;
  if (input !== phrase) {
    el('challenge-error').textContent = '内容不匹配，请重新输入。';
    el('challenge-error').classList.remove('hidden');
    el('challenge-input').value = '';
    el('challenge-input').focus();
    return;
  }
  hideExitChallenge();
  await stopSession();
}
function bindEvents() {
  el('edit-rules-btn').addEventListener('click', () => openDrawer('rules'));
  el('close-rules-drawer').addEventListener('click', () => closeDrawer('rules'));
  el('open-history-btn').addEventListener('click', () => {
    openDrawer('history');
    refreshHistoryFiles();
  });
  el('compact-open-history-btn').addEventListener('click', () => {
    openDrawer('history');
    refreshHistoryFiles();
  });
  el('close-history-drawer').addEventListener('click', () => closeDrawer('history'));
  el('open-settings-btn').addEventListener('click', () => openDrawer('settings'));
  el('compact-open-settings-btn').addEventListener('click', () => openDrawer('settings'));
  el('close-settings-drawer').addEventListener('click', () => closeDrawer('settings'));

  ['rules', 'history', 'settings'].forEach((name) => {
    el(`${name}-drawer-overlay`).addEventListener('click', (event) => {
      if (event.target === el(`${name}-drawer-overlay`)) closeDrawer(name);
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      ['rules', 'history', 'settings'].forEach((name) => {
        if (!el(`${name}-drawer-overlay`).classList.contains('hidden')) closeDrawer(name);
      });
    }
  });

  document.querySelectorAll('.drawer-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchRulesTab(btn.dataset.tab));
  });

  el('capture-window-btn').addEventListener('click', handleCaptureWindow);
  el('save-category-btn').addEventListener('click', upsertCategoryRule);
  el('restore-default-categories-btn').addEventListener('click', restoreDefaultCategories);

  el('start-session-btn').addEventListener('click', handleStartSession);
  el('back-to-rules-btn').addEventListener('click', backToRules);
  el('duration-minutes').addEventListener('input', updateHeroIdleTimer);
  document.querySelectorAll('#session-mode-switch .mode-switch-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.sessionMode = btn.dataset.mode === 'countup' ? 'countup' : 'countdown';
      updateHeroIdleTimer();
      renderSessionModeSwitch();
    });
  });

  el('refresh-context-btn').addEventListener('click', () => refreshCurrentContext(true));

  el('refresh-history-btn').addEventListener('click', refreshHistoryFiles);
  el('open-history-dir-btn').addEventListener('click', async () => {
    await api.openHistoryDirectory();
  });

  el('save-settings-btn').addEventListener('click', saveSettings);

  el('exit-challenge-btn').addEventListener('click', showExitChallenge);
  el('challenge-cancel-btn').addEventListener('click', hideExitChallenge);
  el('challenge-confirm-btn').addEventListener('click', confirmExitChallenge);
  el('challenge-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') confirmExitChallenge();
  });

  if (!api) return;
  api.subscribeState(async (session) => {
    const previousStatus = state.session?.status;
    renderSession(session);
    if (previousStatus === 'running' && (session.status === 'completed' || session.status === 'cancelled')) {
      await refreshHistoryFiles();
    }
  });
  api.subscribeViolation((violation) => {
    showToast(`已拦截：${violation.title || violation.processName || '未知窗口'}`, 'danger');
  });
}

bindEvents();
renderFocusView();
renderAllowedLists();
renderCategoryRules();
refreshInitialState();
setInterval(() => {
  if (state.session?.status !== 'running') {
    refreshCurrentContext(false);
  }
}, 4000);
