import { matchSystemSafelist } from './system-safelist.js';

export function isInternalForestWindow(context) {
  if (context?.processId && Number(context.processId) === process.pid) {
    return true;
  }
  const label = `${context.processName ?? ''} ${context.processPath ?? ''} ${context.title ?? ''}`.toLowerCase();
  return label.includes('sprout');
}

export function decideContext({ context, allowedWindows = [], allowedCategories = [], systemSafelistEnabled }) {
  if (!context?.windowId) {
    return {
      allowed: true,
      reason: '未检测到有效前台窗口',
      matchedWindow: null,
      matchedCategory: null,
      matchedSystemRule: null,
    };
  }

  if (isInternalForestWindow(context)) {
    return {
      allowed: true,
      reason: 'Sprout 自身界面允许前台显示',
      matchedWindow: null,
      matchedCategory: null,
      matchedSystemRule: null,
    };
  }

  const matchedSystemRule = matchSystemSafelist(context, systemSafelistEnabled);
  if (matchedSystemRule) {
    return {
      allowed: true,
      reason: `命中系统安全白名单 ${matchedSystemRule.name}`,
      matchedWindow: null,
      matchedCategory: null,
      matchedSystemRule,
    };
  }

  const matchedWindow = allowedWindows.find((rule) => windowMatches(rule, context));
  if (matchedWindow) {
    return {
      allowed: true,
      reason: '当前窗口命中允许列表',
      matchedWindow,
      matchedCategory: null,
      matchedSystemRule: null,
    };
  }

  const matchedCategory = allowedCategories.find((rule) => categoryMatches(rule, context));
  if (matchedCategory) {
    return {
      allowed: true,
      reason: `命中分类规则 ${matchedCategory.name}`,
      matchedWindow: null,
      matchedCategory,
      matchedSystemRule: null,
    };
  }

  return {
    allowed: false,
    reason: '当前窗口不在允许列表中，也未命中分类规则',
    matchedWindow: null,
    matchedCategory: null,
    matchedSystemRule: null,
  };
}

function windowMatches(rule, context) {
  if (!rule || !context) {
    return false;
  }

  if (rule.windowId != null && context.windowId != null && rule.windowId === context.windowId) {
    return true;
  }

  const samePath = Boolean(rule.processPath && context.processPath && rule.processPath.toLowerCase() === context.processPath.toLowerCase());
  const sameTitle = Boolean(rule.initialTitle && context.title && rule.initialTitle.trim() === context.title.trim());
  return samePath && sameTitle;
}

function categoryMatches(rule, context) {
  if (!rule?.enabled || !rule.pattern) {
    return false;
  }

  const haystack = [
    context.title,
    context.processName,
    context.processPath,
  ]
    .filter(Boolean)
    .join(' || ');

  if (!haystack) {
    return false;
  }

  try {
    return new RegExp(rule.pattern, 'i').test(haystack);
  } catch {
    return rule.pattern
      .split('|')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean)
      .some((token) => haystack.toLowerCase().includes(token));
  }
}
