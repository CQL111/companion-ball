# 本地测试许愿瓶

> 不需要 Cloudflare 账号、不需要 wrangler、不需要建数据库。
> 一个内存 mock 服务端 + 客户端设置页填个地址，就能跑完全流程。

## 一、最简路径（推荐）

```bash
# 1. 启动 mock 服务端（零依赖，纯内存）
node scripts/mock-bottle-server.mjs

# 2. 另开一个终端启动应用
npm run dev
```

启动后终端会打印：

```
许愿瓶 mock 服务端已启动: http://127.0.0.1:8787
  预置纸条: 3 张
```

**3. 在应用里开启**：托盘 → 设置 → 「许愿瓶」→ 服务端地址填 `http://127.0.0.1:8787`
→ 勾选「开启许愿瓶」→ 点「打开许愿瓶」。

**4. 测试各个流程**

| 想测试 | 怎么做 | 预期 |
|---|---|---|
| 扔瓶 | 写一句话 → 放进海里 | 提示已放入；今日计数 +1 |
| 捡瓶 | 「让猫出去看看」 | 叼回一张预置纸条 |
| 回信 | 读纸条 → 写一句 → 悄悄回一句 | 提示已放回 |
| 每日上限 | 连扔 4 次 | 第 4 次提示「今天放得够多了」 |
| 举报 | 读纸条时点「举报」 | 这张对所有人不可见 |
| 紧急停机 | 用 `--paused` 重启服务端 | 写操作提示「猫邮局暂时关门了」 |
| 自动巡游 | 等 10 分钟（或托盘「让猫出门看看」） | 猫叼回纸条，写进笔记本 |

## 二、mock 服务端能调什么

```bash
node scripts/mock-bottle-server.mjs --port 9000   # 换端口
node scripts/mock-bottle-server.mjs --seed 10     # 预置 10 张纸条（默认 3）
node scripts/mock-bottle-server.mjs --paused      # 模拟紧急停机
```

数据**只在内存里**，重启即清空——测试时可以随意造数据。

## 三、想测「两个用户互相投递」

mock 服务端按设备令牌区分用户。用一个设备看流程够用；要模拟两个人，需要两个 `installId`：

```bash
# 启动第二个实例，使用独立 userData（会自动生成新的 installId）
npx electron . --user-data-dir="$(mktemp -d)"
```

然后在两个实例里都开启许愿瓶、指向同一个 mock 地址。A 扔的纸条，B 有可能捡到
（同一时段池 + 随机选取）。

> 注意：mock 的「捡」是**随机挑一张**，所以 A 自己可能先捡到 B 的、B 也可能空手。
> 多试几次即可。

## 四、和真实服务端的差异

| 项 | mock（`scripts/mock-bottle-server.mjs`） | 真实（`server/`） |
|---|---|---|
| 存储 | 内存，重启清空 | D1 |
| 内容策略 | 固定 `open` | 可配置（国内 `filtered` / 海外 `open`） |
| 限流 | 单设备每日 3 个 / 10 封 | 同左，另有 IP 层 |
| 紧急停机 | `--paused` 启动参数 | `EMERGENCY_OFF=1` 环境变量 |
| 中文 | 正常 | 正常（**wrangler 本地模拟器有 UTF-8 缺陷，会显示 `?`，是模拟器问题**） |

接口路径、错误码、状态机与真实服务端**完全一致**，所以客户端代码不需要为 mock 做任何特殊处理。

## 五、用 wrangler 测（更接近生产）

如果要在接近真实的环境里验证（包括 D1 的 SQL）：

```bash
cd server
npm install
npx wrangler d1 execute companion-bottles-test --local --file=./schema.sql
npx wrangler dev --local --port 8788
```

然后把客户端地址填 `http://127.0.0.1:8788`。

**已知问题**：wrangler 本地模拟器会把请求体里的中文解码成 `?`（数据库里的 `hex` 是 `3F3F…`），
这是模拟器的缺陷，真实 Workers 不会。用 mock 服务端测中文更省事。

## 六、调试快捷方式

不需要打开按钮也能触发流程——在开发者工具里直接调：

```js
// 让猫立刻出门一次（跳过 45 分钟节奏）
await window.api.bottlePatrolNow()

// 查状态
await window.api.bottleStatus()

// 直接扔一张
await window.api.bottleThrow('测试一句话')

// 查看笔记本（纸条会写进当天日记）
await window.api.getNotebookView()
```

## 七、排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 设置里「开启」按钮是灰的 | 服务端地址没填 | 先填 `http://127.0.0.1:8787` |
| 提示「海面不太平静」 | 连不上 mock | 确认 mock 进程还在、端口一致 |
| 一直是「空手回来」 | 没有同池的纸条 | 用 `--seed 10` 增加预置纸条，或自己先扔一张（不同设备才能捡到自己的） |
| 中文显示成 `?` | 你在用 wrangler 本地模式 | 换用 mock 服务端 |
| 托盘没有「让猫出门看看」 | 许愿瓶没开启 | 开启后托盘菜单才出现 |
