# 工程交接文档（给下一个 Agent）

> 读完即可动手。**先读本文，再按需跳转**：
> 产品方向 → [`docs/ROADMAP.md`](docs/ROADMAP.md)｜技术细节 → [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
> 剥离历史 → [`docs/STRIP-LOG.md`](docs/STRIP-LOG.md)

## 一、这是什么

**桌面陪伴 · 团子猫** —— Windows 桌面 Electron 陪伴角色，当前 0.9.9（私人闭环 P1 → P1.5 → P2 已全通；
产品方向以 [`docs/PRODUCT-THESIS.md`](docs/PRODUCT-THESIS.md) 为准）。

- 80×80 内联 SVG 团子猫常驻桌角：可拖拽、位置记忆、贴边自动翻转菜单
- 7 种情绪（醒着 / 开心 / 好奇 / 打盹 / 睡着 / 不耐烦 / 眩晕）+ 98 条台词 + 3 秒自动消失的气泡
- 已实现「不点它也有反应」：久坐打盹、凌晨半睡、靠近唤醒、早间问候、连点会烦、甩晕
- 会在桌面上自己走动、爬到屏幕边缘与顶部倒挂；拖起甩出有抛物线物理；轻合成音效
- 点击猫 / `Ctrl+Alt+F` / 托盘「聊聊天」→ 打开 AI 对话浮窗（多轮）
- 托盘：显示/隐藏、聊天、设置、开机自启、动画、日志级别、重置位置
- 没有运势、黄历、卡片、精灵

定位是**陪伴**不是助手；领域逻辑放 `src/core/`（零平台依赖），为手机端预留。

## 二、宪法（改动前必须确认）

1. **每一次变更都必须是：文档记录（CHANGELOG）+ 功能测试 + tag + GitHub Release。**
   流程与门禁见 [`docs/RELEASING.md`](docs/RELEASING.md)；`npm run release:*` 会自动检查。
   缺任何一项，这次提交不算完成。
2. **不引入任何运势 / 黄历 / 卡片 / 精灵代码**（属于 fortune-ball）。
3. **单仓库 monorepo（私有）**：桌面端在根目录，平台包在 `packages/{contracts,server,web,admin}`；
   不建**跨产品** monorepo；壳层只在本仓库维护，不复用 fortune-ball 的代码包。
4. **`src/core/` 零平台依赖**：不得 import `electron` / `node:fs` / `node:path` / `node:os` 等，
   不得用 `window` / `document` / `process.platform`；`npm run check:core` 会拦（含 TS）。
   core 也不得 import core 之外的模块；共享类型从 `core/types.ts` 出，`shared/types.ts` 向上扩展。
5. **不读窗口标题、不上传用户数据**；任何出网调用必须用户知情且写进隐私政策。
6. **渲染端只能通过 `window.api` 访问主进程**；新增能力必须同步改 `shared/channels.ts`、
   `shared/ipc.ts`、`main/ipc.ts`、`shared/types.ts`、`preload/index.ts`。
7. appId 固定 `com.companion.ball`，与 fortune-ball 的 `com.fortune.ball` 互不干扰。
8. **角色失败静默降级**：AI / 网络 / 后端出错不得打断角色本身。

## 三、技术栈与目录

**electron-vite 4 + Vite 7 + TypeScript 5.9（strict）+ React 19 + zod 4 + Vitest 3**。

| 目录 | 职责 | 平台依赖 |
|---|---|---|
| `src/main/` | 主进程：窗口、托盘、IPC、光标轮询、诊断 | Electron |
| `src/preload/` | `contextBridge` 白名单 | Electron |
| `src/renderer/pet/` | 团子猫（**命令式 TS，不引入 React**） | DOM |
| `src/renderer/{chat,settings,consent,legal}/` | React 19 窗口 | DOM |
| `src/renderer/styles/` | tokens + 各窗口 CSS（无 CSS 框架） | — |
| `src/core/` | 领域：对话循环、状态机、人格卡、记忆、笔记本、备份、动作契约 | **零** |
| `src/shared/` | 跨进程契约：通道名、zod schema、类型 | 零（ipc.ts 用 zod） |
| `src/data/` | 内容资产：台词库、人格卡（core 可只读引用 JSON） | 零 |

依赖方向单向：`renderer / main → shared → core`。完整说明见 `docs/ARCHITECTURE.md` 第三节。

## 四、常用命令

```bash
npm install
npm run dev               # electron-vite dev（HMR）
npm test                  # Vitest + check:core
npm run test:e2e          # 功能测试：真实启动应用（需先 build）
npm run test:all          # 单测 + 构建 + 功能测试
npm run typecheck         # tsc 主进程 + 渲染端
npm run build             # typecheck + build:legal + electron-vite build → out/
npm run build:public      # 公开版（不带 Key）→ out-public/
npm run build:personal    # 内置 Key 版 → out-release-key/
npm run build:legal       # docs/legal/*.md → src/legal-data.js
npm run build:site        # product-intro.html → docs/index.html（提交产物）
npm run release:patch     # 门禁全过 → 升版本 → tag → push → 双版本构建并发布
```

**发版规矩见 [`docs/RELEASING.md`](docs/RELEASING.md)**：一个可交付版本 = 一个 CHANGELOG 条目 +
一次功能测试通过 + 一个 tag + 一个 GitHub Release。

## 五、最高频的坑（按踩坑概率排序）

0. **命令超时 ≠ 失败**。`git push` / `npm run release` 这类长命令超时后，
   很可能**后台已经把事做完了**。先验证状态（`git status -sb`、`git ls-remote --tags`、
   查线上 `latest.json`），再下结论——否则会误报失败，浪费一轮排查。
1. **球的 transform 只能由 `setBallTransform` 写**（位置由它维护）；动画只能动
   `.ball-inner` 或 SVG 分组。动了 `.ball` 的 transform 会让球瞬移。
2. **`update-ball-pos` 是 60fps 通道**：不写日志；落盘走 400ms 合并。
   球位置是浮点，交给 Electron `setPosition` 前必须 `Math.round`（`getBallScreenPos` 已处理）。
3. **点击穿透**：窗口全屏透明，默认 `ignoreMouseEvents(true, {forward:true})`；
   主进程 80ms 轮询光标判断热区。**菜单打开时必须让渲染端 `setHitRegion` 上报
   「猫 + 面板」外接矩形**，否则面板点不到。
4. **新增 IPC 要五处同步**（见宪法第 5 条）；`preload` 不要 import `shared/ipc.ts`
   （会把 zod 打进 preload），通道名只从 `shared/channels.ts` 取。
5. **装饰层一律 `pointer-events: none`**；菜单有 220ms 开合闩，防止鼠标穿过空隙时闪烁。
6. **改 `docs/legal/*.md` 后跑 `npm run build:legal`**；内容变更必须同时把
   `src/main/windows.ts` 的 `AGREEMENT_VERSION` +1（否则老用户不会重新同意）。
7. **改产品页后跑 `npm run build:site` 并提交 `docs/index.html`**（Pages 源是 master `/docs`）。
8. **AI 失败要静默降级**：`core/agent.runAgent` 抛出的错误由 `main/chat.ts` 转成浮窗提示。
9. **不要给微交互加 LLM 调用**：点击 / 悬停 / 状态切换必须走本地状态机（<100ms）。
   内置 Key 版的每一次调用都是开发者在付钱。
10. **宠物窗口不要引入 React**。那里是 60fps transform + 穿透 + 热区的手工活；
    聊天 / 设置 / 笔记本才用 React。

## 六、代码在哪

| 你要改… | 去 |
|---|---|
| 许愿瓶规则（常量 / 校验 / 分池 / 生命周期） | `packages/contracts/src/`（**唯一源**；`src/core/mailbox.ts` 只做 re-export） |
| 许愿瓶服务端 API | `packages/server/src/index.ts`（部署：`npm run -w @companion/server deploy`） |
| 角色表现、拖拽、菜单、热区 | `src/renderer/pet/pet.ts` + `styles/ball.css` + `pet/index.html` |
| 动作契约 / 两视角 / 换肤 | `src/core/motion.ts` + `src/renderer/pet/renderer.ts` |
| 皮肤素材（图集 + manifest） | `src/renderer/pet/skins/`（`npm run build:skin` 生成） |
| 情绪 / 台词 / 人格 / 记忆 / 日记 | `src/core/{petState,quips,persona,memory,notebook}.ts` + `src/data/*.json` |
| 走动 / 攀爬 / 抛掷物理 | `src/core/locomotion.ts` + `src/renderer/pet/pet.ts`（rAF 循环） |
| 轻音效 | `src/renderer/pet/sound.ts` |
| 记忆抽取与日记编排 | `src/main/remember.ts` |
| 笔记本窗口 | `src/renderer/notebook/App.tsx` |
| 主进程入口、启动顺序 | `src/main/index.ts` |
| 窗口创建 / 定位 | `src/main/windows.ts` |
| 托盘菜单 / 开机自启 | `src/main/tray.ts` |
| IPC 注册 | `src/main/ipc.ts`（通道名在 `shared/channels.ts`） |
| 对话编排 / 错误文案 | `src/main/chat.ts` |
| 对话循环 / system prompt | `src/core/agent.ts` |
| LLM 调用、错误码、诊断 | `src/main/services/ai.ts` |
| 模型来源解析 | `src/main/services/onlineConfig.ts`、`localLLM.ts` |
| 设置面板 | `src/renderer/settings/App.tsx` |
| 法律文档 | `docs/legal/*.md` → `src/legal-data.js`（生成物） |
| 主题变量 | `src/renderer/styles/tokens.css` |

## 七、当前状态与下一步

- ✅ S0 可运行；`npm test` 15 通过 + core 边界检查通过；typecheck 通过
- ✅ 技术栈迁移完成（electron-vite / TS / React / zod / Vitest）；打包 app.asar 已验证
- ✅ 变更纪律落地：`docs/RELEASING.md` + `release.js` 门禁 + `test:e2e` 功能测试
- ✅ fortune-ball 残留已清理（形象收敛为猫、抽签特效与 `fx.js` 移除、死字段移除）
- ✅ **S1「它有自己的生活」（0.3.0）**：`core/petState` 状态机 + `core/quips` 台词库 + 气泡层 + 起名 + 动画开关生效
- ✅ **S2「它记得你 / 笔记本上桌」（0.4.0）**：人格卡 + 长期记忆（≤30 条，可逐条删/全部忘记/开关）+ 每日日记 + 全量备份导出/导入
- ✅ **S2.5「它会在桌面上生活」（0.5.0）**：自主走动 + 爬屏幕边缘 + 天花板倒挂 + 拖甩物理 + 轻音效
- ✅ **S2.6「皮肤与动作架构」（0.6.0）**：动作契约 + 图集渲染 + 换肤不改代码
- ⏳ **S3「许愿瓶（联网 MVP）」进行中（0.7.0 已发）**：客户端与 `packages/server/` 代码就绪、
  本地 mock 跑通全流程；**待部署** Cloudflare 与填写默认地址后才算完成
- ✅ 0.7.0 附带：分区触摸（摸头 / 戳身 / 挠脚）+ 注视鼠标 + 隐私政策更新
- ✅ **S4「它看见你」（0.8.0）**：`core/presence` 离开 / 回来 / 久坐提醒 + `core/weather` 天气氛围
  （默认关闭，Open-Meteo 无需 Key）；只读系统空闲时长，协议版本 → 3
- ✅ **S4.5「更像活物」（0.8.1）**：`core/locomotion` 蹲边探头 / 打盹 / 抓边挂 / 伸懒腰，动作形态补齐
- ✅ 0.8.2 稳定补丁：重置位置不再丢猫（走 `reset-ball` 事件而非移窗口）+ 托盘图标修复
- ✅ **P0「可信的主动 + 它需要你」（0.9.0）**：`core/speech` 观察 → 台词（每句话都有原因）+
  `core/needs` 需求系统（可拒绝、不惩罚、每日 ≤2、0–6 点安静）；227 单测
- ✅ **产品论点与路线重排（2026-11-25）**：新增 [`docs/PRODUCT-THESIS.md`](docs/PRODUCT-THESIS.md)
  与 [`docs/OCCASIONS.md`](docs/OCCASIONS.md)；私人闭环（P1 缺席日志 → P1.5 事件记忆 →
  P2 页边一句）先于社交公开化，每个阶段都有闸门
- ✅ **平台架构（2026-11-25）**：新增 [`docs/PLATFORM.md`](docs/PLATFORM.md)；单仓库私有 monorepo，
  `packages/{contracts,server,web,admin}`；网页只读橱窗、新闻官方编辑、后台 API Key + TOTP
- ✅ **平台 S0 完成（2026-11-25）**：workspaces + `packages/contracts` 唯一契约源（`mailbox.ts` 改为
  re-export，`server/src/rules.ts` 副本删除）+ `server/` 迁入 `packages/server`；231 单测 / 17 e2e
- ✅ **P0.5「不说话的身体」（0.9.4）**：`core/needMotion` 需求 → 动作计划；252 单测 + 真机 6/6
- ✅ **P1「你不在的时候」（0.9.5）**：`core/absence` 缺席日志，确定性 / 允许空白 / 不说数字；270 单测 + 真机 9/9
- ✅ **P1.5「它记得那一天」（0.9.6）**：`core/occasions` 事件记忆，T-1 / 当天 / T+1；299 单测 + 真机 14/14
- ✅ **M7「日常记事」（0.9.9）**：`core/dailyLog` 零 token 抽取 + 晚间复述一次，不维护总额
- ✅ **S4 修补「回来时认出你」（0.9.9）**：`core/presence` 统一离开/回来转移 + suspend/resume；
  离开时长不再被睡眠归零算错；`RETURN_GREET_MIN_MS` 让「回来」有门槛
- ✅ **P2「页边一句话」（0.9.9）**：`DiaryEntry.margin` 与日记隔离（猫重算不冲掉用户的话）；
  允许不回；`scripts/check-margin-privacy.js` 守住「不出网」
- ✅ **记忆界面可见（0.9.9）**：设置里能看/能删「它记得的事」「今天记下的」
- ✅ **工程门禁（0.9.9）**：`check-secrets.js`（密钥）+ `check-margin-privacy.js`（页边不出网）进 `npm test`
- **下一步：部署 S3**——在 `packages/server` 建 D1 / VPS + 填默认地址 + 邀请制冷启动
- 产品侧下一步：按闸门验证 P2 的真实使用数据（打开者周留一句 ≥30%），再决定 S5 猫邮局
- 技术债清单与技术交付清单见 `docs/ARCHITECTURE.md` 第十二节

## 八、文档地图

| 文档 | 用途 | 读者 |
|---|---|---|
| `AGENTS.md`（本文） | 交接速查、宪法、坑位 | AI 协作者 |
| `docs/ROADMAP.md` | 定位、S1–S8 里程碑、闸门、验收、商业化 | 产品 |
| `docs/PRODUCT-THESIS.md` | 产品论点：镜鉴、第四根支柱、语言资产、机制、投资逻辑 | 产品 / 投资人 |
| `docs/OCCASIONS.md` | P1.5 事件记忆规格：数据模型、抽取、隐式确认、接住节奏、验收 | 工程 |
| `docs/PLATFORM.md` | 平台架构：网页橱窗 / 新闻管道 / 管理后台 / monorepo / 资源评估 | 产品 / 工程 |
| `docs/PLATFORM-S0.md` | 平台 S0 执行清单：workspaces、契约收敛、server 迁入、守卫适配、发布渠道、CI | 工程 |
| `docs/REPO-LAYOUT.md` | 仓库设计图：目录结构、依赖方向、守卫、命令 | 工程 |
| `docs/ARCHITECTURE.md` | 技术栈、分层、进程、数据流、IPC、存储、安全、构建、手机端 | 工程 |
| `docs/RELEASING.md` | 变更纪律：文档 + 功能测试 + tag + Release | 所有 |
| `docs/SERVER.md` / `docs/TESTING-BOTTLE.md` | 许愿瓶服务端设计与本地测试 | 工程 |
| `docs/SKIN-AUTHORING.md` | 皮肤与图标制作：prompt 模板 + `npm run pack:skin` | 美术 / 你 |
| `docs/STRIP-LOG.md` | 从 fortune-ball 剥离了什么（追溯） | 工程 |
| `README.md` | 对外介绍与构建方式 | 用户 / 贡献者 |
| `CHANGELOG.md` | 版本变更 | 所有 |
