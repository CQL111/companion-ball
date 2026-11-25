# 桌面陪伴 · 团子猫（companion-ball）

一只常驻桌角的 AI 团子猫。可以拖、可以放，点一下就能聊天；数据默认只在本机。

> 它不是你的助手，是住你桌面上的一个小家伙。

**当前版本：0.9.6**

安装包（最新版自动可获取）：

```bash
curl -L https://pub-2afefb77a14d4190ad7ec081cdf6bde5.r2.dev/latest.json   # 看版本与 SHA-256
```

Windows 安装包直链：`https://pub-2afefb77a14d4190ad7ec081cdf6bde5.r2.dev/releases/v0.9.6/companion-ball-public.Setup.0.9.6.exe`

---

## 它现在能做什么

| 能力 | 说明 |
|---|---|
| **在场感** | 全屏透明、点击穿透；自己走动、爬屏幕边缘、天花板倒挂、拖甩物理 |
| **有情绪** | 情绪状态机 + 台词库 + 气泡；连点会烦，被甩会晕 |
| **记得你** | 长期记忆（本地 ≤30 条）+ 猫的笔记本（每日日记，允许空白） |
| **记得还没发生的事** | 说「下周三要面试」→ 它记住了；前一天提一句、当天用身体动作、之后问结果 |
| **你不在的时候** | 离开 8 小时以上回来，笔记本里多一段你以为没人看见的日子 |
| **需要你** | 饿了 / 无聊 / 想你，但**可拒绝、不惩罚**；先有身体动作，再考虑要不要开口 |
| **看见你** | 离开 / 回来感知、久坐提醒、天气氛围（默认关闭） |
| **能聊天** | 多轮对话，DeepSeek 或本机 Ollama；人格卡让它有自己的口气 |

**刻意不做**：运势 / 黄历 / 抽卡、助手功能（写代码 / 日程管理）、云账号、任何形式的养成数值。

产品路线与取舍见 [`docs/ROADMAP.md`](docs/ROADMAP.md) 与 [`docs/PRODUCT-THESIS.md`](docs/PRODUCT-THESIS.md)。

---

## 快速开始

```bash
git clone <本仓库>
cd companion-ball
npm install

cp .env.example .env      # 填入 DEEPSEEK_API_KEY（可选，不填也能用，只是不能聊天）
npm run dev               # 开发模式（HMR）
```

首次启动会弹出用户协议；同意后团子猫出现在屏幕右下角。

> 不配 API Key 也能完整体验：情绪、走动、记忆、笔记本、需求、缺席日志、事件记忆
> **全部是本地逻辑，零 token**。只有「聊天」需要模型。

---

## 本地测试（这是你最常做的事）

### 一键全量

```bash
npm run test:all          # 单测 + 正式构建 + 主 e2e
npm run test:e2e:all      # 带调试入口的构建 + 全部四套 e2e
```

> **重要**：四套专项 e2e 需要**带调试入口的构建**（`npm run build:e2e`）。
> 用正式构建（`npm run build`）跑它们会失败——因为正式版刻意不含 `debugSpeak` 等后门。
> `npm run test:e2e:all` 已经自动处理这个顺序。

### 分层跑

```bash
npm test                  # Vitest（299 条）+ core 边界 + 文档一致性门禁
npm run typecheck         # 桌面端两套 tsconfig + 契约包
npm run check:server      # 服务端类型检查
npm run build             # 正式构建（无调试入口）→ packages/desktop/out/
npm run build:e2e         # 带调试入口的构建（仅测试用）
npm run test:e2e          # 主 e2e（需先 build 或 build:e2e）
```

`npm test` 里三道门禁各自守什么：

| 门禁 | 守什么 |
|---|---|
| Vitest | 领域逻辑（core 零平台依赖，可在纯 node 下跑） |
| `check-core-boundary` | `core/` 与 `contracts/` **不得** import electron / node 内置 / DOM |
| `check-docs` | CHANGELOG 版本号与 package.json 一致、ROADMAP 无过期说法 |

### 四个真机专项（验证「看不见的行为」）

主 e2e 只证明「应用能起来」，这四个证明**功能真的生效**：

```bash
npm run test:e2e:all      # 自动：build:e2e → 四套全跑
```

单独跑（需先 `npm run build:e2e`）：

```bash
cd packages/desktop
node tests/e2e/smoke.mjs        # 主冒烟（17 项）
node tests/e2e/needmotion.mjs   # P0.5：需求是否驱动了身体（6 项）
node tests/e2e/absence.mjs      # P1：缺席是否写进日记（9 项）
node tests/e2e/occasions.mjs    # P1.5：随口一句是否被记住（14 项）
```

它们会：启动真实 Electron → 用隔离 `--user-data-dir`（**不碰你的配置**）→
读 `data-loco` / `data-clip` 等渲染状态 → 断言完自动结束进程。

---

## 手动验证（想自己点一点）

**调试入口只在开发模式（`npm run dev`）暴露，打包后的正式版没有。**
在宠物窗口的 DevTools Console 里执行：

