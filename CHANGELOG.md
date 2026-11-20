# Changelog

## [0.2.1] — 发布流程加固（2026-11-20）

### 修复
- **Release 重复创建**：`electron-builder --publish always` 在多个产物并发生成时会重复 POST
  创建同名 tag 的 Release（v0.2.0 实际产生了 2 个 Release）。改用 `--publish never` 本地构建，
  再由新增的 `scripts/publish-github.js` 按 tag 查找/创建 Release、逐个上传并校验资产
- **资产缺失**：发布中断后仅剩 `blockmap` 一个资产；新脚本会校验每个产物是否远端存在，
  缺失即退出码 1
- **发布顺序**：先构建（产物在 `dist-public/<version>/`）再 tag/push，避免「有 tag 没有安装包」
- **EBUSY**：`directories.output` 带版本号，Windows 残留进程锁住旧 `app.asar` 不再影响下一次打包
- Release notes 由脚本从 CHANGELOG 读取写入，不再依赖 `gh` CLI

### 安全性
- 内置 Key 版（含真实 Key）**永不发布到 GitHub Release**；需要时本机 `npm run build:key`
  （v0.2.0 发布时已执行此策略）

### 验证
- `npm test` → 15 通过 + `check:core` 通过
- `npm run typecheck` → 无错误
- `npm run test:e2e` → 9/9 通过（连跑两次稳定）
- `node scripts/publish-github.js 0.2.0 out-public-2` → 复用已有 Release、重传并校验 3 个资产全部通过
  （幂等性验证）
- GitHub Release v0.2.0 现有资产：安装包 73.6 MB + blockmap 0.1 MB + latest.yml

## [0.2.0] — 架构迁移：electron-vite + TypeScript + React 19（2026-11-20）

### 流程（本次新增的变更纪律）
- 每一次变更都必须同时满足四件事：**文档记录 + 功能测试 + tag + GitHub Release**
- `scripts/release.js` 增加门禁：工作区干净 → CHANGELOG 有对应版本条目 → `npm test` → `npm run typecheck`
  → `npm run build` → `npm run test:e2e`，任何一项失败都不推送到远程
- 新增 `tests/e2e/smoke.mjs`：真实启动应用，经 CDP 验证宠物窗口、设置窗口、对话浮窗，
  以及一次真实对话（有 Key 时）；`npm run test:all` 一键跑单测 + 构建 + 功能测试
- Release notes 自动取 CHANGELOG 中该版本的段落
- **安全边界**：`release.js` 只发布公开版；内置 Key 版（含真实 Key）永不进入 GitHub Release，
  需要时本机 `npm run build:key` 产出到 `out-release-key/`
- 流程文档见 `docs/RELEASING.md`

### 架构迁移：electron-vite + TypeScript + React 19

**构建**
- 迁移到 **electron-vite 4 + Vite 7**：main / preload / renderer 三段构建（HMR、按窗口多入口）
- 全量 **TypeScript 5.9（strict）**；`npm run typecheck` 检查主进程与渲染端
- **zod 4** 做 IPC 入参与配置键校验（仅主进程；通道名拆到零依赖的 `shared/channels.ts`，
  避免 zod 被打进 preload：182 kB → 4.2 kB）
- **Vitest 3** 替代手写 `smoke-test.js`（15 条断言 + `check:core`）
- `check-core-boundary` 支持 TS / ESM import / `node:` 前缀，core 现在真的被守护

**代码结构**
- `main.js`（1.2k 行）拆为 `src/main/`：`index`（入口）· `windows` · `tray` · `ipc` ·
  `cursor` · `chat` · `diagnostics` · `shortcut` · `store` · `state` · `scripts` + `services/`
- `src/core/`（零平台依赖）：`agent.ts` 迁入，`types.ts` 领域类型，`logger-types.ts` 注入接口
- `src/shared/`：通道名常量、zod schema、`CompanionApi` 契约
- `preload.js` → `src/preload/index.ts`，实现 `CompanionApi` 接口（TS 强制两端一致）
- 渲染端：宠物窗口保持**命令式 TS**（`src/renderer/pet/`）；聊天 / 设置 / 协议 / 法律改为
  **React 19**（`src/renderer/{chat,settings,consent,legal}/`）
- 样式与资源迁到 `src/renderer/styles/`、`resources/`

**打包**
- `files` 改为只收 `out/**`，排除 `src / tests / docs / scripts / resources`；
  已验证 asar 中不含源码，且打包后的 exe 能正常启动
- 内置 Key 文件 `bundled-ai.json` 从 `build/` 移到仓库根（仍 gitignore）
- 产物目录：`out-release/`（默认）、`out-public/`（公开版）、`out-release-key/`（个人版）
- 图标与托盘图迁到 `resources/`（`buildResources` + `extraResources`）

