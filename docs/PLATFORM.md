# 平台架构：桌面 + 猫邮局网页 + 管理后台

> 这份文档回答：**团子猫从单机应用变成联网服务后，整个平台长什么样、分几个仓库、要多少资源。**
> 产品原则见 [`PRODUCT-THESIS.md`](PRODUCT-THESIS.md)；瓶子规则见 [`SERVER.md`](SERVER.md)；
> 事件记忆见 [`OCCASIONS.md`](OCCASIONS.md)。本文是**设计**，不是实施计划；实施按第十二节分阶段。

## 一、结论先行（四项决策）

| # | 决策 | 建议 | 理由 |
|---|---|---|---|
| D1 | 网页版漂流瓶能不能写 | **只读橱窗，不能写** | 网页没有设备令牌与限流基线，匿名写必然被刷；写始终留在桌面客户端 |
| D2 | 新闻从哪来 | **官方编辑部 + 人工发布**；RSS 只作为后台选题来源 | 直连 RSS = 版权、质量、不可控三连；新闻要进「猫的笔记本」，必须可控 |
| D3 | 管理后台怎么登录 | **API Key + TOTP**，邀请制、无公开注册；不存明文密码、不上 Workers Paid | 只调用 WebCrypto 标准原语（SHA-256 / HMAC / AES-GCM），不发明算法；免费档 CPU 足够 |
| D4 | 仓库结构 | **单仓库 monorepo（私有）**：根包 = 桌面端，`packages/{contracts,server,web,admin}` | 一次 PR 三端同步、无私有 registry；代价是发布渠道需改走 R2 + 自有域名，且不能选择性开源 |

> 一句话形态：**一份契约，两份内容池，三个入口**——桌面端**写**，网页端**看**，后台**管**。
> 契约（`packages/contracts`，见第九节）现在还不存在，是平台 S0 的第一步；它要消灭的正是
> `src/core/mailbox.ts` 与 `server/src/rules.ts` 这两份手抄副本。

## 二、产品分层与内容流

```
        内容（同一 Worker，三个独立存储）
┌─────────────────────┬─────────────────────┬─────────────────────┐
│ 私池                │ 橱窗（快照）          │ 新闻（官方）          │
│ bottles / replies   │ gallery_bottles     │ news                │
│ / picks             │                     │                     │
│ 7 天沉海、不可私聊    │ 人工审核、30 天下架   │ 编辑发布、只读        │
└──────────┬──────────┴──────────┬──────────┴──────────┬──────────┘
           │  写                  │  只读                │  只读
           │                      │                      │
┌──────────▼─────────┐  ┌─────────▼─────────┐  ┌─────────▼──────────┐
│ 桌面客户端          │  │ 猫邮局 Web（静态页） │  │ 管理后台            │
│ Electron           │  │ 橱窗 / 新闻 / 下载  │  │ 审核 / 编排 / 开关  │
│ 写瓶 / 捡瓶 /       │  │ / 法务页            │  │ / 指标 / 审计       │
│ 新闻进笔记本        │  │ 无账号、无 Cookie   │  │ 自建账号 + TOTP     │
└────────────────────┘  └────────────────────┘  └────────────────────┘
           │                      │                      │
           └──────────────────────┴──────────────────────┘
                        同一套 /v1/* 与 /admin/*
                        同一套 packages/contracts
```

**内容从哪来、到哪去：**

| 内容 | 产生 | 审核 | 展示 |
|---|---|---|---|
| 私池瓶子 | 桌面端写（设备令牌） | 事后：正则 + 举报 + 每日抽查 | 只被另一台桌面端捡到 |
| 橱窗瓶子 | 桌面端写时**逐条勾选**「可公开」 | 事前：机审 + 人工批准 | 网页只读（快照）；**不进入捡瓶通道** |
| 新闻 | 官方后台编辑 | 发布即审核（自己人） | 网页列表 + 桌面端每天最多 1 条进笔记本 |
| 回信 | 桌面端写 | 事后：正则 + 举报 | 只回到原投递者的 `inbox` |

