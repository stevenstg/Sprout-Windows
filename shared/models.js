export function createEmptyActiveContext() {
  return {
    timestamp: new Date().toISOString(),
    source: 'windows',
    title: '',
    windowId: null,
    processId: null,
    processName: '',
    processPath: '',
    confidence: 0,
  };
}

export function createInitialSessionState() {
  return {
    status: 'idle',
    startedAt: null,
    endsAt: null,
    durationMinutes: 25,
    remainingMs: 0,
    violationCount: 0,
    violations: [],
    allowedWindows: [],
    allowedCategories: [],
    systemSafelistEnabled: true,
    recentAllowedWindow: null,
    currentContext: createEmptyActiveContext(),
    exitProtection: {
      type: 'hold',
      holdToExitMs: 3000,
    },
    summary: null,
  };
}

export function createSystemSafelistRule({
  id,
  name,
  description = '',
  processPatterns = [],
  titlePatterns = [],
  enabled = true,
} = {}) {
  return {
    id: id || `system-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: name || '未命名系统规则',
    description,
    processPatterns,
    titlePatterns,
    enabled,
  };
}

export function getDefaultSystemSafelistRules() {
  return [
    createSystemSafelistRule({
      id: 'system-explorer',
      name: '资源管理器与任务栏',
      description: '放行 explorer.exe 承载的资源管理器、任务栏、开始菜单、系统托盘等壳窗口。',
      processPatterns: ['C:\\Windows\\explorer.exe', 'explorer.exe'],
    }),
    createSystemSafelistRule({
      id: 'system-shell-hosts',
      name: '开始菜单与系统壳宿主',
      description: '放行 ShellExperienceHost、StartMenuExperienceHost、SearchHost 等系统壳进程。',
      processPatterns: ['ShellExperienceHost.exe', 'StartMenuExperienceHost.exe', 'SearchHost.exe', 'SearchApp.exe'],
    }),
    createSystemSafelistRule({
      id: 'system-lock-screen',
      name: '锁屏与登录界面',
      description: '放行 LockApp 和登录相关系统界面。',
      processPatterns: ['LockApp.exe', 'LogonUI.exe'],
      titlePatterns: ['Windows 默认锁屏界面', '锁屏'],
    }),
    createSystemSafelistRule({
      id: 'system-settings-security',
      name: '系统设置与安全弹窗',
      description: '放行系统设置、UAC、安全与凭据确认相关窗口。',
      processPatterns: ['SystemSettings.exe', 'consent.exe', 'CredentialUIBroker.exe', 'SecurityHealthSystray.exe', 'taskmgr.exe'],
      titlePatterns: ['用户帐户控制', 'Windows 安全', '凭据', '安全'],
    }),
    createSystemSafelistRule({
      id: 'system-dialogs',
      name: '文件选择与系统对话框',
      description: '放行常见打开、保存、浏览文件夹、通知和系统对话框。',
      titlePatterns: ['打开', '另存为', '保存为', '选择文件', '浏览文件夹', '选择文件夹', '通知', '系统托盘溢出窗口'],
    }),
    createSystemSafelistRule({
      id: 'system-screenshot',
      name: '截图工具',
      description: '放行 Windows 截图工具（截图和草图、Snipping Tool）及截图相关覆盖层。',
      processPatterns: ['SnippingTool.exe', 'ScreenSketch.exe', 'ScreenClippingHost.exe'],
      titlePatterns: ['截图和草图', 'Snipping Tool', '截图工具', 'Screen Snip'],
    }),
  ];
}

export function createCategoryRule({
  id,
  name,
  color = '#38bdf8',
  pattern = '',
  enabled = true,
  createdAt,
} = {}) {
  return {
    id: id || `category-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: name || '未命名分类',
    color,
    pattern: String(pattern || '').trim(),
    enabled,
    createdAt: createdAt || new Date().toISOString(),
  };
}

export function getDefaultCategoryRules() {
  return [
    createCategoryRule({ id: 'cat-programming', name: 'Programming', color: '#4ade80', pattern: 'Visual Studio Code|PyCharm|WebStorm|vim|Spyder|Ghidra|SciTE|Cursor' }),
    createCategoryRule({ id: 'cat-ai', name: 'AI', color: '#a78bfa', pattern: 'WindowsTerminal|PowerShell|cmd|Claude|Codex|Copilot|ChatGPT|Gemini' }),
    createCategoryRule({ id: 'cat-notes', name: 'Notes', color: '#f472b6', pattern: 'Obsidian|Typora|OneNote|Notion|Logseq' }),
    createCategoryRule({ id: 'cat-paper', name: 'Paper', color: '#38bdf8', pattern: 'Zotero|Acrobat|SumatraPDF|论文' }),
    createCategoryRule({ id: 'cat-office', name: 'Office', color: '#fb923c', pattern: 'Word|Excel|PowerPoint|WPS' }),
    createCategoryRule({ id: 'cat-creative', name: 'Creative', color: '#f43f5e', pattern: 'Photoshop|GIMP|Inkscape|Premiere|剪映|Figma' }),
    createCategoryRule({ id: 'cat-comms', name: 'Comms', color: '#67e8f9', pattern: '微信|WeChat|QQ|Slack|Teams|Discord|Telegram|飞书|Zoom' }),
  ];
}

export function buildWindowAllowanceFromContext(context) {
  return {
    id: `win-${context.windowId}-${Date.now()}`,
    label: context.title || context.processName || '未命名窗口',
    processPath: context.processPath || '',
    processName: context.processName || '',
    initialTitle: context.title || '',
    windowId: context.windowId ?? null,
    createdAt: new Date().toISOString(),
  };
}

export function formatRemaining(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatDurationMinutes(totalMinutes = 0) {
  const minutes = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) {
    return `${rest} 分钟`;
  }

  if (rest === 0) {
    return `${hours} 小时`;
  }

  return `${hours} 小时 ${rest} 分钟`;
}
