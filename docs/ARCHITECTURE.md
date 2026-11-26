# 技术架构

> 读者：要改动本项目的工程师 / AI 协作者。
> 产品方向见 [`ROADMAP.md`](ROADMAP.md)；剥离历史见 [`STRIP-LOG.md`](STRIP-LOG.md)；
> 面向 AI 协作者的速查见 [`../AGENTS.md`](../AGENTS.md)。

## 一、架构原则

这四条决定后续每一个技术选择，改动前先确认没有破坏它们：

1. **薄壳厚领域**：平台能力（窗口、托盘、IPC、文件、网络）留在 Electron 壳里；
   角色逻辑（状态机、记忆、笔记本、瓶子规则、对话循环）放在**零平台依赖**的 `packages/desktop/src/core/`。
   这是手机端复用与纯 node 单测的前提。
2. **失败静默降级**：AI、后端、天气任何一项挂了，角色本身必须照常可用。
   错误降级为浮窗提示或日志，不允许打断角色体验。
3. **本地优先**：对话、记忆、日记、瓶子默认只存在本机；任何离开设备的动作都必须
   用户主动开启（opt-in），且隐私政策同步更新、`AGREEMENT_VERSION` +1。
4. **可观测**：所有跨进程、外部调用、异常路径都有结构化日志；高频通道不写日志。

### 硬约束（会被代码 / 检查器拦住）

| 约束 | 位置 | 守护 |
|---|---|---|
| `.ball` 的 transform 只由 `setBallTransform` 写 | `packages/desktop/src/renderer/pet/pet.ts` | 评审 |
| 动画只能动 `.ball-inner` / SVG 分组 | `packages/desktop/src/renderer/styles/ball.css` | 评审 |
| 装饰层一律 `pointer-events: none` | 各窗口 CSS | 评审 |
| 高频通道 `update-ball-pos` 不写日志、400ms 合并落盘 | `packages/desktop/src/main/ipc.ts` | 评审 |
| 球位置传给 Electron 前必须 `Math.round` | `packages/desktop/src/main/windows.ts` | `getBallScreenPos` 已处理 |
| `packages/desktop/src/core/` 不得依赖 electron / node 内置 / window / document / process.platform | — | `npm run check:core` |
| 不引入 fortune-ball 的运势/黄历/卡片/精灵代码 | — | `CLAUDE.md` |

## 二、技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 构建 | **electron-vite 4** + Vite 7 | Electron 社区标准脚手架；main/preload/renderer 三段配置，HMR |
| 语言 | **TypeScript 5.9**（strict） | `packages/desktop/src/core` 要跨端复用，领域模型必须有稳定契约 |
| UI | **React 19**（聊天 / 设置 / 协议 / 法律） | 状态驱动的列表界面；社区与 AI 生态默认值 |
| 宠物窗口 | **命令式 TS**（不引入 React） | 60fps transform、点击穿透、hit-region 是精密手工活，框架渲染循环只会增加回归风险 |
| 校验 | **zod 4** | IPC 入参与 store 写入的运行时校验，仅主进程使用 |
| 测试 | **Vitest 3** | 与 Vite 同源；core 纯 node 单测 |
| 打包 | electron-builder 26 | 沿用现有三套配置 |
| 持久化 | electron-store 8 | 沿用（明文 JSON，仅本机） |

**不引入的东西**：不做跨端 UI 框架（RN/Flutter），不做 monorepo，不引入 Redux 类全局状态——
每个窗口的状态都是局部的，跨窗口通信一律走 IPC。

## 三、分层与目录