**文档**
- `docs/ROADMAP.md` 重写为产品路线图：定位、三根支柱 + 猫的笔记本、S1–S7 里程碑与验收标准
- `docs/ARCHITECTURE.md` 重写为技术架构：技术栈与选型、分层目录、依赖方向、进程模型、
  数据流、IPC 契约、持久化、AI 成本、安全、构建、测试、技术债、手机端扩展
- `AGENTS.md` 重组为交接速查（宪法 / 命令 / 坑位 / 代码地图 / 文档地图）
- 原剥离清单迁至 `docs/STRIP-LOG.md`
- 确立「猫的笔记本」为一等公民：记忆的界面 / 仪式的入口 / 许愿瓶的归宿
- 明确「猫邮局」= 匿名漂流确认，不是传统交友；社交排到 S3 之后，公开上线延后
- 商业化章节：信封收费（卖信纸不卖被听见）、定价、渠道资质阻塞、S6.1/S6.2 分步
- 跨端预留：`src/core/` 零平台依赖、恢复码同步、Key 不进客户端

**其他变更**
- 设置页：形象下拉只剩「团子猫」并注明 S7 皮肤计划；动画提示与免责文案改写为陪伴口径
- 对话浮窗：占位文案与按钮文案改为陪伴口径
- `core/agent.SYSTEM_PROMPT` 强化角色边界（不是助手 / 不做心理诊断）
- 「预览动画」改为一次呼吸反馈，尊重系统「减少动态效果」
- 修复：`pointercancel` 调用未定义的 `closeOrbitNow`（拖拽被打断时抛错）
- 修复：设置页把旧形象值写进只剩单选项的下拉（会变成空值）

### 移除（fortune-ball 残留清理）
- 桌面形象收敛为团子猫：删除 `dog` / `caishen` / `lots` 的 SVG、CSS 与菜单项
  （托盘「桌面形象」子菜单随之只剩「猫」；旧的 store 值自动回落为 `cat`）
- 抽签特效体系：`src/js/fx.js`、`#fx` 画布、`.screen-flash`、蓄力光晕、
  签筒/财神动画段落（`lots-stage` / `caishen-stage` / `shaking` / `golden` / `charging`）
- `ball.js` 死代码：`setMood`（运势分值表情位）、`setColor / hexToRgb / rgbToHex`、
  引用未定义变量的 `resetBallToOriginal` + `onResetBall` 订阅
- 死字段 `agentChat.scene` / `agentScene`（fortune-ball 的运势场景）
- 构建配置中不存在的 `.persona-anim.js` / `.stick-shot.js` 忽略项
- `package.json` 的 `fortune` 关键词

### 验证
- `npm test` → Vitest 15 通过 + `check:core` 通过
- `npm run typecheck` → node 与 web 两套 tsconfig 均无错误
- `npm run test:e2e` → 9/9 通过（宠物窗口 / 设置窗口 / 对话浮窗 / 真实对话 / 日志无 error）
- 打包验证：asar 内仅 `out/` 与 `package.json`，打包版以 `app.isPackaged=true` 正常启动
- CDP 冒烟：通过宠物窗口调用 `openSettings()` / `openAiInput()`，确认两个 React 窗口渲染；
  在聊天窗口发送消息，DeepSeek 返回并渲染（674ms / 105 tokens）
- `electron-builder --dir`：asar 内仅 `out/` 与 `package.json`，不含 `src / tests / docs`；
  打包后的 exe 以 `app.isPackaged=true` 正常启动

## [0.1.0] — S0：从 fortune-ball 剥离（2026-11-19）

### 新增
- 独立项目 `companion-ball`：桌面陪伴 · 团子猫
- 陪伴壳：全屏透明窗口、点击穿透、拖拽、位置记忆、托盘、开机自启、单实例、DPI 处理
- AI 多轮对话骨架（DeepSeek / 本机 Ollama），S0 无工具调用
- 首次启动协议同意 + 法律文档（隐私 / 用户协议 / 免责 / 第三方）
- 双版本构建（公开版 `companion-ball-public.Setup.*`、内置 Key 版 `companion-ball.Setup.*`）
- GitHub Pages 产品页（`product-intro.html` → `docs/index.html`）

### 变更
- appId / userData / productName / 仓库名全部与 fortune-ball 隔离
- 法律文档与同意页文案改写为陪伴产品口径

### 移除
- 运势 / 黄历 / 农历 / 节气 / 典籍引擎
- 运势卡片（5 风格）、运势精灵、连续天数、行为偏好
- 签文 / 塔罗 / 宜忌 / 吉言 / 时辰提点等数据

### 验证
- `node smoke-test.js` → 21 通过
- 本地启动：协议页 → 主界面，托盘菜单、拖拽、位置持久化、设置面板正常
