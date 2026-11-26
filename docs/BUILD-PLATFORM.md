# 平台构建方案：怎么把它造出来

> 产品设计见 [`WINDOW.md`](WINDOW.md)；部署拓扑与费用见 [`PLATFORM.md`](PLATFORM.md) 第三节；
> 客户端架构见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 第十五节。
>
> 这份文档只回答一件事：**从今天的 905 行服务端，到能上线的窗口 + 灯塔，代码怎么长。**
> 它不是产品决策，是施工图。

---

## 一、起点（2026-11-26 实测）

| 项 | 现状 |
|---|---|
| `packages/server` | 905 行：`handler.ts` 458（单文件，只有瓶子）、`db.ts` 149、`node.ts` 211、`worker.ts` 71、`crypto.ts` 16 |
| `packages/web` | 单页静态 HTML + 2 个 Pages Functions（下载相关） |
| `packages/admin` | 不存在 |
| 服务端测试 | **0** |
| CI | **不存在** |
| 数据库演进 | `schema.sql` + `CREATE TABLE IF NOT EXISTS` —— 对已建库无法演进 |
| 桌面端默认地址 | `DEFAULT_ENDPOINT = ''` |

**判断**：业务代码质量不错（handler 平台无关、db 有接口抽象、限流三道闸），
但**工程地基缺三块**——迁移、测试、构建管线。功能可以后加，地基必须先补。

---

## 二、同源骨架（决定所有认证复杂度）

**一个 Worker，一个域名 `boringtime.cn`，静态资源走 `assets` 绑定。**

```
boringtime.cn/
├── /                 静态 HTML（首页）
├── /gallery          静态 HTML + 客户端 fetch（noindex）
├── /download         静态 HTML
├── /privacy /terms   静态 HTML
├── /news/:id         Worker 渲染 HTML（SEO + OG）← 唯一服务端渲染
├── /admin            静态 SPA（Vite 产物）
├── /v1/*             JSON API（桌面端 + 公开只读）
└── /admin/api/*      JSON API（后台，会话 Cookie）
```

**收益不是"少一个服务"，是认证变简单：**

| | 不同源 | 同源（本方案） |
|---|---|---|
| Cookie | `SameSite=None; Secure` | `SameSite=Strict` 直接可用 |
| CORS | 白名单 + 预检 + credentials | **零配置** |
| CSRF | 需要 token | 同源 + Strict + `Origin` 校验 |
| 部署 | 3 个单元、3 套 env | **1 次 `wrangler deploy`** |

**代价**：没有 Pages 的 PR 预览。私有仓库 + 单人开发，接受。

**实现要点**（Wrangler `assets` 绑定）：

```toml
# packages/server/wrangler.toml
[assets]
directory = "./public"          # 构建期把 web/dist 与 admin/dist 拷进来
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/v1/*", "/admin/api/*", "/news/*"]
```

> `run_worker_first` 是关键的：它保证 API 与 news 先走 Worker，其余交给静态资源。
> **上线前必须实测**：`/admin` 能打开 SPA，`/v1/health` 能返回 JSON，
> `/gallery` 返回静态 HTML 而不是被 Worker 拦走。

---

## 三、DB 迁移（现在的 schema 不能演进）

`schema.sql` 对已建库是空操作。必须换成有序迁移，且 **D1 与 Node 两个运行时用同一套文件**。

```
packages/server/migrations/
  0001_init.sql          ← 现 schema.sql 原样搬入
  0002_gallery.sql
  0003_news.sql
  0004_admin.sql
  0005_stats.sql
```

| 运行时会 | 执行方式 |
|---|---|
| D1 | `wrangler d1 migrations apply companion-bottles --remote`（Wrangler 自带跟踪表） |
| Node | `migrate.ts` 启动时按序执行未应用的，自己维护 `schema_migrations` 表 |

**Node 侧实现**（约 40 行，无依赖）：

