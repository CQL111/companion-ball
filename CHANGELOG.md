# Changelog

## [0.9.3] — 服务端支持自建 VPS（未发布）

> 起因：`*.workers.dev` 子域在国内不可达（实测 `workers-playground` 同样 000），
> Cloudflare 方案对目标用户等于不可用。r2.dev 不受影响，所以下载不受影响。
>
> 做法：把服务端改成「**一套业务逻辑，两个运行时**」，VPS 与 Workers 共用同一份业务代码。

### 新增：平台无关业务层
- `packages/server/src/handler.ts`：输入标准 `Request`、输出标准 `Response`，不出现任何平台类型
- `packages/server/src/db.ts`：最小 `Db` 接口 + `d1Adapter`（Workers）/ `sqliteAdapter`（Node 内置 sqlite）
- `packages/server/src/worker.ts`：Workers 薄适配（原 `index.ts` 拆分而来）
- `packages/server/src/node.ts`：Node 22.5+ 运行时（`node:http` + `node:sqlite`），**零第三方依赖**
- `packages/server/build.mjs`：esbuild 打包成单文件 `dist/node.mjs`

### 修复（独立审查发现的 20 项缺陷中的高危项）
- **IDOR（P0）**：`/v1/report` 原本任何人可用任意 `bottleId` 下架任何瓶子；
  现在只能举报**自己捡到过或自己写的**内容
- **举报无闸（P0）**：`EMERGENCY_OFF` 原本拦不住举报；现在所有写接口统一受开关约束，
  并加单设备每日 20 次上限
- **开放重定向（P1）**：下载跳转原来是前缀匹配，`https://good.example.evil.com` 能过；
  改为同源比较
- **IP 限流可伪造（P1）**：`CF-Connecting-IP` 在外网可被任意伪造；新增 `TRUST_PROXY`
  （默认关闭），只信反代写入的头，否则只认 socket 地址
- **时区刷额度（P1）**：自报 `utcOffsetMinutes` 可多拿一个「日额度」；改为取服务端日与
  客户端日中更早者，撒谎只会更紧
- **并发双写（P1）**：捡瓶/回信原本「先读后写」；改为**条件 UPDATE 原子占位**并检查
  `changes`，实测 10 并发捡同一瓶不超卖、并发回信只成功一个
- **错误不可见（P1）**：Node 侧 `catch {}` 吞掉所有异常；现在打印方法与路径
- **多进程锁（P1）**：SQLite 开 `WAL` + `busy_timeout=5000`，单连接串行执行器，`BEGIN IMMEDIATE`
- **启动静默失败（P1）**：`schema.sql` 缺失时原本照常监听但接口全 500；现在直接退出
- **端口占用崩溃（P2）**：`listen` 增加 `error` 处理，给出可读错误
- **请求体无上限（P2）**：超过 64KB 返回 413
- **下游无超时（P2）**：拉 `latest.json` 加 3 秒超时，避免连接耗尽
- **连接不释放（P2）**：建表用的临时连接显式 `close()`；`close()` 时关闭 DB

### 变更
- 补上文档承诺但从未实现的**设备级速率**：pick 10/小时、inbox 20/小时、report 20/天
- 契约包新增 `RATE_LIMITED` 错误码与文案「慢一点，海面有点挤」
- 新增 `docs/VPS-DEPLOY.md`：systemd、Caddy、环境变量、备份、安全清单

### 验证（本地真实启动 Node 运行时）
- 互投全流程：扔 → 捡 → 回 → 收，全部通过
- 安全用例：未捡到不能回、未见过不能举报、改时区不多拿额度、伪造 IP 头无效
- 并发：10 并发捡同一瓶不超卖、并发回信只成功一个、无 500
- 持久化：重启后数据仍在
- `npm test` → **237 通过**；`npm run check:server` 类型检查通过

## [0.9.2] — 下载页上 Cloudflare Pages（未发布）

