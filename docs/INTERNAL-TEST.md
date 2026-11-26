# 内测手册：自建服务器 + 2 人联调

> 场景：大陆自用服务器，**纯 IP + 非标端口**，2 人邀请制内测，不备案、不开后台。
> 正式上线（域名 + 备案）见 [`VPS-DEPLOY.md`](VPS-DEPLOY.md)。

---

## 一、这个方案不做的事（先说清楚）

| 不做 | 原因 |
|---|---|
| 不用域名、不用 HTTPS | 你决定用 IP 直连；内测期被扫到可以接受 |
| **不用管理后台** | `__Host-` Cookie 强制 `Secure`，`http://` 下浏览器会丢弃 → 登录后立刻掉线 |
| 不办备案 | 邀请制、不对外宣传、不提供公开注册；仅开发与功能验证 |
| 不开放公网注册 | 参与者由你直接发安装包 |

**因此批准公开的瓶子要靠 SQL**，见第五节。这是这个方案的代价，内测期可接受。

---

## 二、服务器准备

| 项 | 要求 |
|---|---|
| 系统 | 任意 Linux x64 |
| Node | **22.5+**（`node:sqlite` 需要；22.5–23 要 `--experimental-sqlite`） |
| 内存 | 512MB 足够 |
| 端口 | 用 **非标端口**（如 `8899`），少被扫描 |

```bash
# 防火墙只开你用的那一个端口
sudo ufw allow 8899/tcp
```

> 不开 80/443，减少「看起来像 Web 服务」的概率。

---

## 三、构建与部署

在本机（Windows）构建，然后把 `dist/` 传上去——服务器不需要装 npm 依赖。

```bash
# 本机
npm ci
npm run build:platform          # 前台 + 后台 + 服务端 → packages/server/dist/

# 传到服务器
scp -r packages/server/dist user@你的IP:/opt/companion/
```

服务器上：

```bash
sudo mkdir -p /var/lib/companion && sudo chown $USER /var/lib/companion

cd /opt/companion/dist
DB_PATH=/var/lib/companion/companion.db \
PORT=8899 \
SITE_URL=http://你的IP:8899 \
INTRA_TEST=1 \
TRUST_PROXY=0 \
node --experimental-sqlite node.mjs
```

首次启动会打印 `[server] migrations applied: ...`（6 个迁移）。

**环境变量说明**

| 变量 | 内测值 | 为什么 |
|---|---|---|
| `PORT` | `8899` | 非标端口，少被扫 |
| `DB_PATH` | `/var/lib/companion/companion.db` | 数据放系统目录 |
| `SITE_URL` | `http://你的IP:8899` | 桌面端「看看此刻的海」跳转用 |
| `INTRA_TEST` | `1` | **捡瓶忽略时段池**——2 人分时段上线，否则永远碰不到 |
| `TRUST_PROXY` | `0` | 没有反代，不信任何转发头 |
| `TOTP_MASTER_KEY` | 可留空 | 不用后台就不需要 |

> `INTRA_TEST=1` 是内测专用。正式运营必须是 `0`——「同时段的人更容易共鸣」是产品设计。

### systemd（可选，开机自启）

`/etc/systemd/system/companion.service`：

```ini
[Unit]
Description=companion-ball server (internal test)
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/opt/companion/dist
Environment=PORT=8899
Environment=DB_PATH=/var/lib/companion/companion.db
Environment=SITE_URL=http://你的IP:8899
Environment=INTRA_TEST=1
Environment=TRUST_PROXY=0
ExecStart=/usr/bin/node --experimental-sqlite node.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now companion
journalctl -u companion -f          # 看日志
```

---

## 四、桌面端怎么连上

### 内测版打包时写死地址

`packages/desktop/src/main/mail.ts`：

```ts
// 打包版（app.isPackaged === true）用这里；内测临时填你的 IP
const DEFAULT_ENDPOINT = app.isPackaged ? 'http://你的IP:8899' : 'http://127.0.0.1:8080'
```

然后打包给 2 个人：

```bash
npm run build:public     # 产物在 packages/desktop/dist-public/0.10.0/
```

> 或者不改代码，让每个人在 **设置 → 许愿瓶 → 服务端地址** 手动填 `http://你的IP:8899`。
> 2 个人手动填一次更省事，也避免把 IP 写进安装包。

### 验证连上了

打开许愿瓶 → 不显示「猫邮局还没开门」→ 能点「我知道，开启许愿瓶」。