```js
window.debugSpeak('need')        // 立刻触发一次「饿了」需求 → 看它走到屏幕边缘
window.debugSpeak('sit')         // 触发久坐提醒
window.debugSpeak('back')        // 模拟「你刚回来」
window.debugSleep(true)          // 强制睡着（验证「睡觉时不表达需求」）
window.debugSleep(false)         // 醒来
window.api.debugAbsenceDiary(9 * 3600 * 1000)   // 模拟 9 小时缺席 → 打开笔记本看新日记
window.api.occasionDebugRemember('我下周三下午要面字节')  // 试事件记忆
window.api.occasionsList()       // 看它记住了哪些「有日期的事实」
window.api.getNotebookView()     // 看笔记本
```

> 上面每一条都已在本机实测通过（见 `packages/desktop/tests/e2e/` 的同名验证）。

手动检查清单：

- [ ] 拖到任意位置 → 重启 → 还在原位
- [ ] 连点 5 次 → 它会不耐烦
- [ ] 让它走到屏幕边缘 → 会往上爬
- [ ] `debugSpeak('need')` → 它走开（不是只冒一句话）
- [ ] `debugSleep(true)` 后再触发需求 → **它不动**
- [ ] `debugAbsenceDiary` → 笔记本出现「你走了很久」这类句子，且**没有数字**
- [ ] `occasionDebugRemember('明天要体检')` → 笔记本出现「我会记得的」

---

## 构建与发布

```bash
npm run build:public      # 公开版安装包（不内置 Key）→ packages/desktop/out-public/
npm run build:personal    # 内置 Key 版（读 packages/desktop/bundled-ai.json）→ out-release-key/
npm run release           # 门禁 → 升版本 → tag → push → 构建 → 上传 R2
npm run publish:r2        # 只上传已有产物（不含发版流程）
```

**发布去向**：安装包上传到 **Cloudflare R2**，由 `latest.json` 索引，站点下载页读取它。
GitHub Release 仅作内部记录（仓库已转私有，Release 不再公开）。

发版纪律见 [`docs/RELEASING.md`](docs/RELEASING.md)：一次可交付版本 =
CHANGELOG 条目 + 功能测试通过 + tag + Release。

---

## 仓库结构

```
packages/
  desktop/              桌面客户端（Electron）
    src/main/           主进程：窗口 / 托盘 / IPC / 服务
    src/preload/        contextBridge 白名单
    src/renderer/pet/   团子猫（命令式 TS，不引入 React）
    src/renderer/       chat · settings · notebook · legal（React 19）
    src/core/           领域逻辑（零平台依赖，为手机端预留）
    src/shared/         通道名 / zod schema / 类型
    src/data/           内容资产（台词、人格卡）
    tests/e2e/          真实启动应用的验证
  contracts/            桌面端与服务端共用的瓶子规则（唯一源）
  server/               许愿瓶 API（Workers / Node 双运行时）
  web/                  产品页 + Pages Functions
scripts/                跨包脚本：core 边界 / 文档门禁 / 发版 / 发布
docs/                   产品与工程文档
```

完整设计见 [`docs/REPO-LAYOUT.md`](docs/REPO-LAYOUT.md)，技术架构见
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

技术栈：electron-vite 4 · Vite 7 · TypeScript 5.9 · React 19 · zod 4 · Vitest 3

工程约定、常见坑与代码地图见 **[`AGENTS.md`](AGENTS.md)**。

---

## 文档索引

| 文档 | 用途 |
|---|---|
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | 产品定位、里程碑、闸门、指标 |
| [`docs/PRODUCT-THESIS.md`](docs/PRODUCT-THESIS.md) | 为什么这么做：四根支柱、机制、投资逻辑 |
| [`docs/OCCASIONS.md`](docs/OCCASIONS.md) | 事件记忆规格（「有日期的事实」） |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 分层、进程模型、IPC、存储、安全 |
| [`docs/REPO-LAYOUT.md`](docs/REPO-LAYOUT.md) | 仓库设计图与依赖方向 |
| [`docs/RELEASING.md`](docs/RELEASING.md) | 变更纪律 |
| [`docs/VPS-DEPLOY.md`](docs/VPS-DEPLOY.md) | 把服务端部署到自己的服务器 |
| [`docs/SERVER.md`](docs/SERVER.md) | 许愿瓶接口与风险 |
| [`docs/legal/`](docs/legal/) | 隐私政策 / 用户协议 / 免责声明 |

---

## 隐私

- 记忆、日记、事件记忆、聊天记录**只在本机**，不上传
- 只读系统空闲秒数判断「在不在」——**不读窗口标题、不截屏、不记录键盘**
- 联网只有三处，且都需要你主动开启：AI 对话、天气（默认关）、许愿瓶（默认关）

## 与 fortune-ball 的关系

从 `fortune-ball`（今日运势桌宠，已冻结在 v1.3.0）剥离的陪伴壳，**移除了全部运势 /
黄历 / 卡片 / 精灵代码**。本仓库是独立 git 历史，不共享代码包。

## License

MIT