## 三、系统架构

### 组件

| 组件 | 职责 | 部署 |
|---|---|---|
| **单 Worker（API + 站点）** | `/v1/*` 公开接口、`/admin/api/*` 后台接口、`/news` 服务端渲染、静态资源（`assets` 绑定） | Cloudflare Workers |
| **Cron** | 沉海、橱窗过期、举报归档、日统计汇总 | Workers Cron Triggers（同一 Worker 的 `scheduled`） |
| **D1** | 结构化数据：bottles / gallery / news / reports / admin / audit | Cloudflare D1 |
| **KV** | 紧急开关、公告、**非安全关键**的粗粒度限流 | Cloudflare KV |
| **R2** | 新闻封面、产品截图、安装包分发 | Cloudflare R2 |

> **2026-11-26 修订：不再使用 Cloudflare Pages。** 站点与后台都作为静态资源由**同一个 Worker**
> 提供（Wrangler `assets` 绑定）。理由见下节「同源部署」。

---

### 同源部署（2026-11-26 定，取代原「Pages + Functions」）

**决定**：站点、后台、API 全部在**同一个自定义域名**下，由一个 Worker 提供。

```
https://boringtime.cn/             → 静态：首页 / 橱窗 / 下载 / 法务
https://boringtime.cn/news/:id     → Worker 渲染 HTML（SEO + OG 标签）
https://boringtime.cn/admin        → 静态 SPA
https://boringtime.cn/v1/*         → JSON API（桌面端 + 公开只读）
https://boringtime.cn/admin/api/*  → JSON API（后台，会话 Cookie）
```

**为什么改（原 Pages 方案的问题）**：

| 问题 | 后果 |
|---|---|
| 后台 SPA 与 API 不同源 | Cookie 必须 `SameSite=None; Secure`，CSRF 防护被削弱，还要维护 CORS 白名单与预检 |
| Pages + Functions + 独立 Worker | 三个部署单元、三套环境变量、三处域名配置；私有仓库下预览环境也用不上 |
| 路由优先级（Pages 与 Worker Routes 共存） | 需要实测验证，是一类隐性故障源 |

同源之后：**零 CORS、Cookie `SameSite=Strict` 直接可用、一个部署单元、一次 `wrangler deploy`**。

**代价（已接受）**：失去 Pages 的 PR 预览部署。私有仓库 + 单人开发，这个代价可接受。

**域名**：`boringtime.cn`（2026-11-26 定），Worker 绑定自定义域；`*.workers.dev` 保留作调试入口，
但**不对外公布**（国内不可达，见 `SERVER.md` 第〇节）。

**SEO 分工**：只有 `/news/:id` 需要服务端渲染（标题 / 摘要 / OG）；`/gallery` 全程 `noindex`，
用静态页 + 客户端拉接口即可（见 `WINDOW.md` 4.3）。

### 部署目标与可迁移性（2026-11-25 定）

**结论**：先用 **Cloudflare（免费档）上线，不买服务器、不碰运维**。但代码要保留
「换一个适配器就能搬到自己的 VPS」的路径——这是保险，不是现在的目标。

| 约束 | 做法 |
|---|---|
| 业务逻辑不依赖 Cloudflare 类型 | `server/src/index.ts` 目前直接接收 `D1Database`。**S0 时抽出最小 `Db` 接口**（`prepare / bind / first / all / run / batch`），业务代码只依赖它 |
| 运行时只依赖标准 Web API | `Request / Response / crypto.subtle` 都是标准；不 import `wrangler` 或 `cloudflare:*` |
| SQL 保持标准 SQLite | 不写 D1 专属语法；建表脚本幂等，可被 `node:sqlite` 直接执行 |
| 定时任务与请求解耦 | 沉海 / 清理写成独立函数，Cron 只是调用方 |
| 配置走环境变量 | `EMERGENCY_OFF` / 限额等与 `wrangler.toml` 解耦 |

