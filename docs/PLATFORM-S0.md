# 平台 S0 执行清单：monorepo 改造

> 依据 [`PLATFORM.md`](PLATFORM.md) 第九、十二节。这是**可执行清单**，不是又一次设计。
> 目标：把「两份手抄契约 + 独立 `server/`」改成「单仓库 workspaces，契约唯一源，桌面端构建链零改动」。
> 完成后 S3 可在新结构部署；发布渠道切到站点下载页 + R2。

## 〇、总览

| 步骤 | 内容 | 风险 | 工作量 |
|---|---|---|---|
| 1 | 根目录加 workspaces | 低 | 0.5 天 |
| 2 | 新建 `packages/contracts`，收敛 `mailbox.ts` + `rules.ts` | 中 | 1–2 天 |
| 3 | `server/` → `packages/server`，改 import | 中 | 1 天 |
| 4 | 守卫脚本 / tsconfig / vitest / electron-vite 路径适配 | **高**（改错会静默放行） | 0.5 天 |
| 5 | 发布渠道：`product-intro.html` 下载链接 → 站点下载页 + R2 | 低 | 0.5 天 |
| 6 | CI：GitHub Actions 按路径过滤 | 低 | 0.5–1 天 |
| 7 | 部署 S3（在新结构） | — | 1 天 |
| **合计** | | | **约 5–6 天** |

**不做**：不拆库、不改 appId、不改 electron-vite 的产物目录、不动 `src/main` 与 `src/renderer` 的代码。

## 一、根目录 workspaces

### 改 `package.json`（根）

```jsonc
{
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "vitest run && node scripts/check-core-boundary.js",
    "test:packages": "npm test -ws --if-present",
    "build:web": "npm run build -w @companion/web",
    "deploy:server": "npm run deploy -w @companion/server"
  }
}
```

**⚠️ 注意**：根 `package.json` 现在**没有** `private` 字段，而 npm workspaces 要求根包为 `private: true`。
加到第一处即可，不影响 electron-builder（它读的是 `name` / `version` / `build` 字段）。

### 新建 `packages/` 下的三个占位包

先只建 `contracts` 与 `server`；`web` / `admin` 到 S5 再建。

```
packages/
├── contracts/package.json   { "name": "@companion/contracts", "version": "0.1.0", "type": "module", "main": "./src/index.ts", "types": "./src/index.ts" }
└── server/package.json      { "name": "@companion/server", ... 沿用现有 server/package.json 的 scripts 与依赖 }
```

## 二、契约收敛（核心）

### 来源 → 目标

| 来源 | 目标 | 说明 |
|---|---|---|
| `src/core/mailbox.ts` 常量 + 纯函数 + 类型 | `packages/contracts/src/*.ts` | **权威版本**，以它为准 |
| `server/src/rules.ts` | **删除** | 改为 `import … from '@companion/contracts'` |
| `tests/rules-parity.test.ts` | 改为「契约回归测试」 | 不再比对两份文件，而是测契约行为本身 |

### `packages/contracts/src/` 文件清单

```
models.ts       BottleDTO / ReplyDTO / BottleErrorCode / Pool / BottleStatus / BottleState / BottleSettings
constants.ts    BOTTLE_MAX_LENGTH / REPLY_MAX_LENGTH / TTL / MAX_PICKS / DAILY_* / CONTENT_POLICY
validate.ts     checkText / CONTACT_PATTERNS / TextCheck
pools.ts        poolFor / isLateNight
lifecycle.ts    expiresAt / isExpired / statusOf / canPick / canReply / shouldGoOut / withinDailyLimit
alias.ts        randomAlias / ALIAS_ADJECTIVES / ALIAS_NOUNS
errors.ts       bottleErrorText / textErrorText
index.ts        只 re-export 上面所有
```

### 边界约束（必须保持）

- 只允许**纯 TS + 无 import**：不得 import `node:`、`electron`、`zod`（zod 只放在 `schemas.ts` 里，见下）
- `crypto` 系列**不要放进 contracts**（`hashToken` / `randomId` 留在 `server`，`randomAlias` 保持纯函数）
- `schemas.ts`（zod 请求体校验）：**可选**。若放进来，contracts 就有了运行时依赖，需要同时改
  `check-core-boundary` 的白名单。建议**S0 先不放**，S5 做 admin API 时再加。

