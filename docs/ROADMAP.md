# 从 fortune-ball 剥离清单（S0 记录）

> 目的：让「剥离了什么、留下了什么」可追溯，防止以后把领域代码重新粘回来。

## 留下（陪伴壳，本仓库拥有）

| 来源文件 | 说明 |
|---|---|
| `main.js` 窗口创建 / 生命周期 / 托盘 / 单实例 / 协议同意 / 法律窗口 / 设置窗口 / AI 浮窗 | 去掉运势分支后保留 |
| `main.js` 光标轮询与点击穿透、位置持久化、托盘菜单 | 原样保留 |
| `preload.js` | 白名单收敛到 24 个 IPC |
| `src/js/ball.js` | 拖拽 / 位置同步 / 菜单开合 / hit-region；去掉抽签与运势表情 |
| `src/js/agent.js` | 多轮对话循环；去掉 8 个运势工具与场景 |
| `src/js/ai.js` | callLLM / 连接测试 / 日志诊断；去掉运势解读 prompt |
| `logger / rendererLogger / selfCheck / watcher / localLLM / onlineConfig / detector / fx` | 原样保留 |
| `settings.js/html`、`consent.html`、`legal.html`、`legal-data.js` | 改写文案，机制不变 |
| `electron-builder*.yml`、`scripts/*`、Pages 流水线 | 改名 + 改 repo |

## 移除（运势领域，仍留在 fortune-ball）

- `fortune.js`、`almanac.js`、`lunar.js`、`astro.js`、`canon.js`
- `card.js` / `card.html`（5 种运势卡渲染器）
- `fortuneSpirit.js`、`streak.js`、`behavior.js`、`petPanel.js` / `petPanel.html`
- `scenarios/`、`data/`（签文、塔罗、宜忌、颜色、吉言、时辰提点、生肖干支）
- `data/canon/`、`scripts/build-canon-index.js`、`scripts/fetch-canon.js`

## 改名（防止两个应用互相干扰）

| 项 | fortune-ball | companion-ball |
|---|---|---|
| appId / AppUserModelId | `com.fortune.ball` | `com.companion.ball` |
| 单实例锁 | 全局互斥 | 独立（已随 appId 区分） |
| userData / 日志目录 | `%APPDATA%/fortune-ball` | `%APPDATA%/companion-ball` |
| productName | fortune-ball | companion-ball |
| 安装/快捷方式名 | 今日运势 | 桌面陪伴 |
| GitHub repo | CQL111/desktop-icon | CQL111/companion-ball |

## 验证

- `node smoke-test.js` → 21 通过
- 启动应用：协议页 → 主界面，托盘菜单、拖拽、位置持久化、设置面板正常
- `npm run build:public` / `build:personal` 产出不同资产名