```
┌──────────────────────────────────────────────────────────────┐
│ src/main/            Electron 主进程（壳 + 平台适配）           │
│   index.ts           入口：单实例 / 生命周期 / boot 顺序        │
│   windows.ts         五个窗口：创建 / 定位 / 显隐               │
│   tray.ts            托盘菜单、开机自启、形象广播               │
│   ipc.ts             IPC 注册（按域拆分，入参 zod 校验）        │
│   cursor.ts          80ms 光标轮询 → 点击穿透决策               │
│   chat.ts            对话编排：历史、fallback、错误文案          │
│   diagnostics.ts     LogWatcher → AI 诊断 → 系统通知            │
│   shortcut.ts        全局快捷键                                 │
│   store.ts           electron-store 读写 + AI 配置解析          │
│   state.ts           运行期可变状态（坐标 / 热区 / 窗口引用）    │
│   scripts.ts         运行时路径（preload / renderer / 资源）    │
│   services/          ai · localLLM · onlineConfig · logger      │
│                      watcher · detector · selfCheck             │
└──────────────────────────────┬───────────────────────────────┘
                               │ IPC（packages/desktop/src/shared/channels.ts 定义通道名）
┌──────────────────────────────▼───────────────────────────────┐
│ src/preload/index.ts   白名单 contextBridge（不暴露 ipcRenderer）│
└──────────────────────────────┬───────────────────────────────┘
                               │ window.api / window.logger
┌──────────────────────────────▼───────────────────────────────┐
│ src/renderer/          渲染端                                   │
│   pet/                 命令式 TS：拖拽 / 菜单 / 热区 / 图集渲染  │
│   notebook/            React 19：猫的笔记本（S2）                │
│   chat/                React 19：对话浮窗                       │
│   settings/            React 19：设置面板                       │
│   consent/             React 19：首次启动协议同意               │
│   legal/               法律文档（内容来自 @legal-data）          │
│   renderer-logger.ts   渲染端日志（限速 + 全局错误捕获）         │
│   styles/              tokens + 各窗口 CSS（无 CSS 框架）        │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ src/core/              领域层：零平台依赖，纯 node 可跑         │
│   agent.ts             对话循环（callLLM 注入）                 │
│   petState.ts          情绪状态机（S1）                         │
│   quips.ts             台词选择（冷却 + 最久未说优先）           │
│   persona.ts           人格卡 → system prompt（含记忆块）        │
│   memory.ts            记忆抽取提示词 / 解析 / 合并淘汰           │
│   notebook.ts          每日日记 + Markdown 导出                  │
│   backup.ts            全量导出 / 导入（不含 Key）               │
│   locomotion.ts        走动 / 爬墙 / 天花板 / 抛掷物理（v0.5.0）  │
│   motion.ts            动作契约：14 动作 × 两视角 + 换肤清单      │
│   types.ts             领域类型（shared/types 从这里扩展）      │
│   logger-types.ts      日志接口（平台层注入实现）               │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ src/data/              内容资产（零依赖，可被 core 引用）        │
│   quips.json           台词库：7 个 bucket + fallback（S1）     │
│   persona.json         人格卡：习性 / 小习惯 / 边界 / 说话规则   │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ src/shared/            跨进程契约                               │
│   channels.ts          通道名 / 事件名常量（零依赖，preload 可用）│
│   ipc.ts               zod 入参 schema（仅主进程）              │
│   types.ts             CompanionApi + 视图模型（领域类型 re-export）│
└──────────────────────────────────────────────────────────────┘
```

### 依赖方向（单向）

```
renderer ──→ shared ──→ core
main     ──→ shared ──→ core
preload  ──→ shared/channels.ts（只用常量，不引 zod）
core     ──→ 只能引用 core 内部
```

反向引用（core → main、shared → renderer）是错误，`npm run check:core` 会拦住 core 侧越界。

### 内容资产

台词库、人格卡、日记模板、信纸定义等**内容**放 `packages/desktop/src/data/`（S1 起），不内嵌进组件。
手机端直接复用，不需要重写。

## 四、进程与窗口模型

单进程 Electron 主进程 + 5 个 `BrowserWindow`（全部 `contextIsolation: true`、
`nodeIntegration: false`、同一份 preload）：

| 窗口 | 入口 | 关键属性 |
|---|---|---|
| 团子猫 | `renderer/pet` | 主屏全屏透明、`skipTaskbar`、排除 Alt+Tab、默认 `setIgnoreMouseEvents(true,{forward:true})`、`backgroundThrottling:false` |
| 对话浮窗 | `renderer/chat` | 380×480、`alwaysOnTop`、失焦自动隐藏 |
| 设置面板 | `renderer/settings` | 460×680、单例 |
| 协议同意 | `renderer/consent` | 未同意关窗即退出，不创建主窗口 |
| 法律文档 | `renderer/legal` | `?doc=privacy\|terms\|disclaimer\|thirdparty` |