> 0.9.1 把安装包发到了 R2，但**产品页没有地方被服务**。本版补上站点托管：
> 静态页 + 两个 Pages Functions，让「打开网页 → 点下载」这条链路完整。

### 新增：站点（`packages/web`）
- 静态页改为 `packages/web/public/index.html`；构建产物 `dist/`（含 `_routes.json`）
- 构建不再依赖任何框架：单页 HTML 直接组装，少一个失败点
- **Pages Functions**（同源，无需 CORS）：
  - `GET /v1/download/manifest` → 代理 R2 `latest.json`
  - `GET /v1/download/latest?os=win|mac` → 302 到 R2 安装包（校验下载域，防开放重定向）
- 下载按钮在取不到版本时自动置灰，不会出现「点了没反应」
- 移除旧的 `docs/index.html`（GitHub Pages 产物）

### 变更
- 根脚本 `build:site` 改为 `npm run build -w @companion/web`
- `packages/web` 新增 `preview` / `deploy`（wrangler pages）

### 验证
- `npm test` → **236 通过** + core 边界检查
- `npm run build:site` → `dist/` 产出正确（`index.html` / `_routes.json` / `.nojekyll`）
- 本地 `wrangler pages dev` 实测：
  - 未配置 `R2_PUBLIC_BASE_URL` → manifest 返回 `503 NO_RELEASE`（页面按钮置灰）
  - 配置后 → manifest 返回 0.9.1 资产，`/latest?os=win` 正确 302 到 R2 安装包

## [0.9.1] — 单仓库 monorepo：瓶子规则收敛为唯一契约源（2026-11-25）

> 起因：`src/core/mailbox.ts` 与 `server/src/rules.ts` 是两份手抄副本，
> 靠 `tests/rules-parity.test.ts` 比对防漂移；`DAILY_BOTTLE_LIMIT` 甚至在客户端写死、
> 服务端走 `wrangler.toml` 字符串——改一处忘一处，两端行为就会打架。
> 本版不加功能，只把「仓库怎么摆」和「规则放哪」这两件底层的事定下来。

### 变更：仓库结构（monorepo）
- 仓库根改为纯编排层：`private: true` + npm workspaces（Node 22 内置，无新工具）
- `src/` → `packages/desktop/src/`；桌面端的测试、脚本、资源、构建配置一并迁入
- `server/` → `packages/server/`（`git mv` 保留历史）
- 新增 `packages/contracts/`、`packages/web/`（产品页与 `build-site`）
- 根目录只保留跨包脚本：`check-core-boundary` / `release` / `publish-github`

### 变更：规则收敛
- 新增 `packages/contracts`：常量 / DTO / 错误码 / 分池 / 生命周期 / 校验 / 代号 / 错误文案
- `src/core/mailbox.ts` 改为 `export * from '@contracts'` 兼容层（只在包里保留 `BottleSettings`）
- `server/src/rules.ts` **删除**；服务端改为 `import … from '@companion/contracts'`
- 加密工具拆到 `packages/server/src/crypto.ts`（契约包保持零依赖）
- `tests/rules-parity.test.ts` → `tests/contracts.test.ts`：从「比对两份」改为「守护唯一源」

### 变更：构建链适配
- `electron.vite.config.ts` / `vitest.config.ts` / 两个 tsconfig 增加 `@contracts` 别名
- `check-core-boundary.js` 允许 core 引用 contracts，并同时守护契约包零依赖
- `build-legal.js` 从仓库根读 `docs/legal/`，写入 `packages/desktop/src/legal-data.js`
- `build-bundled-key.js` / `onlineConfig.ts` 从仓库根读 `.env`
- `smoke.mjs` 的 Electron 可执行文件与 `.env` 指向仓库根
- `release.js` 版本号与产物改以 `packages/desktop` 为准
- `build-site.js` 改名 `.cjs`（`packages/web` 为 ESM 包）

