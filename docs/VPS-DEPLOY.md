# 自建服务器部署（VPS）

> 为什么需要这台：`*.workers.dev` 在国内不可达，Cloudflare 方案对国内用户失效。
> 服务端已重构为「**一套业务逻辑，两个运行时**」——同一份 `handler.ts` 可以跑在
> Workers 或任何 Node 22.5+ 的机器上，迁回 Cloudflare 也不需要改业务代码。
>
> 本文只写 VPS 路径。Cloudflare 路径见 [`SERVER.md`](SERVER.md)。

## 一、前置

| 项 | 要求 |
|---|---|
| 服务器 | 1 核 1G 起，香港/新加坡**免备案**，国内节点需 ICP 备案 |
| Node | **22.5+**（需要 `node:sqlite`；24+ 默认开启，22.5–23 要 `--experimental-sqlite`） |
| 域名 | 一个子域，如 `api.你的域名.com`（客户端要填它） |
| 反代 | Caddy（推荐，自动 HTTPS）或 Nginx + certbot |

**所有第三方依赖为零**：HTTP 用 `node:http`，数据库用 `node:sqlite`，只在构建时用 esbuild。

## 二、部署步骤

```bash
# 1) 拉代码
git clone <私有仓库地址> /opt/companion-ball
cd /opt/companion-ball

# 2) 安装依赖并构建服务端（产物是单文件）
npm ci
npm run -w @companion/server build      # → packages/server/dist/node.mjs

# 3) 目录与数据
sudo mkdir -p /var/lib/companion && sudo chown $USER /var/lib/companion

# 4) 启动（前台先跑一次，确认能起来）
DB_PATH=/var/lib/companion/companion.db PORT=8787 \
DOWNLOAD_BASE_URL=https://download.你的域名.com \
TRUST_PROXY=1 \
node --experimental-sqlite packages/server/dist/node.mjs
```

首次启动会自动执行 `schema.sql` 建表（含 `rate_counters`）。**建表失败会直接退出**，
不会「看起来在跑但接口全 500」。

## 三、systemd 守护

`/etc/systemd/system/companion-bottles.service`：

```ini
[Unit]
Description=companion-ball bottle API
After=network.target

[Service]
Type=simple
User=companion
WorkingDirectory=/opt/companion-ball
# Node 24+ 可去掉 --experimental-sqlite
ExecStart=/usr/bin/node --experimental-sqlite packages/server/dist/node.mjs
Restart=always
RestartSec=3
# 环境变量
Environment=PORT=8787
Environment=DB_PATH=/var/lib/companion/companion.db
Environment=DOWNLOAD_BASE_URL=https://download.example.com
Environment=TRUST_PROXY=1
Environment=NODE_ENV=production
# 收紧权限
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/companion

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now companion-bottles
sudo systemctl status companion-bottles
journalctl -u companion-bottles -f
```

## 四、Caddy 反代（自动 HTTPS）

`/etc/caddy/Caddyfile`：

```caddy
api.你的域名.com {
    # 把真实 IP 交给服务端（必须在 TRUST_PROXY=1 时才被采信）
    reverse_proxy 127.0.0.1:8787 {
        header_up X-Real-IP {remote_host}
    }
    encode gzip
}
```

> **安全提醒**：`TRUST_PROXY=1` 时服务端采信 `X-Real-IP`。必须确保这端口只对
> Caddy 开放（`127.0.0.1`），不要让公网直接打到 8787，否则客户端可伪造 IP 绕过限流。

## 五、环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8787 | 监听端口 |
| `DB_PATH` | `data/companion.db` | SQLite 文件路径 |
| `DOWNLOAD_BASE_URL` | 空 | 安装包下载域（R2 或自建静态站） |
| `BOTTLE_TTL_DAYS` | 7 | 沉海天数 |
| `MAX_PICKS` | 3 | 一个瓶子最多被捡几次 |
| `DAILY_BOTTLE_LIMIT` | 3 | 单设备每日扔瓶 |
| `DAILY_REPLY_LIMIT` | 10 | 单设备每日回信 |
| `PICK_PER_HOUR` | 10 | 单设备每小时捡瓶 |
| `INBOX_PER_HOUR` | 20 | 单设备每小时收信 |
| `REPORT_PER_DAY` | 20 | 单设备每日举报 |
| `IP_RATE_LIMIT_PER_MIN` | 30 | 单 IP 每分钟写请求 |
| `EMERGENCY_OFF` | 0 | `1` = 所有写接口 503 |
| `TRUST_PROXY` | 0 | `1` = 采信反代写入的真实 IP |

## 六、备份（唯一不能省的事）

`/usr/local/bin/companion-backup.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
DEST=/var/backups/companion
mkdir -p "$DEST"
# sqlite 在线备份：WAL 模式下 .backup 是一致的
sqlite3 /var/lib/companion/companion.db ".backup '$DEST/companion-$(date +%F).db'"
# 只保留 14 天
find "$DEST" -name 'companion-*.db' -mtime +14 -delete
```

```bash
chmod +x /usr/local/bin/companion-backup.sh
# 每天 04:17 备份（避开整点）
echo "17 4 * * * /usr/local/bin/companion-backup.sh" | crontab -
```

> 若机器上没有 `sqlite3` 命令：`apt install sqlite3`。

## 七、客户端接入

服务端地址由构建时的 `DEFAULT_ENDPOINT` 决定（`packages/desktop/src/main/mail.ts`）：

```ts
const DEFAULT_ENDPOINT = 'https://api.你的域名.com'
```

改完重新构建发布。用户也可以在设置里手动填写。

## 八、验收

```bash
# 健康检查
curl https://api.你的域名.com/v1/health
# → {"ok":true,"paused":false}

# 下载清单（若配置了 DOWNLOAD_BASE_URL）
curl https://api.你的域名.com/v1/download/manifest
```

互投冒烟（两个不同 token）：

```bash
A=token-aaaaaaaaaaaaaaaa; B=token-bbbbbbbbbbbbbbbb; H=https://api.你的域名.com
curl -s -X POST $H/v1/bottle -H "X-Device-Token: $A" \
  -H 'content-type: application/json' -d '{"body":"今晚加班到很晚","utcOffsetMinutes":480}'
curl -s -X POST $H/v1/bottle/pick -H "X-Device-Token: $B" \
  -H 'content-type: application/json' -d '{"utcOffsetMinutes":480}'
```

## 九、安全清单

- [ ] 8787 只监听内网/本机，公网只开 443
- [ ] `TRUST_PROXY=1` 且反代确实会覆盖（而不是追加）IP 头
- [ ] 只在需要时开 `EMERGENCY_OFF`
- [ ] 备份任务在跑，且**恢复到临时目录演练过一次**
- [ ] 隐私政策写明：数据存储在你自己的服务器（地区），不再写 Cloudflare

## 十、想回 Cloudflare 怎么办

业务代码不动，改两处：

1. `wrangler.toml` 的 `main = "src/worker.ts"`（已是）
2. 给 Worker **绑定自定义域名**（不能用 `*.workers.dev`）

D1 的数据库需要用 `wrangler d1 execute --file=schema.sql` 重新建表，数据不自动迁移。