另有：托盘、全局快捷键（`Ctrl+Alt+F`）、critical 诊断通知。

主进程定时器：

| 定时器 | 周期 | 职责 |
|---|---|---|
| 光标轮询 | 80ms | 判断光标是否在猫/菜单热区，切换 `setIgnoreMouseEvents` |
| 位置合并落盘 | 400ms | `update-ball-pos` 累积后写 store |
| LogWatcher | 1s 轮询文件 | 新日志行 → detector 分级 → 必要时 AI 诊断 + 通知 |

### 启动时序

```
app.setAppUserModelId → 单实例锁 → store 初始化（迁移 + installId）→ app.ready
  → needsConsent()? 是 → 协议同意窗口（同意后 emit 'consent-accepted'）
                    否 → boot()
boot() = 团子猫窗口 → 全局快捷键 → 开机自启 → 光标轮询 → LogWatcher → selfCheck(5s)
```

## 五、关键数据流

### 1. 拖拽与位置

```
renderer pointermove → setBallTransform(x,y)     纯 CSS transform，零 IPC
        └─ rAF 合并 → api.updateBallPos(x,y)     高频通道，不写日志
main     ├─ state.currentBallPos 更新（供光标轮询算热区）
         └─ 400ms 合并 → store.set('position')
renderer pointerup → api.savePosition(x,y)        立即落盘兜底 → updateOrbitEdges()
```

**为什么不用 `setBounds`**：60fps 调原生接口会卡顿；transform 全在渲染进程完成，
只有落盘与热区计算需要 IPC。

### 2. 点击穿透

窗口永远全屏；默认整窗穿透，`forward:true` 让 renderer 仍收到 mousemove。
主进程 80ms 轮询光标：在「猫身 ± `BALL_HALO`」矩形内 → 收回穿透；
菜单打开时，renderer 通过 `api.setHitRegion(rect)` 上报「猫 + 面板」外接矩形并入判定。
**只在状态变化时调用** `setIgnoreMouseEvents`。

### 3. 悬停菜单

`pointerenter` 打开 `.orbit-open`；面板与猫之间有空隙，用 220ms 闩避免闪烁。
`updateMenuLayout()` 按屏幕剩余空间在 右/左、上/下 之间选择朝向，空间不足时压缩。
每次变化 40ms 节流上报 hit-region。

### 4. 对话

```
chat(App.tsx) → api.aiInterpretAsk({query}) → ipc(CH.aiInterpretAsk)
main chat.ts → withAiFallback(cfg => core.agent.runAgent({...}))
   ├─ store.resolveAiConfig(): 本地 Ollama > 设置面板 > .env(仅 dev) > 内置 Key
   ├─ 用户 Key 鉴权失败 → 临时用内置 Key，回包带 notice
   └─ 失败 → 返回 {ok:false,error} + 推送 ai-input-error；角色不受影响
core.agent.runAgent → 注入的 ai.callLLM → net.fetch /v1/chat/completions
chat 渲染消息气泡；错误码经 friendlyError 转人话
```

### 5. 情绪状态机（S1）

```
renderer 事件（pointerenter / click / drag / 每秒 tick）
   → core.petState.reducePetState(state, event)     纯函数，零依赖
   → { state, trigger? }

renderer 消费：
   state.mood  → #ball-inner[data-mood]             CSS 负责耳朵/尾巴/眨眼/配色
   trigger     → core.quips.pickBucket + pickQuip   → #pet-bubble（3s 自灭）

持久化：store.pet = { name, lastInteractAt, lastGreetDate }
   （只在状态变化时写，5s 节流；clicks 等临时数据不落盘）
```

状态机只输出 mood 与触发类型，不输出动画——手机端可以把同一个 mood 渲染成小组件文案。

### 6. 记忆与笔记本（S2）