```ts
export async function migrate(db: Db, files: string[]): Promise<number> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`).bind().run()
  const applied = new Set((await db.prepare('SELECT version FROM schema_migrations').bind().all()).results.map(r => r.version))
  let n = 0
  for (const f of files) {
    if (applied.has(f)) continue
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
    for (const stmt of splitStatements(sql)) {          // 按 ; 切分，跳过注释与字符串
      await db.prepare(stmt).bind().run()
    }
    await db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').bind(f, Date.now()).run()
    n++
  }
  return n
}
```

**规则**：
- 迁移**只前进，不改已发布的文件**（改了就是两台机器 schema 不一致）
- 每个迁移文件必须能在空库上从头跑通（测试会验证）
- `build.mjs` 把 `migrations/` 拷进产物，`schema.sql` 删除（唯一真相）

---

## 四、服务端模块拆分

`handler.ts` 加三个域会到 1500+ 行。按职责拆，**但不引入框架**：

```
packages/server/src/
├── handler.ts            仅路由分派（< 120 行）
├── worker.ts / node.ts   薄适配层（各 < 80 行）
├── db.ts                 Db 接口 + 两个适配器（不动）
├── migrate.ts            新增
├── http/
│   ├── respond.ts        json / err / html / redirect
│   ├── request.ts        body 读取（限制大小）、IP、Origin 校验
│   └── cookie.ts         __Host- 前缀、SameSite=Strict
├── auth/
│   ├── totp.ts           RFC 6238（WebCrypto HMAC-SHA1）
│   ├── session.ts        创建 / 校验 / 轮换
│   └── loginLimit.ts     **D1 原子自增**，不用 KV
├── repo/                 ← 所有 SQL 只在这里
│   ├── bottles.ts
│   ├── gallery.ts
│   ├── news.ts
│   ├── admins.ts
│   └── stats.ts
└── routes/
    ├── public/  bottle.ts gallery.ts news.ts meta.ts
    └── admin/   login.ts moderation.ts gallery.ts news.ts flags.ts audit.ts admins.ts