> 将来若迁到自有 VPS：Hono/Node 22 + `node:sqlite` + Caddy（自动 HTTPS）+ 每日 `.backup`，
> 约 1 天工作量。**不迁也可以**——Cloudflare 免费档对万级 DAU 够用。

> 为什么 API 与 Admin 先放一个 Worker：部署简单、成本为零；路由组 + 会话 Cookie 已足够隔离。
> 等后台访问量或权限要求上升，再拆成独立 Worker——**只拆部署，不拆代码结构**。

### 环境

| 环境 | 用途 | D1 | 访问 |
|---|---|---|---|
| `dev` | 本地 `wrangler dev` + 本地 D1 | 本地 sqlite | 无 |
| `staging` | 每 PR / main 自动部署 | 独立 D1 | 内部 |
| `prod` | 发布版客户端 | 生产 D1 | 公开 |

三套配置放在 `wrangler.toml` 的 `[env.*]`；密钥走 `wrangler secret put`，**客户端永不持有任何服务端密钥**。

### 请求链路（桌面端捡瓶为例）

```
桌面端 → POST /v1/bottle/pick  (X-Device-Token: 哈希)
        → Worker 校验令牌 + 限流（KV/DO 计数）
        → D1 选池内未过期、未被自己捡过的瓶子
        → 写 picks、picks+1
        → 返回 { body, alias }（不含任何作者标识）
```

> **产品形态见 [`WINDOW.md`](WINDOW.md)**：本文件只描述基础设施（组件、部署、数据、费用）；
> 「为什么不是社区」「前台零互动」「后台看不到私池」等产品决策在 WINDOW.md。

## 四、网页版漂流瓶：只读橱窗

### 为什么只读

| 如果允许网页写 | 后果 |
|---|---|
| 没有设备令牌 | 只能靠 IP 限流，代理池可绕过 |
| 没有客户端成本 | 刷屏成本趋近于零，和「有成本才认真写」的产品原则冲突 |
| 审核面扩大 | 网页 UGC 要独立的风控、举报、留存策略 |
| 与「无账号」冲突 | 网页要区分「谁写的」才能限流 → 又回到账号 |

**所以网页是橱窗，不是第二个客户端。** 想写？下载一只猫——这恰好也是获客路径。

### 橱窗规则

- **与私池完全分开**（已定）：橱窗是**独立的精选展示表**，不与桌面端捡瓶共用内容池——
  同一张纸条不会被「公开展示 + 被捡走」反复消费；私池瓶子即使公开，也只在橱窗里有**快照副本**
- **逐条 opt-in**：写瓶时勾选「可以让别人在网页上看到」，默认不勾
- **事前审核**：`pending → approved / rejected`；未批准不展示
- **展示内容**：正文 + 随机代号 + 时段标签；**不显示**作者、设备、时间精确到分钟、任何数字
- **无互动**：没有点赞、评论、已读、被捡次数；只有「随机看看下一页」
- **保留期**：批准后 30 天自动下架（与私池 7 天区分开）
- **撤回**：作者可在桌面端撤回，**同时下架橱窗副本**；私池过期不影响橱窗（快照独立）

**为什么分开（而不是给 `bottles` 加个 `public` 字段）**：

| 共用池子 | 独立橱窗表 |
|---|---|
| 公开瓶可能再次被桌面端捡到，等于同一内容反复消费 | 橱窗只读，永不进入捡瓶通道 |
| 橱窗需要「精选、编辑、长期保留」，私池是「7 天沉海」 | 两套生命周期互不干扰 |
| 审核状态污染投递状态机 | `canPick / canReply` 完全不用改 |

### 页面结构