```
对话回复返回后（不等用户）
   → remember.extractMemories(history)          异步，失败静默
   → core.memory.shouldExtract（<20 字且 <3 轮则跳过）
   → ai.callLLM(抽取提示词) → parseExtractedFacts → mergeMemories（去重 + 上限 30）
   → store.memories
   → remember.ensureDailyDiary()                重算当天日记（素材变了就重写）

下一轮对话
   → core.persona.composeSystemPrompt(名字, store.memories)
   → 注入 agent.runAgent({ systemPrompt })

笔记本：托盘 / IPC open-notebook → ensureDailyDiary → 笔记本窗口（React）
备份：设置页导出 JSON（名字 / 记忆 / 日记 / 聊天，不含 API Key）
```

注意两处顺序：记忆按时间正序注入（最近的事实排最后）；日记必须**重算**而不是「当天只写一次」，
否则启动时写下的「今天你几乎没出现」会一整天不更新。

### 7. 桌面上的身体（v0.5.0）

```
渲染端 rAF 循环（每帧）
  → core.locomotion.stepLoco(loco, { dtMs, now, bounds, canWander })
  → { loco, cue }
  → setBallTransform(round(x), round(y))   位置仍只由这一个函数写
  → #ball[data-loco] + --face               姿态/朝向交给 CSS

拖拽生命周期
  pointerdown → grabLoco（冻结自主运动）→ pointermove → syncLocoPosition
  pointerup   → releaseLoco(释放速度，夹紧 ±1500 px/s) → fall → 墙/天花板反弹 → land
```

约束：睡觉 / 打盹 / 菜单打开 / 预览动画时 ；被按住时状态机完全不推进。

### 8. 角色渲染与换肤（v0.6.0）

```
身体状态 + 情绪 + 原地动作
  → core.motion.clipForState(loco, mood, { action, justWoke })  → ClipName
  → renderer.setClip(clip) / setFacing(right)
  → Canvas drawImage(图集第 row 行第 frame 列) → 锚点对齐 → 侧影可镜像
```

换皮肤只需要提供：
- 一份 `SkinManifest`（每个动作的 view / 帧数 / fps / 行号 + 两个视角的锚点）
- 一张图集

渲染器不认识角色，只认识清单；以后接 Spine 时新增一个适配器，契约不动。

### 9. 日志与自检

```
renderer window.logger.* → send(log-*) → main registerLogIpc → logger.write
logger.write → 文件 + console → watcher 轮询 → detector 分类
   → error/critical 且 5 分钟去重通过 → ai.diagnose → critical 才弹通知
selfCheck：启动 5s 后检查 AI 配置 / tray / 快捷键，环境项只 warn
```

敏感字段（token / apiKey / password / Authorization）写入前 `redact`。

## 六、IPC 契约

**唯一通道**：`preload` 暴露的 `window.api`（类型见 `packages/desktop/src/shared/types.ts` 的 `CompanionApi`）。
通道名常量在 `packages/desktop/src/shared/channels.ts`，入参 schema 在 `packages/desktop/src/shared/ipc.ts`。

### 新增一个能力的固定步骤

1. `packages/desktop/src/shared/channels.ts` 加通道名；如需事件，`EV` 里加事件名。
2. `packages/desktop/src/shared/ipc.ts` 加入参 schema（如果参数简单可复用现有）。
3. `packages/desktop/src/main/ipc.ts` 里 `handle(CH.xxx, ...)` 注册（自动带入口日志与异常兜底）。
4. `packages/desktop/src/shared/types.ts` 的 `CompanionApi` 加方法签名。
5. `packages/desktop/src/preload/index.ts` 白名单加一行（**必须与第 4 步一致**，TS 会校验）。

高频通道用 `handleFast()`（不写日志，只做最小校验）。

### 通道清单

