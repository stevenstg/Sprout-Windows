<div align="center">

<img src="app/icon.svg" width="64" />

# Sprout

**开始倒计时，专注之外的窗口一律消失。**

*界面设计参考 [网费很贵](https://github.com/sheepzh/time-tracker-4-browser) · 浏览器感知依赖 [ActivityWatch](https://github.com/ActivityWatch/activitywatch) · 社区 [linux.do](https://linux.do)*

[![Platform](https://img.shields.io/badge/platform-Windows-0078D4?logo=windows)](https://github.com/stevenstg/Sprout-Windows)
[![Electron](https://img.shields.io/badge/Electron-41-47848F?logo=electron)](https://www.electronjs.org/)
[![ActivityWatch](https://img.shields.io/badge/ActivityWatch-optional-orange)](https://activitywatch.net/)
[![License](https://img.shields.io/badge/license-ISC-green)](LICENSE)

[![Node](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=nodedotjs)](https://nodejs.org/)
[![active--win](https://img.shields.io/badge/active--win-window%20detection-blue)](https://github.com/sindresorhus/active-win)
[![node--window--manager](https://img.shields.io/badge/node--window--manager-minimize%20%2F%20restore-blue)](https://github.com/sentialx/node-window-manager)

</div>

![Before / After Sprout](docs/preview.jpg)

---

---

## 它做什么

每次专注会话开始后，Sprout 的守卫进程每 350ms 检查一次前台窗口。如果当前窗口不在你的白名单里，它会立刻把该窗口最小化，并把你拉回到上一个允许的窗口。每次拦截都会计入违规记录，会话结束后生成 Markdown 摘要写入历史目录。

**放行规则支持三种维度：**

| 维度 | 说明 |
|------|------|
| 窗口 | 把目标窗口切到前台，点击"加入当前窗口"，按进程路径识别 |
| 域名 | 输入域名或完整 URL，支持精确匹配或包含子域名两种模式 |
| 分类 | 用正则或 `\|` 分隔关键词，命中标题 / 进程名 / 路径 / 域名即放行 |

---

## 依赖 ActivityWatch

Sprout 本身**不采集**任何数据。浏览器域名识别功能依赖本机运行的 [ActivityWatch](https://github.com/ActivityWatch/activitywatch) 服务（`http://127.0.0.1:5600`）及其浏览器扩展上报的标签页事件。

- **已连接 AW**：浏览器按当前标签页的域名判断是否放行
- **未连接 AW**：浏览器退化为整窗口级别判断（无法区分标签页）

ActivityWatch 不是强依赖，没有它软件依然可以正常运行，只是浏览器粒度更粗。

---

## 快速开始

### 前置要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| [Node.js](https://nodejs.org/) | 18 以上 | 运行时 |
| [Git](https://git-scm.com/) | 任意 | 克隆仓库 |
| [ActivityWatch](https://activitywatch.net/) | 最新版 | 可选，用于浏览器标签页感知 |

> ActivityWatch 需要同时安装对应的浏览器扩展（[Chrome](https://chrome.google.com/webstore/detail/activitywatch-web-watcher/nglaklhklhcoonedhgnpgddginnjdadi) / [Firefox](https://addons.mozilla.org/en-US/firefox/addon/aw-watcher-web/)）才能上报标签页数据。

### 安装与运行

```bash
# 1. 克隆仓库
git clone https://github.com/stevenstg/Sprout-Windows.git
cd Sprout-Windows

# 2. 安装依赖
npm install

# 3. 启动
npm start
```

### 推荐顺序

1. 启动 ActivityWatch（后台运行即可）
2. 在浏览器安装 ActivityWatch Web Watcher 扩展
3. 启动 Sprout，侧边栏 AW 状态变为"已连接"即表示域名感知生效

---

## 界面结构

```
┌──────────────┬────────────────────────────────────┐
│  侧边栏       │  主区域                              │
│              │                                    │
│  AW 状态      │  计时器（倒计时 / 运行中 / 结束）       │
│  前台上下文    │                                    │
│  规则摘要      │  当前规则摘要 + [编辑规则]             │
│              │                                    │
│  ──────────  │  违规时间线（运行中显示）               │
│  📋 历史      │  结果统计（结束后显示）                 │
│  ⚙ 设置       │                                    │
└──────────────┴────────────────────────────────────┘
```

规则、历史、设置分别以右侧抽屉形式打开，不打断主界面。

---

## 退出保护

会话运行中点击"结束专注"会弹出打字验证（默认短语 `我要暂停专注`），防止冲动退出。难度可在设置中调整：

- **简单** — 固定短语
- **中等** — 随机符号串（8-10 位）
- **困难** — 生僻汉字（3 字）

---

## 系统安全白名单

内置规则自动放行 Windows 关键系统窗口，避免误拦截：

- 资源管理器、任务栏、开始菜单
- 锁屏 / 登录界面
- UAC、系统设置、任务管理器
- 文件选择对话框
- 截图工具（Snipping Tool）

---

## 历史记录

每次会话结束后自动生成 Markdown 文件，默认路径：

```
%DOCUMENTS%\Sprout\history\YYYY-MM-DD.md
```

可在设置中修改目录，或手动点击"打开历史目录"。

---

## 技术栈

- **Electron** — 桌面外壳
- **Node.js 子进程** — 守卫逻辑与主窗口隔离，关闭窗口后仍持续运行
- **ActivityWatch REST API** — 浏览器域名上下文感知
- **node-window-manager** — 窗口最小化 / 恢复
- **active-win** — 前台窗口检测