| 路径 | 内容 |
|---|---|
| `/` | 一句话 + 下载按钮 + 最近 3 条橱窗内容 |
| `/gallery` | 橱窗流：按时段筛选（深夜 / 清晨 / 白天 / 傍晚），游标分页；全程 `noindex` |
| `/news`、`/news/:id` | 官方新闻列表与详情 |
| `/privacy`、`/terms` | 法务页（与客户端 `docs/legal/` 同源生成，避免两套文案） |

**技术（2026-11-26 修订）**：
- 公开站点：**静态 HTML + 客户端拉接口**（`build-site.cjs` 现有方式即可），只有 `/news/:id` 由 Worker 渲染 HTML（SEO / OG）。**暂不引入 Astro**——真正需要模板化的只有两条新闻页，几十行字符串模板就够；等页面类型超过 8 种或需要 i18n 再评估。
- 管理后台：**Vite + React 19**（与桌面端渲染层同一套栈），产物作为静态资源由同一个 Worker 的 `assets` 提供。
- 路径统一为 `/gallery`（不再用 `/piaoliu`），见 `WINDOW.md` 4.1。

## 五、新闻：官方编辑管道

### 为什么不做 RSS 直连

- **版权**：全文转载有风险，只存标题 + 链接又撑不起「带回来的东西」
- **质量**：RSS 是火并，与「每天最多 1 条、和它记得的你有关」冲突
- **可控**：新闻会进笔记本，必须能撤、能改、能标注来源

### 管道

```
RSS / 人工选题 → 后台草稿（标题 + 摘要 + 来源链接 + 分类）
              → 编辑改写（猫的口吻，不抄全文）
              → 定时发布
              → 桌面端 GET /v1/news/pick（每设备每天 ≤1 条）
              → core/news.ts 生成一句观察 + 进笔记本
```

### 桌面端规则（延续 P1 的产品约束）

- 每天最多 1 条，**不弹通知**，进笔记本
- 与「它记得的你」相关优先：按分类与记忆标签匹配（下雨 / 加班 / 猫 / 城市）
- 可关：设置里「带回来的东西」默认开
- **不允许新闻触发任何外链跳转**（避免导流与钓鱼）；只展示标题、摘要、来源名

## 六、管理后台

### 功能清单

| 模块 | 能力 |
|---|---|
| 概览 | 设备数、日扔瓶 / 捡瓶 / 回信、举报率、橱窗待审数、新闻阅读 |
| 审核队列 | 橱窗待审、被举报内容；批准 / 驳回 / 隐藏 / 封禁设备（吊销令牌） |
| 新闻编排 | 新建 / 编辑 / 预览 / 定时发布 / 下架；封面传 R2 |
| 开关 | `EMERGENCY_OFF`、`GALLERY_OFF`、`NEWS_OFF`、限额调整（写 KV，秒级生效） |
| 审计 | 谁在什么时间做了什么（管理员账号 id，不另存邮箱） |
| 指标 | 聚合查询 + CSV 导出；**不存任何 PII** |

### 权限与安全（API Key + TOTP）

> 已定：**不买 Workers Paid**，所以不使用密码哈希（PBKDF2 10 万轮在免费档 10ms CPU 内跑不完）。
> 改为「一次 SHA-256 + HMAC-TOTP」的登录方式，全部使用 WebCrypto 标准原语。
> **不要自己发明加密算法**——可以自己写调用标准原语的胶水，不要自己写算法。

- **邀请制、无公开注册**：账号由管理员在后台创建，首个管理员通过一次性 CLI 引导创建
- **登录凭证 = API Key + 当前 TOTP 码**
  - API Key：32 字节随机（`crypto.getRandomValues`），**只展示一次**，库里只存 `SHA-256(key)`
  - TOTP：RFC 6238，HMAC-SHA1、30 秒步长、6 位；TOTP 密钥用 `AES-GCM` 加密后存储
    （主密钥来自 `wrangler secret`，不进仓库）
