# 许愿瓶服务端设计

> S3 引入的联网服务。**这是本项目第一次承载用户内容**，性质与之前完全不同：
> 从「单机应用」变成「需要运营的 UGC 服务」。
> 产品原则见 [`ROADMAP.md`](ROADMAP.md) 第四节；工程分层见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

## 〇、发布地区策略（2026-11-20 决定）

`CONTENT_POLICY` 按**发布地区**切换，服务端是唯一开关来源：

| 发布形态 | 部署 | CONTENT_POLICY | 说明 |
|---|---|---|---|
| 国内版 | 国内云（需备案） | `filtered` | 拦截联系方式与链接；后续接机审 |
| 海外版 | Cloudflare | `open` | 不限制内容 |

**server 目录先保留单一实现**，按地区拆分发布时再分叉——但只分叉配置，不复制代码：

```toml
# 国内版 wrangler.toml
[vars]
CONTENT_POLICY = "filtered"

# 海外版 wrangler.toml
[vars]
CONTENT_POLICY = "open"
```

拆分时把 `CONTENT_POLICY` 从常量改成读环境变量即可（`rules.ts` 与 `mailbox.ts` 各改一行）。

> 时机：**做国内版之前必须完成**。在那之前唯一部署是海外版，`open` 是显式选择而非遗漏。

## 一、先读风险

按当前决策（**海外部署 + 设备匿名 + 仅正则审核**），这是三种选项里**风险最高的组合**。
写下这几行不是为了免责，是为了让你知道自己在运营什么：

| 风险 | 现状 | 缓解 |
|---|---|---|
| 违法内容进入池子 | 只有正则（手机号 / 微信 / QQ / 链接） | 举报即隐藏 + 每日人工抽查 + 紧急全局开关 |
| 无法追责与封禁 | 设备令牌可被重装绕过 | 令牌可吊销（服务端 blacklist）；按 IP 段限流 |
| 服务被刷 | 匿名开放接口 | 单设备日限额 + IP 限流 + 内容长度上限 |
| 数据出境 | Workers / D1 在海外 | 隐私政策明确写出；仅存文本与匿名代号 |
| 公开推广后责任放大 | 目前未做任何推广 | **未通过 S5 合规评估前不推广、不上架应用商店** |

**在任何公开推广之前，至少要补齐**：内容审核（机审或人工轮值）、举报响应时限、
违规处置流程、留存规则。那份清单属于 S5「公开化」，不是 S3。

## 二、产品规则（与客户端契约一致）

```
扔瓶 → 进入「同频池」→ 另一人捡到 → 可回一句 → 原投递者收到回信 → 断
        
约束：
- 7 天没人捡 → 沉海（服务端删除，不发通知）
- 回信不可追问、不显示任何数字
- 一个瓶子最多被捡 N 次（默认 3），避免同一张纸条被反复消费
- 一个瓶子最多收 1 封回信
```

### 同频匹配

按**本地时段**分池，而不是按地理位置（不收集位置）：

| 池 | 本地时间 |
|---|---|
| `night` | 22:00 – 05:00 |
| `morning` | 05:00 – 11:00 |
| `day` | 11:00 – 18:00 |
| `evening` | 18:00 – 22:00 |

深夜写的瓶子优先漂给深夜还醒着的人。客户端上报时区偏移（`utcOffsetMinutes`），
服务端据此分池——**只存时段标签，不存时区**。

## 三、数据模型（D1 / SQLite）

```sql
-- 投递的纸条
CREATE TABLE bottles (
  id           TEXT PRIMARY KEY,      -- 服务端生成（不可枚举，随机 128bit）
  pool         TEXT NOT NULL,          -- night | morning | day | evening
  body         TEXT NOT NULL,          -- 已做长度与正则校验
  author_token TEXT NOT NULL,          -- 设备令牌哈希（不存原文）
  alias        TEXT NOT NULL,          -- 投递者的匿名代号，如「夜里的橘子」
  created_at   INTEGER NOT NULL,       -- unix ms
  expires_at   INTEGER NOT NULL,       -- created_at + 7 天
  picks        INTEGER NOT NULL DEFAULT 0,
  reply_id     TEXT,                   -- 收到的回信（最多一封）
  hidden       INTEGER NOT NULL DEFAULT 0,  -- 举报后置 1
  hidden_reason TEXT
);

-- 回信
CREATE TABLE replies (
  id           TEXT PRIMARY KEY,
  bottle_id    TEXT NOT NULL,          -- 被回的那张纸条
  body         TEXT NOT NULL,
  author_token TEXT NOT NULL,
  alias        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  hidden       INTEGER NOT NULL DEFAULT 0
);

-- 领取记录：保证同一设备不会反复捡同一张
CREATE TABLE picks (
  bottle_id    TEXT NOT NULL,
  picker_token TEXT NOT NULL,
  picked_at    INTEGER NOT NULL,
  PRIMARY KEY (bottle_id, picker_token)
);

-- 举报
CREATE TABLE reports (
  id         TEXT PRIMARY KEY,
  bottle_id  TEXT,
  reply_id   TEXT,
  reason     TEXT NOT NULL,            -- spam | abuse | other
  created_at INTEGER NOT NULL
);

-- 吊销的令牌（紧急封禁）
CREATE TABLE revoked_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  note       TEXT
);
```