```

**为什么 `repo/` 是硬隔离**：`WINDOW.md` 6.5 要求「管理员读不到私池」。
把所有 SQL 收进 `repo/` 之后，这条约束才能用机器验证：

```js
// scripts/check-admin-privacy.js
// 规则：routes/admin/** 的调用图里不能到达 repo/bottles.ts 的列表/搜索函数
// 白名单：repo/bottles.ts 的 findById()（被举报的单条，按 id 精确查询）
```

照搬 `check-margin-privacy.js` 已验证过的方法（造违规调用能被拦下）。

---

## 五、登录与认证（对 PLATFORM 的一处修正）

`PLATFORM.md` 的 API Key + TOTP 方案保留，但**登录限流必须换实现**：

| 项 | 做法 |
|---|---|
| API Key | 32 字节随机；库只存 `SHA-256`；创建时展示一次 |
| TOTP | RFC 6238，HMAC-SHA1 / 30s / 6 位；密钥 `AES-GCM` 加密，主密钥走 `wrangler secret` |
| 会话 | 32 字节随机；库存哈希；`__Host-sid` + `HttpOnly; Secure; SameSite=Strict`；7 天 |
| 写请求 | 额外校验 `Origin` 与 `Host` 一致（一行，覆盖反代配置错误） |
| **登录限流** | **D1 原子自增**（见下） |

**为什么不能用现有 `kvRateCounter`**：

```ts
// worker.ts 现有实现：读-改-写，并发时可被绕过
const raw = await kv.get(key)
const next = (raw ? Number(raw) : 0) + 1
await kv.put(key, String(next), ...)
```

用于 IP 粗粒度限流可以接受（漏几个不致命）；**登录尝试计数不行**——攻击者并发请求即可突破。
改为 D1：

```sql
INSERT INTO admin_login_attempts (key, window, attempts) VALUES (?, ?, 1)
ON CONFLICT(key, window) DO UPDATE SET attempts = attempts + 1
RETURNING attempts;
```

`RETURNING` 在 D1 与 `node:sqlite` 都支持，一条语句原子完成，不需要事务。

---

## 六、测试（当前最大的空白）

`handler.ts` 的签名天生可测：

```ts
export async function handleRequest(req: Request, cfg: ServerConfig): Promise<Response>
```

**集成测试骨架**（内存 SQLite，不起 HTTP）：

```ts
function makeDb(): Db { /* sqliteAdapter(':memory:') + migrate() */ }
function post(path: string, body: unknown, token = 't'.repeat(32)) {
  return new Request(`https://x${path}`, {
    method: 'POST',
    headers: { 'X-Device-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

it('同一设备一天只能扔 3 次', async () => {
  const cfg = makeCfg(makeDb())
  for (let i = 0; i < 3; i++) expect((await handleRequest(post('/v1/bottle', {...}), cfg)).status).toBe(200)
  expect((await handleRequest(post('/v1/bottle', {...}), cfg)).status).toBe(429)
})
```

**必须覆盖的用例清单**：

| 类别 | 用例 |
|---|---|
| 限额 | 设备日额度、IP 每分钟、速率窗口 |
| 状态机 | 沉海后不可捡、最多捡 3 次、最多 1 封回信、不能回复自己的瓶子 |
| 安全 | 举报即隐藏、吊销令牌 401、`EMERGENCY_OFF` 全停 |
| 隐私 | **管理员接口读不到私池**（核心红线） |
| 迁移 | 空库从头跑到最新、重复执行幂等 |
| 后台 | 登录成功/失败、限流锁定、会话过期、权限三档 |

`packages/server` 需要加 `vitest` + `test` 脚本；根 `npm test` 已按 workspace 跑。

---

## 七、CI（路径过滤）

```
.github/workflows/ci.yml
```

| 变更路径 | 执行 |
|---|---|
| `packages/contracts/**` | **全部**（契约是三端真相） |
| `packages/server/**` | typecheck + 单测 + `check-admin-privacy` |
| `packages/desktop/**` | typecheck + 单测 + 构建（e2e 留在本地，需要 GUI） |
| `packages/web/**` / `packages/admin/**` | 构建 |
| `docs/**` | `check-docs` + `check-secrets` |

部署走手动（`workflow_dispatch`）或 tag 触发——**不给 UGC 平台做自动部署**，
上线前要能看一眼。

---

## 八、施工顺序

产品文档的 M0–M3 缺一步地基，补 **P0**：

| 阶段 | 内容 | 人日 | 完成标志 |
|---|---|---|---|
| **P0 地基** | 迁移机制 + handler 拆模块 + SQL 收进 repo/ + 测试骨架 + 同源骨架跑通 | 3–4 | 登录 Cookie 能下发；`npm test` 有服务端集成测试；`/v1/health` 与 `/admin` 同域可访问 |
| **P1 公开读** | gallery / news 读接口 + 静态页 + 缓存头 | 4–5 | 网页能看到手工插入的内容；缓存命中 |
| **P2 认证 + 审核** | 登录 / TOTP / 会话 / D1 限流 / 待审队列 / 封海 | 4–5 | 能真正审核一条瓶子；`check-admin-privacy` 生效 |
| **P3 新闻编排** | 编辑器 + 线索接口 + 定时发布 + 桌面端 `news/pick` | 4–5 | 一条新闻从起草到进笔记本全链路 |
| **P4 灯塔完整** | 概览 / 审计 / 账号 / 聚合统计 / 举报处置 | 4–5 | 运营 ≤15 分钟/天 |

**P0 最容易被跳过，跳过后最贵**——它决定了后面每一步是「加文件」还是「改地基」。

---

## 九、上线检查清单（P0 完成时逐条打勾）

- [ ] `boringtime.cn` DNS 解析到 Cloudflare
- [ ] Worker 自定义域绑定成功（不带 `workers.dev`）
- [ ] `/` 返回静态首页；`/admin` 返回 SPA；`/v1/health` 返回 JSON
- [ ] 生产 D1 已 apply 所有迁移；`schema_migrations` 行数 = 迁移文件数
- [ ] `wrangler secret` 已设：`TOTP_MASTER_KEY`、`NEWS_INGEST_TOKEN`（若启用）、`ADMIN_BOOTSTRAP`
- [ ] 首个管理员通过 CLI 引导创建；API Key 已离线保存
- [ ] 登录 → Cookie 下发 → 刷新页面仍登录 → 登出清 Cookie
- [ ] 错误尝试 6 次后被锁定（验证 D1 原子计数真的生效）
- [ ] `EMERGENCY_OFF=1` 后所有写接口 503；改回 0 立即恢复
- [ ] 备份：`wrangler d1 export` 跑通一次，文件大小合理