- **CPU**：SHA-256 / HMAC-SHA1 / AES-GCM 都是微秒级，**免费档 10ms 预算绰绰有余**——
  这是不需要 Paid 的关键
- **会话**：`HttpOnly + Secure + SameSite=Strict` Cookie，服务端存会话令牌的 `SHA-256`，有效期 7 天、轮换
- **登录限流**：每账号 5 次/15 分钟、每 IP 20 次/15 分钟，超限锁定与告警
- **权限三档**：`viewer`（只看）/ `operator`（审核、新闻）/ `admin`（开关、账号、封禁）
- **审计**：登录成功 / 失败、所有写操作、开关变更，只追加，保留 1 年
- **后台 SPA 不持有任何密钥**；所有写操作走 Admin API
- **紧急开关优先于一切**：即使后台挂了，KV 里的开关仍能通过 `wrangler kv key put` 手动改
- **人少就是安全**：第一年只开 1–3 个账号；不做找回（Key 丢了就走管理员重置），减少攻击面
- **以后若要密码登录**：把 `scrypt / argon2` 放到 Workers 之外的独立小服务，不在 Worker 里硬扛

## 七、API 设计

### 公开接口（HTTP POST + JSON，`X-Device-Token` 可选）

| 接口 | 作用 | 限流 |
|---|---|---|
| `POST /v1/bottle` | 扔瓶（`requestPublic: boolean` → 橱窗待审） | 单设备 3/天 |
| `POST /v1/bottle/pick` | 捡瓶 | 单设备 10/小时 |
| `POST /v1/bottle/reply` | 回一句 | 单设备 10/天 |
| `POST /v1/bottle/inbox` | 收回信 | 单设备 20/小时 |
| `POST /v1/report` | 举报 | 单设备 20/天 |
| `GET /v1/gallery?pool=&cursor=` | 橱窗（公开、只读） | 单 IP 60/小时 |
| `GET /v1/news?cursor=` | 新闻列表 | 单 IP 120/小时 |
| `GET /v1/news/pick` | 桌面端取 1 条（设备令牌去重） | 单设备 5/天 |
| `GET /v1/meta` | 协议版本、公告、开关状态 | 无 |
| `GET /v1/download/latest?os=win\|mac` | **站点下载页**：302 到 R2 最新安装包 | 无 |
| `GET /v1/download/manifest` | 版本号 + 文件名 + SHA-256（更新检查用） | 无 |

> 下载走站点而不是 GitHub Release（私有仓库后 Release 不公开，见第九节）。

### 管理接口（`/admin/*`，自建会话 Cookie）

```
POST   /admin/login                  { apiKey, totp }
POST   /admin/logout
GET    /admin/overview
GET    /admin/moderation?status=pending
POST   /admin/moderation/:id        { action: approve|reject|hide }
POST   /admin/news                  { title, summary, body, source, category, publishAt }
PATCH  /admin/news/:id
POST   /admin/news/:id/publish
POST   /admin/flags                 { key, value }
POST   /admin/devices/:hash/revoke
GET    /admin/audit?cursor=
```

### 错误码

沿用 `core/mailbox.ts` 的 `BottleErrorCode`，新增 `GALLERY_OFF`、`NEWS_OFF`、`NOT_APPROVED`。
错误码与文案放进 `packages/contracts`，**三端共用**。

## 八、数据模型增量

在 [`SERVER.md`](SERVER.md) 现有表上增加（完整 DDL 放 server 仓库 `migrations/`）：