索引：

```sql
CREATE INDEX idx_bottles_pool ON bottles(pool, expires_at, hidden);
CREATE INDEX idx_bottles_author ON bottles(author_token, created_at);
CREATE INDEX idx_picks_picker ON picks(picker_token, picked_at);
```

## 四、接口

所有接口都是 `POST` + JSON，无 Cookie，携带 `X-Device-Token`。

| 接口 | 作用 | 限流 |
|---|---|---|
| `POST /v1/bottle` | 扔一个瓶子 | 单设备 3 个/天 |
| `POST /v1/bottle/pick` | 捡一个（可能空手） | 单设备 10 次/小时 |
| `POST /v1/bottle/reply` | 回一句 | 单设备 10 封/天 |
| `POST /v1/bottle/inbox` | 取自己收到的回信 | 单设备 20 次/小时 |
| `POST /v1/report` | 举报 | 单设备 20 次/天 |

### 扔

```jsonc
// POST /v1/bottle
{ "body": "今天加班到很晚", "alias": "夜里的橘子", "utcOffsetMinutes": 480 }
// →
{ "ok": true, "id": "...", "expiresAt": 1700000000000 }
```

### 捡

```jsonc
// POST /v1/bottle/pick
{ "utcOffsetMinutes": 480 }
// 命中 →
{ "ok": true, "bottle": { "id": "...", "body": "...", "alias": "凌晨三点的猫" } }
// 没命中 →
{ "ok": true, "bottle": null }
```

服务端选中后**立即写入 `picks`**，并把 `picks` +1；同一设备不会再捡到同一张。

### 回

```jsonc
// POST /v1/bottle/reply
{ "bottleId": "...", "body": "早点睡", "alias": "路过的人" }
// 若瓶子已被回过 →
{ "ok": false, "error": "ALREADY_REPLIED" }
```

### 收

```jsonc
// POST /v1/bottle/inbox
{ }
// →
{ "ok": true, "replies": [ { "bottleId": "...", "body": "早点睡", "alias": "路过的人", "createdAt": 1700000000000 } ] }
```

回信送达后，服务端把瓶子标记为已结束（不保留投递者与回信者的关联）。

## 五、审核与处置

按当前决策，S3 只做**最小可用的三道闸**：

```js
// 1. 正则拦截（客户端与服务端各做一次：客户端体验，服务端是真正的边界）
const BLOCKED = [
  /(?:\+?86)?1[3-9]\d{9}/,          // 手机号
  /\b(?:weixin|wechat|wx)\b\s*[:：]?\s*\w+/i,
  /\bqq\s*[:：]?\s*\d{5,}/i,
  /(?:https?:\/\/|www\.)\S+/i,
]

// 2. 举报即隐藏：hidden = 1，所有人不可见（不删除，留作复核）
// 3. 紧急开关：KV 里一个 EMERGENCY_OFF=1，所有写接口直接返回 503
```

**没做但必须知道的**：没有机审、没有人工轮值、没有违规关键词库。这意味着
**一旦有违法内容进入池子，只能靠举报发现**。所以：

- 不做任何公开推广
- 每日至少人工抽查一次（`SELECT * FROM bottles WHERE created_at > ... ORDER BY RANDOM() LIMIT 20`）
- 一旦出现严重内容，立即开紧急开关并清理数据

## 六、隐私边界（必须落到协议里）

| 数据 | 是否离开设备 | 说明 |
|---|---|---|
| 纸条正文 | ✅ | 这是功能前提 |
| 回信正文 | ✅ | 同上 |
| 设备令牌 | ✅（仅哈希） | 用于限流与防重放，不与其他数据关联 |
| 匿名代号 | ✅ | 客户端生成，**建议每次随机**，不复用 |
| AI 对话 | ❌ | 仍只在本机 |
| 记忆 / 日记 | ❌ | 仍只在本机 |
| 位置 / 时区 | ⚠️ 只上传「时段标签」 | 不上传坐标，不落库时区 |

上线前必须：

- 隐私政策增加「许愿瓶」一节
- `AGREEMENT_VERSION` +1
- 设置里该功能**默认关闭**，开启时弹一次说明

## 七、部署

```bash
cd server
npm install
npx wrangler d1 create companion-bottles      # 首次
npx wrangler d1 execute companion-bottles --file=./schema.sql --remote
npx wrangler deploy
```

环境变量（`wrangler.toml`）：

| 变量 | 说明 |
|---|---|
| `EMERGENCY_OFF` | 设为 `1` 立即关闭所有写接口 |
| `DAILY_BOTTLE_LIMIT` | 默认 3 |
| `BOTTLE_TTL_DAYS` | 默认 7 |
| `MAX_PICKS` | 默认 3 |

## 八、验收

- 单设备超过每日上限 → 429
- 举报后该内容对所有设备不可见
- `EMERGENCY_OFF=1` → 写接口 503，读接口仍可用
- 同一设备不会重复捡到同一张纸条
- 7 天后自动不可捡（cron 清理或查询时过滤）
- `mailbox.ts` 的规则与服务器行为一致（同一套常量）
