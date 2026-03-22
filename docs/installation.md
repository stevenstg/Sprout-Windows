# Installation

## 依赖

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | 18+ | 运行时 |
| Git | 任意 | 克隆仓库 |

## 安装与启动
```bash
git clone https://github.com/stevenstg/Sprout-Windows.git
cd Sprout-Windows
npm install
npm start
```

开发检查：
```bash
npm run check
```

## 文件位置
```
%APPDATA%\sprout\settings.json             # 设置文件
%DOCUMENTS%\Sprout\history\YYYY-MM-DD.md  # 历史记录
```

分类规则和上次选中的规则存储在 Electron 本地存储中，不在项目目录里。

## 常见问题

**启动时报历史目录相关错误**：检查 `%APPDATA%\sprout\settings.json` 里的 `historyDir` 字段，空字符串会导致启动失败。删掉这个文件可以恢复默认设置。