```sql
-- 橱窗（与私池完全分开：独立表、独立生命周期、独立审核状态）
CREATE TABLE gallery_bottles (
  id            TEXT PRIMARY KEY,
  source_bottle TEXT,                  -- 来源私池瓶（可为空：官方种子内容）
  pool          TEXT NOT NULL,         -- 与私池同一套时段标签
  body          TEXT NOT NULL,         -- 批准时的**快照**，不随私池变化
  alias         TEXT NOT NULL,
  status        TEXT NOT NULL,         -- pending|approved|rejected|withdrawn
  reviewed_by   TEXT,                  -- admin_users.id
  reviewed_at   INTEGER,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER                -- approved + 30 天
);

-- 新闻
CREATE TABLE news (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  body        TEXT NOT NULL,
  source_name TEXT,
  source_url  TEXT,
  category    TEXT NOT NULL,          -- rain|night|city|cat|other
  cover_key   TEXT,                   -- R2 对象键
  status      TEXT NOT NULL,          -- draft|scheduled|published|archived
  publish_at  INTEGER,
  created_at  INTEGER NOT NULL
);

-- 每个设备看过哪条（每天 ≤1 条）
CREATE TABLE news_seen (
  device_hash TEXT NOT NULL,
  news_id     TEXT NOT NULL,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (device_hash, news_id)
);

-- 审计
CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,           -- 管理员账号 id（不是邮箱）
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);

-- 管理员账号（仅后台，不存任何终端用户信息）
CREATE TABLE admin_users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  key_hash      TEXT NOT NULL,        -- SHA-256(API Key)，原文只展示一次
  totp_secret   TEXT NOT NULL,        -- AES-GCM(主密钥来自 wrangler secret)
  role          TEXT NOT NULL,        -- viewer|operator|admin
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id   TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE admin_login_attempts (
  key        TEXT NOT NULL,           -- u:<user> 或 ip:<hash>
  window     INTEGER NOT NULL,
  attempts   INTEGER NOT NULL,
  PRIMARY KEY (key, window)
);
```

**保留策略**：私池过期 7 天删；橱窗下架 30 天删；举报 90 天删；审计 1 年；新闻永久（可归档）。
**不存**：IP 原文（只存 /24 或哈希用于限流）、时区、位置、任何账号信息。

## 九、仓库设计：单仓库 monorepo（私有）

### 结构

```
companion-ball/               私有 GitHub 仓库
├── src/ …                    桌面端（**原位保留**，electron-vite / electron-builder 路径不动）
├── server/ → packages/server 迁入
├── docs/ · tests/ · scripts/  现有内容不动
└── packages/
    ├── contracts/            DTO / zod schema / 常量 / 错误码（唯一契约源）
    ├── server/               Workers + D1 migrations + admin API + cron
    ├── web/                  静态页 + 客户端拉接口：橱窗 / 下载 / 法务（news 由 Worker 渲染）
    └── admin/                Vite + React 19：审核 / 新闻 / 指标 / 开关
```

- 用 npm workspaces（Node 22 已内置，不引入新工具）
- `packages/contracts` 通过 workspace 协议被其他包引用，**不发布到任何 registry**
- 桌面端留在根目录是关键决策：`release.js`、`electron-builder*.yml`、`electron-vite` 的路径全部不用改，
  平台化对桌面构建链**零侵入**

### 为什么是 monorepo（且要改一条宪法）

- 之前 `CLAUDE.md` 写「不建 monorepo」，本意是**不与 fortune-ball 共享代码包**。单仓库的平台包
  不违反这个初衷；建议把约束改为「**不建跨产品 monorepo**」
- 契约一处改动 → 一次 PR 三端同步；不用维护私有 registry
- 发布节奏差异用 **CI 路径过滤** 解决（改 `web/` 只构建产物，不打包桌面）

### 私有仓库的四个后果（已接受）

| 后果 | 处理 |
|---|---|
| GitHub Releases 对私有仓库不公开 | 安装包改发 **R2**，官网下载页签名 + 版本号；Release 只做内部记录 |
| 私有仓库 Pages 需 Pro | 不用 Pages：站点与后台由同一个 Worker 的 `assets` 提供（见第三节同源部署） |
| Actions 分钟 2000/月 | `paths:` 过滤 + 缓存；文档改动不触发构建 |
| 不能选择性开源 | 接受；隐私信任靠协议 + 审计，不靠源码公开 |