| 类别 | 通道 |
|---|---|
| 配置 | `get-config` `save-config` |
| 形象 | `get-persona` `set-persona` / 事件 `persona-changed` |
| 位置与窗口 | `save-position` `update-ball-pos` `get-screen-info` `set-hit-region` `set-ignore-mouse` |
| 系统 | `open-settings` `open-legal` `accept-consent` `quit-app` `preview-ball-anim` / 事件 `preview-ball-anim` |
| 模型 | `get-llm-status` `get-online-ai-config` `save-online-ai-config` `clear-online-ai-token` `test-online-ai` `get-local-models` `set-local-model` `pull-local-model` |
| 对话 | `open-ai-input` `close-ai-input` `ai-interpret-ask` `reset-agent-chat` / 事件 `ai-input-focus` `ai-input-loading` `ai-input-error` `ai-agent-progress` |
| 日志 | `log-info` `log-warn` `log-error` `log-critical` |

## 七、持久化

electron-store，`%APPDATA%/companion-ball/config.json`（明文，仅本机）。

```ts
{
  position: {x, y} | null,          // 球位置（浮点；落盘时无需取整）
  autoStart: boolean,
  aiConfig: { baseUrl, token, model },  // token 明文；设置界面只显示打码片段
  localModel: string,               // 空 = 用线上
  installId: string,                // 首次启动生成（UUID），匿名身份种子
  persona: 'cat',                   // 皮肤；旧值 dog/caishen/lots 自动回落
  agentChat: { messages: [], updatedAt: 0 },
  consentVersion: number,
  animations: boolean,
}
```

S1 起新增：`pet: { name, lastInteractAt, mood }`；
S2 起新增：`memories: []`、`notebook: []`。

**演进规则**

- 只做**向后兼容**的加法：新字段必须有默认值；旧字段读不到时回落，不抛错。
- 改语义时写显式迁移（参考 `store.ts` 的 `migrateLegacyAiConfig()`），并在 CHANGELOG 记录。
- S2 起提供**全量导出 / 导入**（JSON）：这是手机端「恢复码」同步的前提。
- 领域数据必须带 `id` + `createdAt`（UTC ISO），保证跨端可合并。

## 八、AI 链路与成本

### 模型来源优先级

| 顺序 | 来源 | 生效条件 |
|---|---|---|
| 1 | 本机 Ollama | 用户选了 `localModel` 且探测可用 |
| 2 | 设置面板 `store.aiConfig` | 发布版优先（用户显式配置） |
| 3 | `.env` | 开发态 `!app.isPackaged` 时优先 |
| 4 | `resources/bundled-ai.json` | 内置 Key 版（`electron-builder.key.yml`） |

### 成本纪律

- 内置 Key 版 = **用你的余额为全量用户付费**，任何「每次打开就调模型」的设计都否决。
- 微交互（点击、悬停、状态切换）**绝不走 LLM**，走本地状态机 + 台词库。
- 对话：`maxTokens 800`、单轮 `MAX_STEPS 6`、历史按 `HISTORY_TURNS 8` 裁剪。
- S2 记忆抽取、日记生成：只在有素材时调用，用便宜模型，失败静默跳过。
- 手机端：Key 不进客户端，届时 `services/ai.ts` 的 `callLLM` 切换到自有代理端点。

### 错误码约定

`NO_TOKEN / AUTH_FAILED / INSUFFICIENT_BALANCE / RATE_LIMITED / TIMEOUT /
NETWORK / UPSTREAM_ERROR / BAD_JSON / EMPTY_RESPONSE / EMPTY_QUERY /
AGENT_MAX_STEPS`。同类错误 5 分钟内只记一次 error（`ai.ts` 去重），其余降 warn。

## 九、安全与隐私

| 面 | 现状 |
|---|---|
| 渲染端隔离 | `contextIsolation: true` + preload 白名单，无 `nodeIntegration` |
| IPC 校验 | 主进程 zod schema；未知配置键直接拒绝 |
| Key 存储 | 本机明文（electron-store）；日志 redact；界面打码 |
| 数据出网 | 仅 AI 请求与 Ollama 探测；无遥测 |
| 代码执行 | 不 `eval`；不加载远程页面 |
| 用户感知 | 协议同意页 + 法律文档；隐私政策须与实现一致 |

**红线**：不读窗口标题、不上传用户数据做全局改进、不做隐藏遥测。
新增任何出网调用前先回答：用户是否知情？隐私政策是否覆盖？能否做成 opt-in？