### 文档
- 新增 `docs/PRODUCT-THESIS.md`（产品论点）、`docs/OCCASIONS.md`（事件记忆规格）、
  `docs/PLATFORM.md`（平台架构）、`docs/PLATFORM-S0.md`（执行清单）、`docs/REPO-LAYOUT.md`（仓库设计图）
- `docs/ROADMAP.md` 重排：新增第四根支柱「期待」，私人闭环先于社交公开化，每阶段设闸门
- `docs/ARCHITECTURE.md` / `SERVER.md` / `TESTING-BOTTLE.md` / `README.md` 路径同步

### 新增：安装包改由站点分发（S0-5）
- `scripts/r2.js`：**零依赖** R2 上传（自签 AWS SigV4，path-style 端点），无需 aws-sdk
- `scripts/publish-r2.js`：上传安装包到 `releases/vX.Y.Z/`，维护 `latest.json`（含 SHA-256），支持 `--dry-run`
- `release.js`：新增 `PUBLISH_TARGET=r2|github`，**默认 r2**（私有仓库后 GitHub Release 不再公开）
- 服务端新增公开只读接口：`GET /v1/download/manifest`、`GET /v1/download/latest?os=win|mac`（302 到 R2，校验域名防开放重定向）
- 产品页下载按钮改为读取 manifest，取不到版本时自动置灰；页面内不再出现 GitHub 下载链接
- 外部资源全部走环境变量（`CF_ACCOUNT_ID` / `R2_*` / `SITE_ORIGIN`），见 `.env.example`
- 新增 5 条单测：SigV4 对照 **AWS 官方测试向量**、path-style 路径、环境变量校验、publicUrl

### 修复
- `build/entitlements.mac.plist`（macOS 签名配置）在迁移中被 `.gitignore` 误吞，已从历史恢复

### 验证
- `npm test` → **236 通过**（17 个测试文件）+ core 边界与契约零依赖检查通过
- `npm run typecheck` → 桌面端两套 + 契约；`npm run check:server` → 通过
- `npm run build` + `npm run test:e2e` → **17/17 通过**（含真实 AI 对话）
- `npm run mock:bottle` / `npm run build:site` / `npm run build:legal` 均正常
- `node scripts/publish-r2.js --dry-run` → 输出正确的资产计划与 `latest.json`

## [0.9.0] — 可信的主动：每句话都有原因 + 它需要你（2026-11-23）

> 起因：「他说的每句话都是固定的，我对他无感。」
> 诊断：随机开口本身是可感知的——一旦察觉，主动说话就变成噪音。

### 新增：可信的主动（`core/speech.ts`，15 条单测）
- **先有观察，再有台词**。每次主动开口必须产出 `Observation`，它来自真实状态：
  - 你刚回来（离开 ≥30 分钟）
  - 你离开很久（≥2 小时，触发 `sulk`）
  - 久坐（我坐了多少分钟）
  - 长时间未交互（弱理由，3 小时内只提一次）
  - 天气（雨 / 雪 / 雷暴）
  - 需求（饿了 / 无聊 / 想你）
- 观察 → **专用台词组**：新增 `sitting`（久坐）与 `idle`（长时间未交互）两组，
  不再拿无关台词硬拼（之前会说出「你坐了62分钟。我尾巴刚才抽了一下。」这种话）
- 合成格式：`你坐了62分钟。起来走两步吧。`
- 统一打扰预算：**两次主动开口至少间隔 10 分钟**

### 新增：它需要你（`core/needs.ts`，12 条单测）
一条被忽略的产品洞见：**没有诉求的东西，用户不会投入情感。**

- 三种需求：饿了 / 无聊 / 想你，轮流出现
- **可拒绝，不惩罚**：拒绝只让它安静 90 分钟，不累积任何「好感下降」
  - 单测明确锁死：拒绝不会改变 `todayCount` / `day` 之外任何字段
- **每天最多 2 次**，两次至少间隔 90 分钟，**0–6 点不提需求**
- 请求 10 分钟未回应即自己放弃，不纠缠
- **说出口不算满足**：只有用户真的碰它才算，并回一句「吃饱了。」
- 睡觉 / 打盹时所有主动表达暂停