### 迁移顺序

1. **根目录改 workspaces**：加 `packages/*`，确认桌面构建链不受影响
2. **抽 contracts**：`src/core/mailbox.ts` 与 `server/src/rules.ts` 合并 → `packages/contracts`；
   桌面端与 server 同时改为引用，删掉 `rules-parity.test.ts` 的「抄写比对」，保留回归测试
3. **迁 server**：`server/` → `packages/server`（保留 git 历史用 `git mv`，不做 subtree split）
4. **部署 S3**：在新结构部署，拿「真实互投」验收（0.9.1）
5. **建 web / admin**：S5 阶段
6. **CI**：GitHub Actions 按路径过滤；Cloudflare 用 `wrangler action` 部署

> 收益：契约不再靠测试死撑；一次改动三端同步。
> 代价：S3 验收顺延约 1–2 周；私有仓库后发布渠道需改用 R2 + 自有域名（boringtime.cn）。

## 十、资源评估

### 人力（1 名全栈，熟悉现有代码）

| 工作 | 人日 | 说明 |
|---|---|---|
| contracts 抽取 + 三端接入 | 3–5 | 一次性收敛，越早越省 |
| server v2（橱窗 / 新闻 / admin API / cron / 迁移） | 8–10 | 含测试 |
| **登录（API Key + TOTP + 会话 + 限流 + 审计）** | **3–4** | 全部走 WebCrypto 原语；比密码哈希少一半工作 |
| 猫邮局 web（静态页 + Worker 渲染 news） | 6–8 | 含视觉，不含品牌设计 |
| 管理后台 SPA | 6–8 | 审核 / 新闻 / 指标 / 开关 / 账号 |
| 桌面端接入（新闻 + 公开勾选 + 设置） | 3–5 | core 纯函数 + IPC 五处同步 |
| **monorepo 改造 + CI / 发布渠道切换** | **2–3** | workspaces + Actions 路径过滤 + R2 下载页 |
| 审核与运营流程、法务更新 | 3–5 | 一次性 |
| **合计** | **约 31–43 人日** | 单人全职 6–8 周；兼职 2–3 个月 |

**分档：**

| 档 | 范围 | 人日 | 能验证什么 |
|---|---|---|---|
| **M0** | monorepo 改造 + 契约收敛 + server 部署 + 冷启动 | 4–6 | 真实用户互投（S3 验收） |
| **M1** | contracts + 橱窗 + 新闻 + admin 最小版 | 20–25 | 网页侧需求、审核管道（S5） |
| **M2** | 公开 opt-in + 双向 + 指标完善 | 10–12 | 公开化与举报率（S6） |

### 费用（海外版，按月）

| 项 | 免费额度 | 初期成本 |
|---|---|---|
| Workers | 10 万请求/天 | $0（超出 $5/月起） |
| D1 | 5GB / 500 万行读/天 | $0 |
| KV | 10 万读/天 | $0 |
| R2 | 10GB 存储，出流量免费 | $0 |
| Workers 静态资源（assets） | 免费额度内不计请求 | $0 |
| 域名 | — | ≈ $10–15/年 |
| **合计** | — | **≈ $10–15/年** |

> 以上以 Cloudflare 官网为准；DAU 千人内基本免额。真正的成本是**运营时间**，不是服务器。
> 选择 API Key + TOTP 后**不需要 Workers Paid**；若将来改密码登录，才需要 $5/月的 CPU 预算。

### 运营（持续）

| 项 | 频率 | 时间 |
|---|---|---|
| 橱窗审核 | 每日 | 10–15 分钟 |
| 举报响应 | 24h 内 | 按量 |
| 新闻编排 | 每周 3–5 条（可先 1 条） | 2–4 小时 |
| 数据复盘 | 每周 | 30 分钟 |
| 冷启动社群 | 前 4 周 | 每天 30 分钟 |

