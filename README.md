# 桌面陪伴 · 团子猫（companion-ball）· S1

一只常驻桌角的 AI 团子猫。可以拖、可以放，点一下就能聊天；数据默认只在本机。

> 它不是你的助手，是住你桌面上的一个小家伙。
> 产品页：<https://cql111.github.io/companion-ball/>

## 当前状态：S1（它有自己的生活）

这是从 `fortune-ball` 剥离出来的**最小可运行陪伴壳**。产品路线见
[`docs/ROADMAP.md`](docs/ROADMAP.md)，技术架构见
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，剥离清单见
[`docs/STRIP-LOG.md`](docs/STRIP-LOG.md)。

| 已有 | 尚未做（按里程碑） |
|---|---|
| 透明全屏窗口、点击穿透、拖拽、位置记忆 | S2 人格卡 + 长期记忆 + 猫的笔记本 |
| 情绪状态机 + 台词库 + 气泡 + 起名 | S3 许愿瓶（单机）· S4 环境感知 / 久坐提醒 |
| 托盘菜单、开机自启、单实例锁、DPI 处理 | S5–S6 猫邮局（匿名漂流，非传统交友） |
| 首次启动协议同意、法律文档、日志自检 | S6.1+ 信纸信封装饰付费 · S7 关系成长 / 角色包 |
| 多轮 AI 对话（DeepSeek / 本机 Ollama） | |
| 双版本构建与 GitHub Release 脚本 | |

## 开发

```bash
npm install
cp .env.example .env      # 填入 DEEPSEEK_API_KEY（可选）
npm run dev               # electron-vite dev（HMR）
npm test                  # Vitest + core 分层边界检查
npm run test:e2e          # 功能测试：真实启动应用（需先 build）
npm run typecheck         # TypeScript 全量类型检查
```

发版：一个可交付版本 = CHANGELOG 条目 + 功能测试 + tag + GitHub Release，
流程见 [`docs/RELEASING.md`](docs/RELEASING.md)。

## 构建与发布

```bash
npm run build             # typecheck + legal + electron-vite build → out/
npm run build:public      # 公开版（不带 Key）→ out-public/
npm run build:personal    # 内置 Key 版（读仓库根 bundled-ai.json）→ out-release-key/
npm run release:patch     # 升版本 → tag → push → 双版本构建并发布
npm run build:site        # product-intro.html → docs/index.html（GitHub Pages）
```

资产命名：

- `companion-ball-public.Setup.X.Y.Z.exe` — 公开版
- `companion-ball.Setup.X.Y.Z.exe` — 内置 Key 版

## 目录

```
src/main/               Electron 主进程：窗口 / 托盘 / IPC / 位置 / 诊断（TS）
src/preload/            IPC 白名单（contextBridge）
src/renderer/pet/       团子猫（命令式 TS：拖拽 / 菜单 / 热区）
src/renderer/{chat,settings,consent,legal}/   React 19 窗口
src/core/               领域逻辑（零平台依赖，为手机端预留）
src/shared/             跨进程契约：通道名 / zod schema / 类型
src/data/               内容资产（台词、人格卡、模板，S1 起）
resources/              图标与托盘图
docs/ROADMAP.md         产品路线
docs/ARCHITECTURE.md    技术架构
docs/STRIP-LOG.md       剥离记录
docs/legal/             隐私政策 / 用户协议 / 免责声明 / 第三方许可
```

技术栈：electron-vite 4 · Vite 7 · TypeScript 5.9 · React 19 · zod 4 · Vitest 3。

工程约定、坑位与代码地图见 **`AGENTS.md`**。

## 与 fortune-ball 的关系

`fortune-ball`（今日运势桌宠）已冻结在 v1.3.0，本项目从它复制了陪伴壳（窗口、托盘、
点击穿透、构建流水线），并**移除了全部运势 / 黄历 / 卡片 / 精灵领域代码**。

- 来源：`https://github.com/CQL111/desktop-icon`（tag `v1.3.0`）
- 本仓库是独立 git 历史，不与 fortune-ball 共享代码包
- 如需修改壳层，只改本项目这一份

## License

MIT