### 变更
- 久坐提醒不再由主进程烘焙文案，改为发送「坐了 N 分钟」的事实，文案统一由
  「观察 → 台词」生成——避免不同渠道的口气分裂

### 验证
- `npm test` → **227 通过**（新增 speech 15 + needs 12）+ `check:core` 通过（17 个 core 文件）
- `npm run test:e2e` → 17/17 通过
- 真机逐项验收：
  - 需求 → `肚子在叫。` → 碰它 → `吃饱了。`
  - 久坐 → `你坐了62分钟。起来走两步吧。`
  - 回来 → `你回来了。去哪了？`
  - 空闲 → `你坐了好一会儿了。不用管我。`

## [0.8.2] — 修复：重置位置丢失 + 托盘图标消失（2026-11-23）

### 修复
- **托盘「重置位置」后猫不见了**：旧代码对 `ballWindow` 调 `setPosition(x, y)`，但
  `ballWindow` 是**全屏透明覆盖层**，猫的位置由渲染端的 `transform` 决定。
  把窗口按 transform 坐标移动，等于把整层移出屏幕，看起来就是「猫丢了」。
  - 现在：清空存档 + 通过 `reset-ball` 事件通知渲染端回到默认位置
  - 抽出 `resetBallPosition()`，托盘与调试入口共用同一条路径
  - 新增 e2e 回归断言（重置后必须在屏幕右下角默认位置）
- **托盘图标不显示**：`resourceFile()` 用 `process.env.NODE_ENV !== 'development'` 判断，
  但 electron-vite **不会注入 `NODE_ENV` 到主进程**。dev 模式下路径因此指向
  `node_modules/electron/dist/resources`（那里没有 tray.png），图标静默变成空图。
  - 改用 `app.isPackaged` 判断
  - 图标加载失败不再静默：写 `error` 日志并回退到 `icon-sm.png`
  - 创建成功后写一条 `tray created (ok)` 日志，便于下次排查

### 顺带清理
- `CH` 常量表里混入了 3 个本属于事件的天气通道名（`weatherStatus/weatherLookup/weatherSet`
  同时出现在 `CH` 与 `EV`），已移回 `CH`
- 新增 `debugResetBall` IPC，仅用于 e2e 驱动真实重置路径

### 验证
- `npm test` → 200 通过 + `check:core` 通过
- `npm run test:e2e` → **17/17 通过**（新增重置位置回归）
- 真机：重置后 (494,100) → (1416,792) 右下角默认位置；托盘日志 `created (ok)`

## [0.8.1] — S4.5：更像活物（2026-11-20）

> 三个行为：它会跟着你走过去、被拖到边缘会扒住、困了自己找地方睡。

### 新增
- **跟鼠标走**（`locomotion` 的 `seek` 计划）：
  - 鼠标静止 ≥1.5 秒才被视为「兴趣点」，移动立刻取消
  - 走过去后停一会儿抬头看；有 3 分钟冷却，目标太近（<40px）不追
- **拖到边缘扒住**（`perch` 状态）：
  - 慢速（<260 px/s）拖到左右边缘 18px 内松手 → 扒住不掉
  - **只点一下（未拖动）不会扒住**，避免静止在边缘时误触发
  - 14 秒后自然松手落地；快速甩动仍是惯性优先
- **困了自己找地方睡**（`snooze` 计划）：
  - 进入打盹/睡着时，走到最近的屏幕角落趴下
  - 即使在 `canWander=false`（睡觉时禁止闲逛）也允许这一段移动——这是「自己要睡」
  - 醒来后回到待机

### 修复
- **走不到目标位置的关键 bug**：`walk` 分支只识别 `plan.kind === 'walk'` 的目标，
  `seek` / `snooze` 计划的目标被算成当前位置，导致状态切换了但**猫原地不动**。
  单测此前只断言状态、不断言位移，没有发现这个问题。