### 国内版（另算）

备案 + 国内云主机 + 内容审核义务，**最低 ¥100–300/月 + 1–2 周备案**；
且 `CONTENT_POLICY=filtered`，需要独立部署与独立审核流程。**不建议在第一年做**。

## 十一、安全、隐私与合规

| 面 | 措施 |
|---|---|
| 网页无账号 | 无 Cookie、无登录、无指纹；只读 |
| 橱窗隐私 | 逐条 opt-in、事后可撤回、30 天自动下架 |
| 私池隐私 | 沿用 SERVER.md：只存令牌哈希、不存时区原文 |
| 新闻版权 | 只发布改写摘要 + 来源名，不全文转载 |
| 管理后台 | API Key + TOTP + 会话 Cookie + 登录限流 + 审计 + 最小权限 |
| 限流 | 设备令牌 + IP 双维度；KV 计数；超限 429 |
| 紧急开关 | 三个独立开关，KV 秒级生效，后台挂掉也能手动改 |
| 数据出境 | 海外 Workers/D1 明确写入隐私政策 |
| 协议变更 | 橱窗与新闻上线时 `AGREEMENT_VERSION` +1，隐私政策增补两节 |

## 十二、落地顺序（与 ROADMAP 对齐）

| 阶段 | 平台工作 | 对应产品阶段 |
|---|---|---|
| **S3 收尾** | **monorepo 改造**：workspaces → contracts 收敛 → server 迁入 → **再部署** | 许愿瓶开门（0.9.1） |
| **P0.5 / P1** | 无平台改动；桌面端只做本地 | 不说话的身体 / 缺席日志 |
| **P1.5 / P2** | 无平台改动；桌面端只做本地 | 事件记忆 / 页边一句 |
| **S5** | M1：橱窗 + 新闻 + admin（在 monorepo 内新建包） | 猫邮局只读（0.13.0） |
| **S6** | M2：公开 opt-in + 双向 + 指标 | 猫邮局开门（1.0.0） |
| **S7** | 年度本只读导出，不依赖服务端 | 年度笔记本 |
| 以后 | 国内版 / 手机端 | 期权 |

**关键顺序**：私人闭环（P1–P2）先于平台化（S5–S6）。平台是为内容服务的，不是反过来。

## 十三、已定与待定

**已定（2026-11-25）：**

1. **网页只读橱窗**：写留在桌面端，网页只展示逐条勾选公开的内容。
2. **新闻官方编辑人工发布**：RSS 仅作选题来源，不直接展示。
3. **单仓库 monorepo（私有）**：根包 = 桌面端，`packages/{contracts,server,web,admin}`。
4. **后台登录用 API Key + TOTP**：不存明文密码、不用 Workers Paid、不发明加密算法。
5. **网页技术栈：静态 HTML + 客户端拉接口；只有 news 由 Worker 渲染**；管理后台用 Vite + React 19。**不使用 Cloudflare Pages，站点与后台同源单 Worker。**
6. **橱窗与私池完全分开**：独立 `gallery_bottles` 表与生命周期；橱窗是快照，不进捡瓶通道。
7. **下载属于站点**：安装包发 R2，由站点下载页（`/v1/download/*`）分发；GitHub Release 仅作内部记录。
8. **域名自行申请**：S0 不阻塞，下载链接先占位。
9. **接受「不能选择性开源」**：私有仓库定下后，若将来要开源客户端需拆库。
10. **部署目标 = Cloudflare 免费档，不买服务器**：S3 不设外部阻塞；代码通过最小 `Db` 接口保留
    迁移到自有 VPS 的可能（将来 1 天工作量，不做也可以）。

**S0 执行清单见 [`PLATFORM-S0.md`](PLATFORM-S0.md)**（workspaces → contracts 收敛 → server 迁入 → 守卫适配 → 发布渠道 → CI → 部署）。
