# 工程交接文档（给下一个 Agent）

> 给 AI 协作者 / 开发者的工程速查。读完即可继续编辑。
> 来源与剥离清单见 `docs/ROADMAP.md`；本项目从 `fortune-ball` v1.3.0 复制壳层后独立演进。

## 一、这是什么

**桌面陪伴 · 团子猫** —— Windows 桌面 Electron 陪伴角色（当前 S0）。

- 80×80 内联 SVG 团子猫常驻桌角，可拖拽、位置记忆、贴边自动翻转菜单
- 点击猫 / 快捷键 `Ctrl+Alt+F` / 托盘「聊聊天」→ 打开 AI 对话浮窗（多轮）
- 托盘：显示/隐藏、聊天、设置、开机自启、桌面形象、重置位置、日志
- 没有运势、黄历、卡片、精灵

**首次启动协议同意**：`AGREEMENT_VERSION` 与 store 的 `consentVersion` 比较，不一致时先开
`src/consent.html`（不创建主窗口），同意后 `app.emit('consent-accepted')` 再走正常启动；
未同意关窗即退出。改协议内容时版本 +1。

**法律文档**：源文件 `docs/legal/*.md`，`npm run build:legal`（挂在 prebuild）生成
`src/legal-data.js`；`src/legal.html?doc=privacy|terms|disclaimer|thirdparty` 渲染。

**两套构建**：`electron-builder.key.yml`（内置 Key，`out/`）、`electron-builder.public.yml`
（不带 Key，`out-public/`）、`electron-builder.yml`（默认）。`.gitignore` 只忽略
`build/bundled-ai.json`，`build/entitlements.mac.plist` 需入库。

**三种 Key 来源**：设置面板 `store.aiConfig.token`（user）/ `.env`（env）/ 构建内置
`resources/bundled-ai.json`（bundled），由 `onlineConfig.resolve(saved,{preferEnv})` 决定。
开发态 `!app.isPackaged` 时 `.env` 优先，发布版设置面板优先。

**AI 对话链路**：`aiInput.js`（浮窗）→ `ai-interpret-ask` IPC → `main.js` 的 `withAiFallback`
→ `agent.runAgent`（多轮、按用户轮裁剪）→ `ai.callLLM`（DeepSeek / Ollama 兼容）。
**S0 没有工具调用**：`agent.TOOLS = []`，`executeTool` 返回 `NO_TOOLS`；S2 接入人格/记忆时再扩展。

**硬约束**：
- 猫身热区是主进程 `BALL_HALO=40` 的矩形；菜单打开时渲染端必须 `window.api.setHitRegion(rect)`
  上报「猫 + 面板」外接矩形（主进程换算屏幕坐标），否则面板点不到
- 装饰层一律 `pointer-events:none`
- 动画只能动 `.ball-inner`/SVG 分组，**绝不能动 `.ball` 的 transform**（位置由 `setBallTransform` 写）
- 高频通道 `update-ball-pos` 不写日志，400ms 合并落盘
- 球位置是浮点，传给 Electron `setPosition` 前必须 `Math.round`

## 二、应用标识（与 fortune-ball 必须区分）

| 项 | 值 |
|---|---|
| appId / AppUserModelId | `com.companion.ball` |
| 单实例锁 | 独立（由 appId 派生，互不影响） |
| userData / 日志 | `%APPDATA%/companion-ball` |
| productName | companion-ball |
| 安装 / 快捷方式名 | 桌面陪伴 |
| 仓库 | CQL111/companion-ball |
| Pages | https://cql111.github.io/companion-ball/ （master `/docs`） |

**改这些标识会导致：** 用户配置丢失、与 fortune-ball 互相抢占单实例、Windows 通知归组冲突、
Release 资产同名覆盖。不要随手改。

## 三、文件结构 + 职责