## 十、构建与发布

> 2026-11-25 monorepo：桌面端构建配置在 `packages/desktop/`，产物目录相对于该包；
> 根目录命令是转发（`npm run build` → `npm run build -w @companion/desktop`）。

```
npm run build            # typecheck + build:legal + electron-vite build → packages/desktop/out/
npm run build:local      # build + electron-builder --dir/win
npm run build:public     # 公开版（无内置 Key）→ packages/desktop/out-public/
npm run build:personal   # 内置 Key 版 → packages/desktop/out-release-key/
npm run release:patch    # 升版本（packages/desktop）→ tag → push → 构建 → 发布
```

| 配置 | 产物目录（相对 `packages/desktop/`） | 用途 |
|---|---|---|
| `electron-builder.yml` | `out-release/` | 默认 / 本地 |
| `electron-builder.public.yml` | `out-public/` | 公开版 |
| `electron-builder.key.yml` | `out-release-key/` | 个人版（注入 `bundled-ai.json`） |

- 打包只收 `out/**/*` + `package.json`；`src / tests / docs / scripts / resources` 被排除，
  打包产物里只有编译结果。
- `resources/`（图标、托盘图）通过 `buildResources` 与 `extraResources` 进入安装包。
- `build:legal`：仓库根 `docs/legal/*.md` → `packages/desktop/src/legal-data.js`（生成物，勿手改；已入库，
  让 `npm start` 在未构建时也能用）。
- `build:site`：`packages/web/product-intro.html` → `docs/index.html`（Pages 源为 master `/docs`）。
- `bundled-ai.json` 生成在 `packages/desktop/`（已 gitignore），由 `electron-builder.key.yml` 复制进安装包。

## 十一、测试

| 层 | 工具 | 范围 |
|---|---|---|
| core | Vitest（纯 node） | 对话循环、状态机（S1）、记忆、笔记本、瓶子规则 |
| 分层 | `npm run check:core` | core 不得依赖平台；import 不得跳出 core |
| 类型 | `tsc -p tsconfig.node/web.json` | 主进程/渲染端全量类型检查 |
| 渲染冒烟 | 手工 / CDP（见下） | 打开各窗口、发一条消息、检查 DOM |

`npm test` = `vitest run` + `check:core`。

**渲染层已验证的冒烟步骤**（可复现）：

```bash
npx electron-vite build
./node_modules/electron/dist/electron.exe . --user-data-dir=<临时目录> --remote-debugging-port=9333
# 然后通过 CDP 在宠物窗口执行 api.openSettings() / api.openAiInput()，
# 并在 chat 窗口填入文本 + click 发送，确认消息渲染与主进程日志
```

## 十二、技术债与 S1 计划

| # | 问题 | 影响 | 计划 |
|---|---|---|---|
| 1 | `main.js` 已拆分为 `packages/desktop/src/main/*`，但 `ipc.ts` 仍约 300 行、按域集中注册 | 可维护性尚可，继续增长会变长 | 通道超过 ~40 个时按域拆 `ipc/` 目录 |
| 2 | 无 ESLint / Prettier | 风格一致性靠评审 | S1 前引入（pre-commit） |
| 3 | ~~设置开关 `animations` 已保存但渲染端未消费~~ | — | ✅ S1 已接上：`config-changed` 广播 + `data-anim` 关闭过渡/常态动画 |
| 4 | `legal-data.js` 是 CJS 生成物 | 依赖 Vite 的 CJS 互操作 | 可接受；生成器可改为 `.ts` 后再评估 |
| 5 | 渲染层无自动化 UI 测试 | 改交互靠手测 | S1 引入 Playwright（打开窗口 + 点击断言） |
| 6 | `reset-ball` 事件通道已移除（容器组件改用托盘重置位置） | 无影响 | 已清理 |
| 7 | `zod` 在生产依赖中 | 主进程包体积增加 | 可接受（主进程不参与首屏） |

### S1 的技术交付清单