- 补充断言：跟鼠标与找地方睡都必须**真的改变位置**

### 验证
- `npm test` → **200 通过**（新增 S4.5 locomotion 19 条）+ `check:core` 通过
- `npm run test:e2e` → 16/16 通过
- 真机验收：
  - 跟鼠标：90 秒内出现 `walk`，位置 200 → 988
  - 扒边缘：慢速拖到 x=0 → `perch`，16 秒后 `idle`
  - 找地方睡：176 → 0，5 秒到位并稳定在 `snooze`

## [0.8.0] — S4：它看见你（2026-11-20）

> 宠物从「看见鼠标」升级到「看见你」：知道你离开、回来、坐了多久，以及外面在下什么。

### 新增：在场感知（`core/presence.ts`，12 条单测）
- **离开 / 回来**：系统空闲 ≥5 分钟或锁屏即视为离开；回来时角色有反应
  - 短暂离开（<2 小时）→ 抬头看你
  - 长时间离开（≥2 小时）→ 先「闷」一下（新情绪 `sulk`，5 秒）再亲近——是等你，不是生气
  - 新增 8 句「你回来了」台词
- **久坐提醒**：连续坐满 50 分钟提醒一次，之后每 50 分钟一次
  - 两次提醒间隔 ≥50 分钟；每日最多 3 次；**离开会重置计时**
  - 文案不说教、不指责，例如「肩膀放下来一点。」
  - 设置页可关闭（默认开）

### 新增：天气氛围（`core/weather.ts`，16 条单测）
- **默认关闭**，需填写城市并主动开启
- 数据源 **Open-Meteo**（免费、无需 API Key——因此没有可泄露的凭据）
- 只发送城市经纬度；城市信息仅存本地
- **纯氛围，不播报**：不显示温度、不弹通知、不记历史
  - 天气代码 → 氛围（晴 / 多云 / 雨 / 雪 / 雷暴 / 雾）
  - 只在「雨 / 雪 / 雷暴」且 3 小时未提过时说一句
  - 雨天 / 雪天 / 雾会影响基础情绪倾向（更安静），不覆盖用户交互

### 隐私与合规
- 隐私政策新增「天气氛围」章节（第一节第 6 小节）：明确发送内容、接收方、关闭方式
- 第三方服务清单补 Open-Meteo
- 开头总述改为「会离开本机的只有两类数据，且默认关闭」
- **`AGREEMENT_VERSION` 2 → 3**（新增一类出网数据，必须重新同意）

### 修复
- 久坐提醒的两个常量互相冲突（60 分钟宽限 > 50 分钟间隔，导致永不触发），已合并为一个

### 验证
- `npm test` → **181 通过**（新增 presence 12 + weather 16）+ `check:core` 通过
- `npm run test:e2e` → 16/16 通过
- 真机验收（真实 Open-Meteo API）：
  - 默认关闭 → `{enabled:false, current:null}`
  - 查询「杭州」→ `杭州，浙江，中国 (30.29, 120.16)`
  - 开启后 → `current: {kind:'clear', isDay:false}`
  - 关闭后 → 状态清空
  - `presence.watcher started` 正常，preload 三个感知事件均已暴露

## [0.7.0] — 宠物会注意到你 + 许愿瓶就绪（2026-11-20）

> 这一版包含两块：**宠物互动增强**（已完成）与**许愿瓶客户端 + 服务端代码**（就绪，
> 但服务端尚未部署，因此路线图中的 S3 仍为「进行中」，不计入完成）。

### 新增：宠物互动
- **分区触摸**（`core/touch.ts`，15 条单测）：按落点区分
  - 摸头 → `pat`（眯眼笑、压耳朵、冒爱心）+ 专属台词
  - 戳身体 → `tap`（普通反应）
  - 挠脚/下腹 → `grumble`（皱眉撇嘴、身体后缩）+ 专属台词
