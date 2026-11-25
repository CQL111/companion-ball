# CLAUDE.md

本项目的完整工程说明见 **[AGENTS.md](./AGENTS.md)**。

## 项目速览

- **产品**：桌面陪伴 · 团子猫（companion-ball）— Windows 桌面 AI 陪伴角色
- **定位**：不是助手，是住你桌面上的一个小家伙（在场感 / 记忆 / 仪式 / 猫的笔记本）
- **当前阶段**：S0–S2.6、S4、S4.5、P0 已完成；**S3「许愿瓶（联网 MVP）」待收尾**（客户端与服务端
  代码就绪，待部署 Cloudflare、填写默认地址、邀请制冷启动）；下一步 P0.5「不说话的身体」，
  之后私人闭环 P1 缺席日志 → P1.5 事件记忆 → P2 页边一句（产品论点见 `docs/PRODUCT-THESIS.md`）
- **版本**：0.9.0
- **来源**：从 `fortune-ball`（`C:\personal\claude`，tag v1.3.0）剥离，独立 git 历史

## 硬约束

- **每一次变更都必须同时具备：文档记录（CHANGELOG）+ 功能测试 + tag + GitHub Release**；
  流程与门禁见 `docs/RELEASING.md`，`npm run release:*` 会自动检查
- **不引入任何运势 / 黄历 / 卡片 / 精灵代码**（它们属于 fortune-ball）
- **单仓库 monorepo（私有）**：桌面端留在根目录，平台包放 `packages/{contracts,server,web,admin}`；
  不建**跨产品** monorepo，壳层只在本仓库维护，不复用 fortune-ball 的代码包
- appId 固定为 `com.companion.ball`，与 fortune-ball 的 `com.fortune.ball` 互不干扰
- **技术栈**：electron-vite 4 + TypeScript + React 19 + zod + Vitest；宠物窗口保持命令式 TS
- **硬约束**：`src/core/` 零平台依赖（`npm run check:core` 守护）；新增 IPC 五处同步
  （`shared/channels.ts` / `shared/ipc.ts` / `main/ipc.ts` / `shared/types.ts` / `preload/index.ts`）
- **不读窗口标题、不上传用户数据**；新增出网调用必须用户知情并写进隐私政策

## 文档索引

| 文档 | 用途 |
|---|---|
| `AGENTS.md` | 工程速查：宪法、命令、坑位、代码地图（先读这个） |
| `docs/ROADMAP.md` | 产品定位、S1–S8 里程碑、闸门、猫的笔记本、信封收费设计 |
| `docs/PRODUCT-THESIS.md` | 产品论点：Mochi 镜鉴、第四根支柱「期待」、语言资产、M1–M6、投资逻辑 |
| `docs/OCCASIONS.md` | P1.5 事件记忆：随口说一句 → 记住 → 接住（数据模型、规则、验收） |
| `docs/PLATFORM.md` | 平台架构：网页橱窗 / 新闻 / 管理后台 / monorepo / 资源评估 |
| `docs/PLATFORM-S0.md` | 平台 S0 执行清单：workspaces、契约收敛、server 迁入、守卫适配、发布渠道、CI |
| `docs/REPO-LAYOUT.md` | 仓库设计图：目录结构、依赖方向、守卫、命令 |
| `docs/ARCHITECTURE.md` | 技术架构：分层、进程模型、数据流、IPC、存储、安全、手机端 |
| `docs/RELEASING.md` | 变更纪律：文档 + 功能测试 + tag + Release |
| `docs/SERVER.md` | 许愿瓶服务端：接口、数据模型、风险与地区策略 |
| `docs/TESTING-BOTTLE.md` | 本地测试许愿瓶（mock 服务端 + 调试命令） |
| `docs/SKIN-AUTHORING.md` | 皮肤与图标制作：AI 生图 prompt + 图集打包 + 验收 |
| `docs/STRIP-LOG.md` | 从 fortune-ball 的剥离清单（追溯用） |
| `README.md` | 项目说明与构建方式 |
| `docs/legal/` | 隐私政策、用户协议、免责声明、第三方许可 |
| `electron-builder*.yml` | 公开版 / 个人版构建配置 |
