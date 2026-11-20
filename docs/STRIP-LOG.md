# 从 fortune-ball 剥离清单（S0 记录）

> 目的：让「剥离了什么、留下了什么」可追溯，防止以后把领域代码重新粘回来。
> 后续里程碑见 [`ROADMAP.md`](ROADMAP.md)；工程全貌见 [`../AGENTS.md`](../AGENTS.md)。

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

## 残留清理记录（2026-11-20 完成）

剥离时只改了主题色与文案，以下领域痕迹在 S0 收尾时一并清除：

| 残留 | 处理 |
|---|---|
| `ball.js` 的 `setMood()`（「5→大笑…1→哭」的运势分值表情位） | 删除；情绪表现留给 S1 的 `petState` |
| `ball.js` 的 `applyPersona()` 白名单 `['cat','dog','caishen','lots']` | 收敛为猫；旧 store 值自动回落 |
| `index.html` 的狗 / 财神 / 签筒 SVG 与 `lots-stage` / `caishen-stage` | 删除 |
| `ball.css` 的形象专属样式、抽签 / 财神 / 蓄力 / 爆破动画段 | 删除 |
| `src/js/fx.js`（抽签全屏粒子）与 `#fx` 画布 | 删除 |
| `settings.html` 的四形象下拉 | 收敛为「团子猫」 |
| `ball.js` 的 `setColor / hexToRgb / rgbToHex`（运势幸运色驱动） | 删除；配色改由 `tokens.css` 驱动 |
| `ball.js` 的 `resetBallToOriginal`（引用未定义变量，运行时抛错） | 删除 |
| `agentChat.scene` / `agentScene`（运势场景） | 删除 |
| `package.json` 的 `fortune` 关键词 | 替换为 `desktop-pet` / `companion` |
| 构建配置中不存在的 `.persona-anim.js` / `.stick-shot.js` 忽略项 | 删除 |

**保留**：`src/js/detector.js`（日志错误分级，壳层可观测性，与运势无关）。

## 验证

- `npm test` → smoke-test 21 通过 + `check:core` 通过
- 启动应用：协议页 → 主界面，托盘菜单、拖拽、位置持久化、设置面板正常
- `npm run build:public` / `build:personal` 产出不同资产名