- **注视**：主进程每 80ms 推送光标位置，角色把目光移向鼠标；超过 220px 或睡觉时不看
- 动作契约从 14 个增加到 **17 个**（新增 `look` / `pat` / `grumble`），占位图集同步重绘
- 台词库新增 `pat` / `grumble` 两组，共 153 条单测覆盖

### 新增：许愿瓶（代码就绪）
- `src/core/mailbox.ts`：时段分池、7 天沉海、内容校验、匿名代号、投递/回信状态机
- `server/`：Cloudflare Workers + D1 实现（扔 / 捡 / 回 / 收 / 举报 + 限流 + 紧急开关）
- 客户端：设置页开关（**默认关闭**）、许愿瓶窗口、设备令牌（installId 派生 HMAC）、
  猫的自动巡游（每 10 分钟检查一次）、托盘「让猫出门看看」
- **服务端未部署时界面显示「猫邮局还没开门」**，不产生任何网络请求
- `scripts/mock-bottle-server.mjs`（`npm run mock:bottle`）：零依赖内存 mock，本地可跑全流程
- 测试：`tests/rules-parity.test.ts` 防止客户端与服务端规则副本漂移

### 合规
- 隐私政策新增「许愿瓶」章节（数据清单、保留期限、明确不收集的内容、功能边界）
- 第三方服务清单补 Cloudflare
- **`AGREEMENT_VERSION` 1 → 2**：老用户更新后会重新看到协议同意页（隐私政策实质变更）
- 同意页增加许愿瓶说明

### 修复
- **点一下猫会从当前位置掉到地面**：`pointerup` 无论是否拖动都进入自由落体。
  现在只有真正拖动过才释放物理，单击保持原位
- `grumble` 与 `pat` 表情几乎一样：生成器新增「下压斜眼 + 眉 + 撇嘴」
- e2e 硬编码 `consentVersion: 1`，协议版本一升就卡在同意页；改为从源码读取当前版本

### 文档
- 新增 `docs/SERVER.md`（服务端设计、威胁模型、发布地区策略）
- 新增 `docs/TESTING-BOTTLE.md`（本地测试指南）
- 新增 `docs/SKIN-AUTHORING.md`（美术 prompt 模板 + 图集打包）
- 新增 `scripts/pack-skin.mjs`（`npm run pack:skin`）：单帧 → 图集 + manifest

### 验证
- `npm test` → **153 通过** + `check:core` 通过
- `npm run test:e2e` → 16/16 通过
- 真机验收：摸头 → `pat` +「这样挺好的。」；挠脚 → `grumble` +「哼，走开了。」；
  单击后位置不变（y=500 → y=500）
- 许愿瓶对 mock 服务端跑通：扔瓶 / 捡瓶 / 回信 / 每日上限 / 举报隐藏

## [0.6.0] — 角色换成可换肤的图集渲染（2026-11-20）

### 新增
- **动作契约** `src/core/motion.ts`（零平台依赖，18 条单测）：
  - 14 个动作名 × 两个视角：`front`（待机 / 睡觉 / 舔爪 / 伸懒腰 / 被点 / 生气 / 眩晕 / 唤醒）
    与 `side`（走路 / 攀爬 / 倒挂 / 腾空 / 落地 / 被拿起）
  - 只有侧影允许镜像；**正面永不翻转**（镜像会把身体翻到背面）
  - 动作回退链（`fallbacks`）：皮肤缺某个动作时向上回退，最终落到 `idle`
  - `SkinManifest.engine: 'atlas' | 'spine'`：同一份契约，未来可接 Spine 骨骼皮肤
  - **换皮肤 = 换一份 manifest + 一套素材，不改代码**
- **占位素材生成器** `scripts/build-skin.mjs`（`npm run build:skin`）：
  程序化绘制 8 列 × 14 行动作图 + manifest。3 倍超采样绘制（48px 逻辑尺寸下不糊），
  阴影不进角色帧（避免镜像时跟着翻），倒挂单独绘制（不再靠旋转 180°）。