| 路径 | 职责 |
|---|---|
| `main.js` | 主进程（~1.1k 行）：窗口、托盘、IPC、位置、点击穿透轮询、日志、自检 |
| `preload.js` | IPC 白名单（24 个 invoke + 事件订阅） |
| `src/index.html` + `js/ball.js` | 主窗口：团子猫 SVG、拖拽、菜单、hit-region |
| `src/aiInput.html` + `js/aiInput.js` | AI 对话浮窗 |
| `src/settings.html` + `js/settings.js` | 设置：模型（线上/本地）、形象、动画、关于 |
| `src/consent.html` + `consent.js` | 首次启动协议同意 |
| `src/legal.html` + `js/legal.js` + `src/legal-data.js` | 法律文档渲染（生成物） |
| `src/js/agent.js` | 多轮对话循环（`runAgent` / 历史裁剪 / 系统人格） |
| `src/js/ai.js` | `callLLM` / `testConnection` / `diagnose`（结构化错误日志） |
| `src/js/logger.js` / `rendererLogger.js` / `watcher.js` | 日志落盘、渲染端桥接、日志监控 |
| `src/js/selfCheck.js` | 启动 5 秒后自检（AI/tray/快捷键等，环境项只 warn） |
| `src/js/localLLM.js` / `onlineConfig.js` | Ollama 探测 / Key 来源解析 |
| `src/js/fx.js` | 粒子动画（当前只用于预览） |
| `src/styles/` | `tokens.css`（主题变量）+ 各窗口样式 |
| `docs/ROADMAP.md` | 剥离清单与里程碑 |
| `electron-builder*.yml` | 三套构建配置 |
| `scripts/release.js` | 双版本构建 + 发布到同一 Release |

## 四、store 数据结构（electron-store defaults）

```js
{
  position: {x,y},
  autoStart: false,
  aiConfig: { baseUrl, token, model },   // token 明文，仅本机
  localModel: '',                        // Ollama 模型名
  installId: '',                         // 首次启动生成
  persona: 'cat',                        // cat | dog | caishen | lots
  agentChat: { messages: [], scene: '', updatedAt: 0 },
  consentVersion: 0,
}
```

## 五、IPC API（preload 暴露的 window.api）

**配置**：`getConfig(key)` / `saveConfig(key,value)`
**形象**：`getPersona()` / `setPersona(name)` / `onPersonaChanged`
**窗口**：`savePosition` / `updateBallPos` / `getScreenInfo` / `setHitRegion` / `onResetBall`
**设置**：`openSettings` / `openLegal(key)` / `acceptConsent` / `quitApp` / `previewBallAnim` / `onPreviewBallAnim`
**模型**：`getLlmStatus` / `getOnlineAiConfig` / `saveOnlineAiConfig` / `clearOnlineAiToken` / `testOnlineAi` /
`getLocalModels` / `setLocalModel` / `pullLocalModel`
**对话**：`openAiInput` / `closeAiInput` / `aiInterpretAsk({query})` / `resetAgentChat` /
`onAiInputFocus` / `onAiInputLoading` / `onAiInputError` / `onAgentProgress`
**日志**：`logInfo/Warn/Error/Critical`

## 六、关键约定 & 坑

1. 球位置是浮点，Electron 原生 `setPosition` 前必须 `Math.round`（`getBallScreenPos` 已处理）。
2. `update-ball-pos` 是 60fps 通道，不记日志、400ms 合并落盘。
3. AI 失败静默降级：`agent.runAgent` 抛出的错误由 IPC handler 转成浮窗错误提示，不打断角色。
4. 新增窗口必须在 `preload.js` 白名单加 IPC，同时在 `main.js` `registerIpc` 注册。
5. 协议版本升级会重新弹同意页；改 `docs/legal/*.md` 后跑 `npm run build:legal`。
6. 产品页改完跑 `npm run build:site` 并提交 `docs/index.html`。
7. **不要引入 fortune-ball 的运势/黄历/卡片代码**（见 `CLAUDE.md` 硬约束）。

## 七、当前状态

- ✅ S0 可运行：协议页 → 团子猫 → 拖拽 / 托盘 / 设置 / AI 对话
- ✅ `node smoke-test.js` → 21 通过
- ✅ 双版本构建配置 + Release 脚本已改名完成
- ⏳ S1：验证角色吸引力（见 `docs/ROADMAP.md`）