### 改完后桌面端

```ts
// src/core/mailbox.ts → 只保留再导出，避免改动全仓 import 路径
export * from '../../packages/contracts/src/index.ts'
```

> 或者更干净：全仓改成 `@contracts` 别名，直接 import 包。**推荐后者**，但要把 `mailbox.ts` 作为
> 兼容层保留一个版本，避免一次改太多。

## 三、`server/` → `packages/server`

```bash
git mv server packages/server
```

需要改的引用：

| 文件 | 改动 |
|---|---|
| `packages/server/src/index.ts` | `import { … } from './rules'` → `from '@companion/contracts'`；删除 `server/src/rules.ts` |
| `packages/server/package.json` | `"dependencies": { "@companion/contracts": "*" }`；scripts 不变 |
| `packages/server/tsconfig.json` | 加 `"paths": { "@companion/contracts": ["../contracts/src/index.ts"] }` 或由 workspace 解析 |
| `packages/server/wrangler.toml` | 路径不变（`main = "src/index.ts"` 仍在包内） |
| `docs/SERVER.md` / `docs/TESTING-BOTTLE.md` | 更新路径引用 |

**注意 `mock-bottle-server.mjs`**（`scripts/mock-bottle-server.mjs`）：它**不 import 任何代码**，是纯 HTTP mock，
路径不用改；但它注释里写「行为与 `server/src/index.ts` 保持一致」——改成 `packages/server/src/index.ts`。

### 3.5 顺手做：抽出最小 `Db` 接口（为将来迁 VPS 保险）

> 部署目标已定：**Cloudflare 免费档，不买服务器**。这一步不是为迁移而迁，而是让业务代码不耦合
> `D1Database`——改动很小，收益是「以后想搬只换适配器」。

```
packages/server/src/
├── db.ts          interface Db { prepare(sql): Stmt; batch(stmts): Promise<...> }
│                  + d1Adapter(env.DB) —— 把 D1Database 适配成 Db
├── index.ts       只依赖 Db，不出现 D1Database 类型
```

- 现在只实现 D1 适配器；将来 Node 版只需新增 `sqliteAdapter`
- 同时把「沉海 / 清理」写成独立函数，Cron 只是调用方
- **验收**：`grep -r "D1Database" packages/server/src` 只命中 `db.ts`

## 四、守卫与构建配置适配（最容易出错）

### ① `scripts/check-core-boundary.js`

现在允许的相对路径只有 `src/core` 与 `src/data`：

- 若 `src/core/mailbox.ts` 改为 `export * from '../../packages/contracts/src/index.ts'`，
  会命中「import 跳出 core」而失败
- **处理**：把 `packages/contracts/src` 加进允许目录（类似 `DATA_DIR` 的处理）

```js
const CONTRACTS_DIR = path.join(ROOT, 'packages', 'contracts', 'src');
// reportModule 里：resolved.startsWith(CONTRACTS_DIR + path.sep) 也视为合法
```

### ② `tsconfig.node.json` / `tsconfig.web.json` / `tsconfig` 别名

现有 `"@core/*": ["src/core/*"]`。新增：

```jsonc
"paths": {
  "@core/*": ["src/core/*"],
  "@contracts": ["packages/contracts/src/index.ts"],
  "@contracts/*": ["packages/contracts/src/*"]
}
```

### ③ `electron.vite.config.ts` / `vitest.config.ts`

两个文件的 `alias` 对象需要加 `@contracts`：

```ts
'@contracts': resolve(root, 'packages/contracts/src/index.ts'),
```

### ④ **不要把 `packages/` 打进安装包**

`electron-builder*.yml` 的 `files` 已通过 `out/**/*` 白名单控制，源码本身不进包——**不用改**。
但确认 `files` 里没有新增 `packages/**` 的 include。

## 五、发布渠道切换（私有仓库后）

### 现状问题

| 位置 | 现状 | 私有仓库后 |
|---|---|---|
| `product-intro.html:158` | 下载按钮 → `github.com/CQL111/companion-ball/releases` | **404** |
| `scripts/build-site.js` | 产物 → `docs/index.html` → GitHub Pages | 私有仓库 Pages 需 Pro |
| `scripts/publish-github.js` | 上传到 GitHub Release | 私有仓库 Release 不公开 |

### 切换（S0-5，代码已就绪，待填凭证）

