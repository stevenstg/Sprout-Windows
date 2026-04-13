# Installation

## 直接安装（推荐）

从 Releases 下载 `Sprout Setup 1.1.0.exe`，双击安装即可运行，无需 Node.js。

也可下载 `win-unpacked` 目录，直接运行其中的 `Sprout.exe`（便携版，免安装）。

## 从源码运行

### 依赖

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | 18+ | 运行时 |
| Git | 任意 | 克隆仓库 |

### 安装与启动
```bash
git clone https://github.com/stevenstg/Sprout-Focus-Windows.git
cd Sprout-Focus-Windows
npm install
npm start
```

开发检查：
```bash
npm run check
```

## 文件位置
```
%LOCALAPPDATA%\Sprout\user-data\settings.json  # 设置文件
%DOCUMENTS%\Sprout\history\YYYY-MM-DD.md  # 历史记录
```

分类规则和上次选中的规则存储在 Electron 本地存储中，不在项目目录里。

## 常见问题

**启动时报历史目录相关错误**：检查 `%LOCALAPPDATA%\Sprout\user-data\settings.json` 里的 `historyDir` 字段，空字符串会导致启动失败。删掉这个文件可以恢复默认设置。
