# 本地运行平台（服务端 + 前台 + 后台）

> 三套系统是**同源**的：前台与后台是静态资源，由服务端一起提供。
> 所以本地**只需要起一个进程**，不需要开三个终端。

---

## 一条命令

```bash
npm run dev:platform
```

它会依次：

1. 构建前台（`packages/web`）→ 产物进 `packages/server/public/`
2. 构建后台（`packages/admin`）→ 产物进 `packages/server/public/admin/`
3. 构建服务端 → `packages/server/dist/`
4. **首次运行**自动创建管理员账号（只显示一次 Key 与 TOTP 密钥）
5. 起服务，监听 `8080`

打开：

| 地址 | 是什么 |
|---|---|
| http://127.0.0.1:8080/ | 前台首页 |
| http://127.0.0.1:8080/gallery | 看海（橱窗） |
| http://127.0.0.1:8080/news | 海上的消息 |
| http://127.0.0.1:8080/download | 下载页 |
| **http://127.0.0.1:8080/admin** | **管理后台** |
| http://127.0.0.1:8080/v1/health | 健康检查 |

---

## 前置：一个密钥

后台登录需要 `TOTP_MASTER_KEY`。在仓库根目录的 `.env` 里加一行（只需一次）：

```
TOTP_MASTER_KEY=<32 字节 base64>
```

生成：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> `.env` 已在 `.gitignore` 里，不会被提交。
> 不想写文件？也可以在命令行临时传：
> `TOTP_MASTER_KEY=xxx npm run dev:platform`

---

## 改代码之后

| 改了什么 | 怎么办 |
|---|---|
| 前台页面（`packages/web/public/`） | `npm run dev:platform:watch` 会自动重建，刷新浏览器 |
| 后台页面（`packages/admin/src/`） | 同上 |
| 服务端（`packages/server/src/`） | 需要重启（Ctrl+C 后重新 `npm run dev:platform`） |
| 数据库结构 | 新建 `migrations/000N_*.sql`，重启自动应用 |

---

## 分开调试

```bash
npm run dev:web       # 只构建前台 → server/public
npm run dev:admin     # 只构建后台 → server/public/admin
npm run dev:server    # 构建并启动服务端（前两者需先构建过）
```

`dev:web` / `dev:admin` 只构建不启动——它们没有独立端口，由服务端提供。

---

## 数据在哪

`packages/server/data/dev.db`（SQLite，本地开发专用，不碰生产）

```bash
npm run db:reset      # 删掉开发库，下次启动重建并新建管理员
```

> 重置前先停掉正在运行的服务，否则文件被占用会失败。

---

## 后台第一次登录

`npm run dev:platform` 首次运行会打印：

```
账号： admin
角色： admin
API Key： 8b01e10f...
TOTP 密钥： XSO4UJS3...
```

1. 打开 http://127.0.0.1:8080/admin
2. 把 **TOTP 密钥**加到验证器 App（或手动输入）
3. 账号填 `admin`，API Key 粘贴，验证码填 App 上的 6 位数字

> 这两个值只显示一次。忘了就 `npm run db:reset` 重来。
> 想再建一个账号：登录后进「守塔人」页面。

---

## 完全重启（含重新构建）

```bash
npm run db:reset && npm run dev:platform
```

---

## 常见问题

**端口被占用**

```bash
PORT=8081 npm run dev:platform
```

**`db:reset` 报 EBUSY**

服务还在跑。先 Ctrl+C，或直接关掉占用 8080 的进程。

**`/admin` 打开是空白**

后台构建失败了。看 `npm run dev:admin` 的输出，通常是 TS 错误。

**后台登录报「验证码不对」**

手机时间不准。TOTP 允许前后 30 秒的漂移，超过就会失败——校准一下系统时间。

**想验证整套系统是否健康**

```bash
npm run test:platform     # 真实 HTTP 端到端 30 项
```