> 2026-11-25 已实现，全部走环境变量（见 `.env.example`），不需要改代码。

1. **安装包上传 R2**：`scripts/publish-r2.js`（零依赖 SigV4，见 `scripts/r2.js`）
   - 对象键：`releases/v{version}/{artifactName}`
   - 同时上传 `latest.json`（版本号、文件名、SHA-256、大小、发布日期）
   - `release.js` 按 `PUBLISH_TARGET=r2|github` 选择目标，**默认 r2**
2. **站点下载页**：`packages/web/product-intro.html` 从 `/v1/download/manifest` 读版本，
   按钮指向 `/v1/download/latest?os=win`（302 到 R2）；失败时按钮自动置灰
3. **GitHub Release 仅作内部记录**：tag 与 notes 保留，不再上传安装包资产

需要的环境变量（仓库根 `.env`，已被 gitignore）：

| 变量 | 说明 |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare 账号 ID |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 API Token（Object Read & Write） |
| `R2_BUCKET` | 桶名 |
| `R2_PUBLIC_BASE_URL` | R2 公开域名（自定义域 / r2.dev） |
| `PUBLISH_TARGET` | `r2`（默认）或 `github` |

验证方式（不需要真实凭证）：

```bash
node scripts/publish-r2.js 0.9.1 <dist目录> --dry-run   # 打印计划与 latest.json
```

## 六、CI（GitHub Actions）

新建 `.github/workflows/`：

| 文件 | 触发 | 做什么 |
|---|---|---|
| `ci.yml` | push / PR（`paths` 过滤） | `npm ci` → `npm test` → `npm run typecheck` → 构建 contracts |
| `desktop-release.yml` | tag `v*` | release 门禁 → 构建公开版 → 上传 R2 |
| `deploy-server.yml` | `packages/server/**` 变更合并到 main | `wrangler deploy`（staging） |
| `deploy-web.yml` | `packages/web/**` 变更 | `npm run build -w @companion/web` → Pages |

**路径过滤示例**：

```yaml
on:
  push:
    branches: [master]
    paths: ['packages/server/**', 'packages/contracts/**', 'package-lock.json']
```

> Actions 分钟紧张：桌面打包只在 tag 触发，日常 CI 不打包。

## 七、验收（S0 完成定义）

- [ ] `npm test` 通过；`check-core-boundary` 通过（含 contracts 白名单）
- [ ] `npm run typecheck` 通过（两个 tsconfig 都含 `@contracts`）
- [ ] `npm run build` + `npm run test:e2e` 通过（桌面端行为不变）
- [ ] `packages/server` 下 `npm run typecheck` 通过，且 `index.ts` 不再 import `./rules`
- [ ] `tests/rules-parity.test.ts` 已改为契约行为测试（或删除）
- [ ] `packages/contracts` 内 `grep -r "node:\|electron\|from 'zod'"` 为 0（无平台依赖）
- [ ] `packages/server/src` 内 `grep -r "D1Database"` 只命中 `db.ts`（业务不耦合 Cloudflare 类型）
- [ ] `product-intro.html` 下载链接已改为可配置（占位域名可后续填）
- [ ] 文档同步：`CLAUDE.md` / `AGENTS.md` 宪法第 3 条、`docs/SERVER.md` 路径、
      `docs/ARCHITECTURE.md` 目录图

## 八、回退方案

- 整个改造在**一个分支**上完成，S3 部署在合并后才做
- 每步都是独立 commit：`chore(repo): workspaces` → `refactor(contracts): ...` → `chore(repo): move server`
- 任一步失败可 `git revert` 该 commit，不影响桌面端运行
- **现有 `server/` 在 `git mv` 前保持可运行**，`npm run mock:bottle` 不受影响

## 九、时间与前置

| 前置 | 说明 |
|---|---|
| 域名 | 不阻塞 S0；下载链接先占位 |
| R2 桶 | 阻塞「发布渠道切换」一步；可在 S0 之后再开 |
| Cloudflare 账号 | 阻塞 S3 部署（第 7 步）；**免费档即可，无需付费** |

**建议执行顺序**：1 → 2 → 3 → 4（每步跑一次 `npm test` + `npm run typecheck`）→ 5 占位 → 6 → 7。
预计 **5–6 天**，其中 4 是唯一高风险步骤，建议单独提交并逐个验证。
