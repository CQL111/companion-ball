# Changelog

## [0.5.0] — S2.5：它会在桌面上生活（2026-11-20）

### 背景
S1/S2 给了情绪与记忆，但角色仍钉在桌角——缺的是**身体**。参考 Shimeji 类桌宠
（[Little LUMI Model](https://store.steampowered.com/app/5075020/)、[Shimeji-ee](https://sourceforge.net/app/shimeji-ee/)、
[shimeji-rs](https://github.com/danhab99/shimeji-rs)），但明确取舍：
**只爬屏幕四边，不读取任何窗口信息**（隐私红线），节奏保持安静型。

### 新增
- `src/core/locomotion.ts`：桌面上的身体（纯函数，零平台依赖）
  - 自主走动：60–180 秒一次决定；睡觉 / 打盹 / 菜单打开 / 预览动画时不动
  - 攀爬：走到左/右墙 → 沿墙上行 → 抵达屏幕顶部后倒挂行走 6–14 秒 → 落回地面
  - 抛掷物理：松手速度决定抛物线（夹紧 ±1500 px/s），撞左右墙反弹并衰减能量，
    撞天花板，落地进入 420ms 蹲伏
  - 被按住时完全冻结，松手从当前坐标继续
- 渲染端：rAF 循环驱动位置；`#ball[data-loco]` 控制行走 / 攀爬 / 倒挂 / 落地姿态，
  `--face` 控制朝向翻转（仍不动 `.ball` 的 transform）
- `src/renderer/pet/sound.ts`：WebAudio 实时合成轻音效（无音频文件）——
  落地、摸头、爬上顶部；音量很低，设置里可关（`store.sound`，默认开）
- 设置页新增「声音」一节

### 修复
- 抛出速度没有上限时，撞墙反弹反而会让水平速度累积放大——现在释放速度夹紧并在测试中锁死

### 验证
- `npm test` → **93 通过**（新增 locomotion 12 条：抛掷、反弹、能量衰减、按住冻结、
  安静型节奏、攀爬全链路）
- `npm run typecheck` → 无错误
- `npm run test:e2e` → **15/15 通过**（新增 `data-loco` 渲染断言）
- 真机观测（可见窗口）：抛出 → `fall`（先升后落）→ 0.5s 后 `land` → `idle`；
  130 秒观察期内出现 `walk` 连续帧并沿地面移动，符合安静型节奏
## [0.4.0] — S2：它记得你 / 笔记本上桌（2026-11-20）

### 新增
- **人格卡**（`src/core/persona.ts` + `src/data/persona.json`）：物种习性、小习惯、四条边界
  （不是助手 / 不是心理咨询师 / 不装算命先生 / 不索要隐私）、说话规则。
  与用户起的名字合成 system prompt，替换此前只有语气的提示词。
- **长期记忆**（`src/core/memory.ts` + `src/main/remember.ts`）：
  - 对话回复返回后**异步**抽取事实（不阻塞回复，失败静默）
  - 少于 20 字且不足 3 轮的闲聊不花 token
  - 去重（完全相同或互相包含）+ 上限 30 条，超出按时间淘汰最旧的
  - 按时间正序注入 prompt（最近的事实靠近当前对话）
  - 设置页可查看、逐条删除、一键「全部忘记」、开关抽取
- **猫的笔记本**（`src/core/notebook.ts` + `src/renderer/notebook/`）：
  - 每天一条，允许空白；第一人称 2–4 句，**不出现任何数字与统计**
  - 素材来自记忆主题标签与会话轮次，不调模型（零 token）
  - 当天素材变化时**重算**而不是「当天只写一次」——修掉了启动时写下的
    「今天你几乎没出现」一整天不更新的问题
  - 支持导出 Markdown
- **全量备份**（`src/core/backup.ts`）：导出/导入名字、记忆、日记、聊天记录；
  **不含 API Key**（设备凭据应在新设备重新填写）。导入做版本与结构校验，脏数据不整体失败。
- 托盘新增「猫的笔记本」入口；设置页新增「它记得什么」与「数据备份」两节
- 团子猫窗口上报交互次数（点击/拖动/唤醒），作为日记素材

### 变更
- `core/agent.runAgent` 支持注入 `systemPrompt`（缺省仍用内置提示词）
- store 新增 `memories` / `notebook` / `memoryEnabled`，`pet` 增加日记与交互计数字段
- `check-core-boundary` 允许 core 只读引用 `src/data/*.json`（纯内容资产，零依赖）

### 验证
- `npm test` → **81 通过**（agent 15 · petState 19 · quips 11 · memory 17 · notebook 13 · backup 6）+ `check:core`
- `npm run typecheck` → 无错误
- `npm run test:e2e` → **14/14 通过**（新增笔记本窗口、记忆接口、笔记本接口断言）
- 真实行为验证（DeepSeek）：
  - 说「我叫小满，我养了一只叫豆豆的橘猫，最近在学吉他」→ 抽出 2 条记忆
  - 追问「你还记得我叫什么吗」→ 回答中正确说出「小满」
  - 日记由「今天你几乎没出现」重算为「今天你和我说了几句话。我记得你在忙学习的事。」
## [0.3.0] — S1：它有自己的生活（2026-11-20）

### 新增
- `src/core/petState.ts`：情绪状态机（纯函数，零平台依赖）。由「时间 + 空闲时长 + 交互事件」
  推导 7 种情绪：醒着 / 开心 / 好奇 / 打盹 / 睡着 / 不耐烦 / 眩晕
  - 30 分钟无交互趴下打盹，60 分钟睡着；凌晨自动半睡
  - 连点 5 次/10 秒 → 不耐烦；不耐烦期间继续点击不再刷新（避免越烦越唠叨）
  - 拖起 → 好奇；快速甩放（最近 150ms 均速 ≥1.2px/ms）→ 眩晕
  - 唤醒与早安：指针靠近睡觉的猫会被叫醒；早间首次交互说早安，每天只一次
  - 只输出 `mood` 与 `trigger`，不输出动画——手机端可把同一 mood 渲染成小组件文案
- `src/core/quips.ts` + `src/data/quips.json`：台词库 98 条，7 个 bucket
  （tap / wake / morning / night / drag / annoyed / dizzy）+ fallback
  - 20 分钟冷却 + 「最久没说过优先」，全体轮完前不重复
  - 单句 ≤24 字（测试强制）
- 气泡层：`#pet-bubble`，3 秒自灭、不抢焦点、`pointer-events:none`
- 设置页「给它起个名字」（≤16 字），写入 `store.pet.name`
- `store.pet = { name, lastInteractAt, lastGreetDate }`：跨重启恢复情绪（不把旧状态当成新交互）
- 设置「播放角色动画」开关现在**真的生效**：`config-changed` 广播 → `#ball[data-anim]`，
  关闭后停掉过渡、呼吸、眨眼、尾巴与眩晕晃动
- 新增 IPC：`set-pet-name`、事件 `config-changed`；`saveConfig` 会广播给团子猫窗口

### 变更
- 情绪 CSS 重写为 S1 的 7 种 mood（替代 fortune-ball 遗留的 laugh / neutral / cry 三态）
- 气泡样式改为可换行、最大宽 180px；位置贴合 80×80 猫身
- 点击猫：先由状态机记一次点击（可能触发早安 / 不耐烦台词），再打开对话

### 验证
- `npm test` → **44 通过**（agent 15 + petState 18 + quips 11）+ `check:core` 通过
- `npm run typecheck` → 无错误
- `npm run test:e2e` → **11/11 通过**（新增 `data-mood` 与气泡节点断言）
- 行为验证（CDP，真实应用）：初始 `neutral` → 单击 `smile` + 气泡 → 3.5s 后气泡消失；
  连点 5 次 → `annoyed`（实测第 5 次触发，第 6 次不再刷新）

## [0.2.2] — Release notes 提取修复（2026-11-20）

### 修复
- `publish-github.js` 的 CHANGELOG 段落提取在「本版本标题后紧跟另一个标题」时返回空串
  （v0.2.1 的 Release notes 曾为空，已手动补上）；改为按行扫描，不再使用跨行 lookahead

### 验证
- `npm test` → 15 通过 + `check:core` 通过
- 发布后检查 v0.2.2 Release notes 非空

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
