# 仓库设计图

> 2026-11-25 起：单仓库 monorepo（私有）。**每个可部署/可发布的单元都是一个包**。
> 架构见 [`PLATFORM.md`](PLATFORM.md)；执行清单见 [`PLATFORM-S0.md`](PLATFORM-S0.md)。

## 一、结构

```
companion-ball/            仓库根：只放编排、共享文档、跨包验收（不承载任何应用代码）
│
├── packages/
│   ├── desktop/           ★ 桌面客户端（0.9.0，版本号归属这里）
│   │   ├── src/
│   │   │   ├── main/          Electron 主进程：窗口 / 托盘 / IPC / 服务
│   │   │   ├── preload/       contextBridge 白名单
│   │   │   ├── renderer/      pet（命令式）/ chat · settings · notebook · legal（React）
│   │   │   ├── core/          领域层：零平台依赖
│   │   │   │   └── mailbox.ts   ← 兼容层：re-export @contracts + 本地设置类型
│   │   │   ├── shared/        通道名 / zod schema / CompanionApi 契约
│   │   │   └── data/          内容资产：quips.json / persona.json
│   │   ├── tests/             Vitest 单测 + e2e/smoke.mjs
│   │   ├── scripts/           build-legal / build-skin / pack-skin / build-bundled-key
│   │   ├── resources/         图标 / 托盘
│   │   ├── build/             macOS entitlements
│   │   ├── electron.vite.config.ts
│   │   ├── electron-builder{,.public,.key}.yml
│   │   ├── tsconfig{,.node,.web}.json · vitest.config.ts
│   │   └── package.json       @companion/desktop
│   │
│   ├── contracts/         唯一契约源（纯 TS，零依赖，不发布）
│   │   ├── src/{constants,types,pools,lifecycle,validate,alias,errors,index}.ts
│   │   └── package.json       @companion/contracts
│   │
│   ├── server/            API Worker（Cloudflare）
│   │   ├── src/index.ts       /v1/* 处理函数（只依赖 contracts）
│   │   ├── src/crypto.ts      hashToken / randomId（服务端专用）
│   │   ├── scripts/mock-bottle-server.mjs   零依赖本地 mock
│   │   ├── schema.sql · wrangler.toml · tsconfig.json
│   │   └── package.json       @companion/server
│   │
│   ├── web/               官网 / 下载页（S5 起为 Astro）
│   │   ├── product-intro.html
│   │   ├── build-site.cjs    生成 docs/index.html（GitHub Pages 源）
│   │   └── package.json       @companion/web
│   │
│   └── admin/             （S5）审核 / 新闻 / 指标 / 开关 SPA
│
├── docs/                      产品 / 架构 / 平台文档 + legal/（法律文案唯一源）
├── scripts/                   跨包脚本：check-core-boundary · release · publish-github · publish-r2 · r2
├── .env                       （不入库）开发 Key + R2 凭证；服务端配置走 wrangler secret
├── CHANGELOG.md · README.md · AGENTS.md · CLAUDE.md
└── package.json               private + workspaces，只做编排
```

## 二、依赖方向（单向，禁止回绕）

```
                packages/contracts
                ↗       ↑       ↖
        packages/   packages/   packages/
        desktop     server      web · admin
                ↑
          packages/desktop/tests（@contracts 别名）

契约不依赖任何人；server 不 import desktop；desktop 不 import server。
```

| 包 | 可以依赖 | 禁止 |
|---|---|---|
| `contracts` | 无（纯 TS + 标准语言特性） | node / electron / zod / 任何包 |
| `desktop` | `@companion/contracts`、自身 | `packages/server`、`packages/web` |
| `server` | `@companion/contracts`、标准 Web API | `packages/desktop` |
| `web` / `admin` | `@companion/contracts` | server 源码（只经 HTTP） |

## 三、路径约定（搬家后必须记住的三条）

1. **桌面构建的根是 `packages/desktop`**：`out/`、`dist-public/`、`bundled-ai.json` 都在包内；
   `main` 字段仍是 `./out/main/index.js`。
2. **`.env` 在仓库根**：开发态由 `main/services/onlineConfig.ts` 向上查找；
   打包后的内置 Key 走 `resources/bundled-ai.json`。
3. **法律文案与文档在根 `docs/`**：`build-legal.js` 从根读 `docs/legal/`，写到 `packages/desktop/src/legal-data.js`；
   `build-site.cjs` 从根读 `package.json` 无依赖，产物写根 `docs/index.html`。

## 四、守卫

| 检查 | 命令 | 守护什么 |
|---|---|---|
| `check-core-boundary.js` | `npm run check:core` | `packages/desktop/src/core/` 零平台依赖；`packages/contracts` 同样零依赖 |
| `tests/contracts.test.ts` | `npm test` | 契约唯一源；`mailbox.ts` 只是 re-export；无 `rules.ts` 副本 |
| `tsc` 三套配置 | `npm run typecheck` | 桌面端（node + web）+ 契约 |
| server typecheck | `npm run check:server` | 服务端 |

## 五、常用命令（根目录执行）

```bash
npm install                       # 一次装好所有 workspace
npm test                          # 单测 + 契约检查 + core 边界
npm run typecheck                 # 桌面端 + 契约
npm run build                     # electron-vite 构建 → packages/desktop/out
npm run test:e2e                  # 真机功能测试

npm run dev:server                # 本地 Worker（wrangler dev）
npm run deploy:server             # 部署 Worker
npm run mock:bottle               # 零依赖 mock 服务端
npm run build:site                # 产品页 → docs/index.html
```

## 六、当前状态

- [x] **S0-1** workspaces（根 `private` + `packages/*`）
- [x] **S0-2** `packages/contracts` 唯一契约源（`mailbox.ts` re-export，`rules.ts` 副本已删除）
- [x] **S0-3** `server/` → `packages/server`
- [x] **S0-4** 守卫 / tsconfig / vite 别名 / 脚本路径适配
- [x] **S0-4b** 桌面端迁入 `packages/desktop`（src / tests / 配置 / 资源 / 脚本 / 构建配置）
- [x] **S0-5** 发布渠道：`scripts/publish-r2.js`（零依赖 SigV4）+ 站点下载页 + `/v1/download/*`
- [ ] S0-6 CI（路径过滤）
- [ ] S0-7 部署 S3（需 Cloudflare 账号）