- **渲染适配器** `src/renderer/pet/renderer.ts`（Canvas 2D，约 100 行）：
  帧推进、回退链、侧影镜像、DPR 适配。对外只有 `setClip / setFacing / render / destroy`，
  以后换 PixiJS 或 Spine 只需替换这一个文件。

### 变更
- 宠物窗口不再用手写 SVG 骨架：角色改由图集渲染到 `<canvas>`，动作由
  `clipForState(身体状态, 情绪, 原地动作)` 决定
- 皮肤素材经 Vite 的 `?url` 导入，dev 与打包后路径一致
- 走动 / 攀爬 / 腾空时自动收起菜单，避免遮挡动作

### 修复
- **气泡文字被挤成一列**：气泡绝对定位在 80px 宽的 `.ball` 内且 `left:50%`，
  可用宽度只有 40px，换行后每行一个字。改用 `width: max-content` + `max-width: 180px`
- **气泡贴边出界**：猫走到屏幕左右边缘时气泡会被裁掉；现在显示后测量并向内平移，
  小三角反向补偿仍指向猫
- **替换角色样式时误删菜单与气泡整段 CSS**：截图发现菜单变成无样式方块，已补回
- `fetch` 在 `file://` 下被拦截导致皮肤加载失败：改用 Vite 资源导入
- 画布未按 DPR 缩放导致发虚：现在按设备像素比输出（48 → 120）

### 验证
- `npm test` → **111 通过**（新增 motion 18 条）+ `check:core` 通过
- `npm run test:e2e` → **16/16 通过**（新增「图集渲染出真实像素」与「渲染器报告当前动作」）
- 真机验收：画布 6997 个不透明像素；动作依次出现 `idle → walk → climb → hang`；
  气泡居中宽 44px、贴边时自动内移，3 秒自灭；日志无 error

## [0.5.1] — 修复页面滚动 + 角色重画 + 动作形态（2026-11-20）

### 修复
- **设置页与笔记本无法滚动**：根因是 React 挂载点 `#root` 没有高度，
  内容把 `#root` 撑到 2148px，再被 `body { overflow: hidden }` 裁掉（实测
  `clientHeight 645 / scrollHeight 2153`）。补 `#root { height: 100% }` 后恢复滚动。
- 倒挂姿态整只猫被旋转移出可视区：`.pet-all` 缺 `transform-box`，旋转绕到盒子外。

### 变更（角色与动作）
- **重画角色**：原来的「球」没有腿，任何走动动画都只能是整体晃动。现在有头、口鼻、
  耳朵、呆毛、四条腿与爪、胡须、瞳孔；层次重排为
  「地面 → 尾巴 → 后腿 → 身体 → 前腿 → 耳朵 → 头 → 脸」。
- **动作姿态**：站立 / 走路（四肢交替）/ 攀爬（整体侧转 90°）/ 天花板倒挂（180°）/
  腾空（四肢张开）/ 落地（压缩回弹）/ 被拿起（四肢下垂）。
- **原地小动作**：伸懒腰、舔爪（新增 `data-act` 属性，一次性播放）。
- **情绪联动**：7 种情绪各自改眼睛（睁眼 / 眯眼 / 闭眼）、耳朵角度、腮红与尾巴节奏。
- 毛色由灰紫调为奶白粉，眼睛改为深色并加高光。

### 可见性
- 自主决策间隔从 60–180 秒缩短到 25–70 秒；动作权重改为走 45% / 爬 30% / 伸懒腰 12% /
  舔爪 8%；走路速度 46→60 px/s，与 0.42s 步频配合。

### 验证
- `npm test` → 93 通过 + `check:core` 通过
- `npm run test:e2e` → 15/15 通过
- 真机截图逐姿态验收（`shots/`）：站立、走路、攀爬、倒挂均在可视区内正确显示
- 设置页滚动实测：`scrollHeight 2153 > clientHeight 645`，`scrollTop` 可写入

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