---

## 五、手动批准公开的瓶子（替代后台）

网页橱窗只显示 `approved`。**批准靠 SQL**：

```bash
sqlite3 /var/lib/companion/companion.db
```

先看有哪些待审：

```sql
SELECT id, body, pool, datetime(created_at/1000, 'unixepoch', 'localtime') AS created
  FROM gallery_bottles
 WHERE status = 'pending'
 ORDER BY created_at DESC;
```

批准一条：

```sql
UPDATE gallery_bottles
   SET status      = 'approved',
       reviewed_by = 'manual',
       reviewed_at = strftime('%s','now') * 1000,
       -- 30 天后自动下架；不填就永远不删（内测无所谓，正式必须填）
       expires_at  = (strftime('%s','now') + 30*86400) * 1000
 WHERE id = '刚才查到的 id';
```

驳回：

```sql
UPDATE gallery_bottles
   SET status = 'rejected', reviewed_by = 'manual',
       reviewed_at = strftime('%s','now') * 1000,
       review_note = '不合适'
 WHERE id = '...';
```

下架已批准的：

```sql
UPDATE gallery_bottles SET status = 'withdrawn' WHERE id = '...';
```

> **注意**：`expires_at` 为 NULL 时前台**仍然会显示**（查询条件是 `expires_at IS NULL OR expires_at > now`）。
> 所以「批准了就永远在」——这是设计如此（官方种子没有过期时间），但人工批准时建议填上。

### 只批准，不用看内容？

如果不想逐条看，可以按时间批量批准（**内测建议还是看一眼**）：

```sql
UPDATE gallery_bottles
   SET status = 'approved',
       reviewed_at = strftime('%s','now') * 1000,
       expires_at = (strftime('%s','now') + 30*86400) * 1000
 WHERE status = 'pending';
```

---

## 六、2 人联调流程

```
A 扔瓶（勾选公开）
  ↓
你查 SQL → 批准
  ↓
B 打开 http://你的IP:8899/gallery → 看到
  ↓
B 在客户端「让猫出去看看」→ 捡到
  ↓
B 回一句
  ↓
A 在许愿瓶里点「收到的回信」→ 看到
```

**注意 A 和 B 的捡瓶**：猫不是随时出门的。

```
shouldGoOut: 至少间隔 45 分钟，且 35% 概率
实际平均 2–3 小时才出门一次
```

**内测时直接点「让猫出去看看」**——它走的是 `force=true`，跳过节奏判断。

---

## 七、每日检查

```bash
# 服务活着吗
curl http://你的IP:8899/v1/health

# 有多少待审
sqlite3 /var/lib/companion/companion.db "SELECT COUNT(*) FROM gallery_bottles WHERE status='pending';"

# 有多少瓶在漂
sqlite3 /var/lib/companion/companion.db "SELECT COUNT(*) FROM bottles WHERE expires_at > strftime('%s','now')*1000;"
```

---

## 八、已知限制（内测期）

| 限制 | 影响 | 何时解决 |
|---|---|---|
| 没有后台 | 批准靠 SQL | 上域名 + HTTPS 后 |
| **没有定时清理** | 瓶子不会自动沉海、橱窗不会自动下架 | 正式前必须补 cron |
| 无 HTTPS | Cookie 走不了，后台不可用；纸条明文传输 | 上域名 |
| 无自动备份 | 数据丢了就没了 | 见下方 |
| 无索引 | 数据量小，无所谓 | 千人级再看 |

### 至少做一次备份

```bash
sqlite3 /var/lib/companion/companion.db ".backup '/var/lib/companion/backup-$(date +%F).db'"
```

加到 cron（每天凌晨）：

```bash
0 4 * * * sqlite3 /var/lib/companion/companion.db ".backup '/var/lib/companion/backup-$(date +\%F).db'"
```

---

## 九、内测结束怎么收尾

```bash
# 1. 停服务
sudo systemctl stop companion

# 2. 导出全部数据（留档）
sqlite3 /var/lib/companion/companion.db ".backup '/var/lib/companion/final.db'"

# 3. 彻底删除（用户要求删数据时）
#    —— 注意这会删掉所有人的瓶子，先确认
rm -f /var/lib/companion/companion.db*
```

如果之后要转正式（域名 + 备案），把 `companion.db` 拷到新服务器即可——
迁移文件会自动应用差异，数据不用重建。