```
src/core/petState.ts      状态机（纯函数）✔ 已实现：PetEvent → { state, trigger? }
src/core/quips.ts         选台词 ✔ 已实现：bucket + 冷却 + 最久未说优先
src/data/quips.json       台词库 ✔ 98 条（7 个 bucket + fallback）
src/renderer/pet/pet.ts   改为只渲染 core 输出的动作（订阅 IPC / 本地驱动）
src/main/windows.ts       气泡层（可用 DOM 气泡或独立无边框窗口）
tests/petState.test.ts    状态机单测
```

验收：点击到首个像素变化 <100ms；`npm test` 全绿；`npm run check:core` 无违规。

## 十三、手机端扩展设计

不做跨端 UI 框架，只共享领域层。三个约束决定今天的写法：

| 约束 | 设计 |
|---|---|
| 手机无常驻进程 | core 输出抽象动作，平台决定表现：桌面 → SVG 动画；手机 → 通知 / 小组件 / 锁屏文案 |
| 数据要跨设备 | 匿名恢复码 + 端到端加密的全量数据包（S2 的导出/导入是第一步），不做云账号 |
| Key 不能进客户端 | `callLLM` 保持唯一出口，自有代理端点在后端持有上游 Key |

**内容资产**（台词、人格卡、日记模板、信纸定义）全部放 `packages/desktop/src/data/`，不内嵌进 HTML。
`packages/desktop/src/core/` 在手机端立项时发布为独立 npm 包，由另一个仓库依赖（不建 monorepo）。

## 十五、平台架构（网页 / 后台 / 服务端 / 爬虫）

> 产品设计见 [`WINDOW.md`](WINDOW.md)；基础设施与费用见 [`PLATFORM.md`](PLATFORM.md)；
> 私池规则见 [`SERVER.md`](SERVER.md)。本节只回答「代码怎么分、依赖往哪走」。

### 15.1 五个可独立部署的单元

```
                  ┌─────────────────────────────┐
                  │ packages/contracts          │  纯类型 + 常量 + 校验
                  │ （零平台依赖、零运行时依赖）  │  所有其他包的唯一契约源
                  └──────────┬──────────────────┘
        ┌───────────┬────────┼─────────┬──────────────┐
        ▼           ▼        ▼         ▼              ▼
┌───────────┐ ┌──────────┐ ┌──────┐ ┌──────────┐ ┌─────────────┐
│ desktop   │ │ server   │ │ web  │ │ admin    │ │ crawler     │
│ Electron  │ │ 瓶子/橱窗 │ │Astro │ │Vite+React│ │ （独立仓库）  │
│           │ │ /新闻 API │ │ 橱窗 │ │ 19       │ │ 只推送线索    │
└───────────┘ └──────────┘ └──────┘ └──────────┘ └─────────────┘
     │             ▲          │          │             │
     └─────────────┴──────────┴──────────┘             │
            HTTP + JSON（契约在 contracts）              │
                                                       │
            线索走独立 service token ───────────────────┘
```

| 单元 | 运行时 | 部署 | 认证方式 |
|---|---|---|---|
| `desktop` | Electron | 安装包（R2 分发） | `X-Device-Token`（installId 派生） |
| `server` | Workers **或** Node 22（同一份 handler） | Cloudflare / VPS | 设备令牌 + admin 会话 |
| `web` | Astro 静态 + Pages Functions | Cloudflare Pages | 无（只读） |
| `admin` | Vite SPA | Cloudflare Pages | API Key + TOTP 会话 |
| `crawler` | **不在本仓库** | 独立进程/容器 | `NEWS_INGEST_TOKEN` |

### 15.2 依赖规则（新增一条硬约束）

```
contracts ←── desktop / server / web / admin
             （单向；谁都不许反向依赖 contracts 之外的同级包）
```

- `desktop` **不 import** `server` / `web` / `admin` 的任何代码
- `web` 与 `admin` **不直接连数据库**——一切写操作走 `server` 的 HTTP 接口
- `server` 是唯一持有 D1/KV 凭证的单元；`web` / `admin` 的 Pages Functions 只做代理与静态托管
- **crawler 只认 contracts 里的 `NewsLeadPush`**，不 import server 实现

> 为什么新增这条：monorepo 里最容易发生的腐化是「前端顺手引后端一个函数」，
> 一旦发生，`web` 就无法独立部署、也无法按路径过滤做 CI。
> **待落地**：`scripts/check-package-deps.js`——扫 `packages/*/src` 的 import 图，越级依赖即失败。

### 15.3 服务端双运行时（已实现，非计划）

`packages/server/src/handler.ts` 是**平台无关**的请求处理（只依赖 `Request` / `Response` 标准对象），
`worker.ts` 与 `node.ts` 是两个薄适配层：

```
handler.ts  ←─ worker.ts（Cloudflare Workers）
            ←─ node.ts  （Node 22 + node:http + node:sqlite → dist/node.mjs）
```

`db.ts` 定义 `Db` 接口 + `d1Adapter` + `sqliteAdapter`（WAL / busy_timeout / 串行化队列）。

**这条设计的意义**：`workers.dev` 在国内不可达，VPS 是必需的退路。
业务逻辑只有一份，**迁 VPS 不需要重写**，因此可以做到「海外 Workers、国内 VPS」双活。

### 15.4 请求链路

**桌面端捡瓶**：
```
pet.ts → preload → main/mail.ts → services/bottleApi.ts
      → POST /v1/bottle/pick  (X-Device-Token)
      → handler.ts → db.ts → D1/SQLite
```

**网页看橱窗（只读，无令牌）**：
```
Astro 静态页 →（构建期）预取 /v1/gallery 或（运行期）fetch
             → handler.ts → gallery_bottles（独立表，不碰 bottles）
```

**后台批准一条瓶子**：
```
admin SPA → POST /admin/moderation/:id  (会话 Cookie)
          → handler.ts → 校验角色 → UPDATE gallery_bottles
          → 写 audit_log → +1 daily_stats
```

**爬虫推线索**：
```
crawler → POST /v1/internal/news/leads  (NEWS_INGEST_TOKEN)
        → handler.ts → 按 fingerprint 去重 → INSERT news_leads (status='new')
        → 后台「线索」页由 operator 消化（无自动发布路径）
```

### 15.5 构建与部署（路径过滤）

| 改了哪里 | 触发什么 | 部署到 |
|---|---|---|
| `packages/desktop/**` | 桌面构建 + e2e | R2（安装包） |
| `packages/server/**` | typecheck + 单测 | `wrangler deploy` 或 VPS |
| `packages/web/**` | Astro build | Cloudflare Pages |
| `packages/admin/**` | Vite build | Cloudflare Pages |
| `packages/contracts/**` | **全部**（契约变更三端同步） | — |
| `docs/**` | 只跑门禁（`check-docs` / `check-secrets`） | — |

GitHub Actions 用 `paths:` 过滤；`contracts` 变更必须全量跑，这是唯一不做优化的情况。

### 15.6 安全边界（跨端汇总）

| 数据 | desktop | server | web | admin |
|---|---|---|---|---|
| 用户私池瓶子 | 作者可见、捡到者可见 | 存储（作者只存哈希） | ❌ | ❌（仅被举报的单条） |
| 橱窗内容 | ❌ | ✅ | ✅（已批准） | ✅ |
| 页边一句话 | ✅ 仅本地 | ❌ **永不出网** | ❌ | ❌ |
| 设备令牌 | 持有原文 | 只存哈希 | ❌ | 只能按哈希封禁 |
| AI Key | 用户本地 / 环境变量 | ❌ | ❌ | ❌ |

> 页边一句话的「永不出网」由 `scripts/check-margin-privacy.js` 机器守护（见 CHANGELOG 0.9.9）。

## 十六、变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-20 | 迁移到 electron-vite 4 + React 19 + TS：主进程拆分、core/shared/preload 分层、renderer React 化（宠物窗口保持命令式）、zod 校验、Vitest、`check:core` 支持 TS |
| 2026-11-26 | 新增第十五节「平台架构」：五单元依赖规则、双运行时、请求链路、路径过滤构建、跨端安全边界 |
