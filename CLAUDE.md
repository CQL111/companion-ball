# CLAUDE.md

本项目的完整工程说明见 **[AGENTS.md](./AGENTS.md)**。

## 项目速览

- **产品**：桌面陪伴 · 团子猫（companion-ball）— Windows 桌面 AI 陪伴角色
- **定位**：不是助手，是住你桌面上的一个小家伙（在场感 / 记忆 / 仪式 / 猫的笔记本）
- **当前阶段**：S0 已完成并清理；S1「它有自己的生活」待开发
- **版本**：0.1.0
- **来源**：从 `fortune-ball`（`C:\personal\claude`，tag v1.3.0）剥离，独立 git 历史

## 硬约束

- **每一次变更都必须同时具备：文档记录（CHANGELOG）+ 功能测试 + tag + GitHub Release**；
  流程与门禁见 `docs/RELEASING.md`，`npm run release:*` 会自动检查
- **不引入任何运势 / 黄历 / 卡片 / 精灵代码**（它们属于 fortune-ball）
- 不建 monorepo；壳层只在本仓库维护，不复用 fortune-ball 的代码包
- appId 固定为 `com.companion.ball`，与 fortune-ball 的 `com.fortune.ball` 互不干扰
- **技术栈**：electron-vite 4 + TypeScript + React 19 + zod + Vitest；宠物窗口保持命令式 TS
- **硬约束**：`src/core/` 零平台依赖（`npm run check:core` 守护）；新增 IPC 五处同步
  （`shared/channels.ts` / `shared/ipc.ts` / `main/ipc.ts` / `shared/types.ts` / `preload/index.ts`）
- **不读窗口标题、不上传用户数据**；新增出网调用必须用户知情并写进隐私政策

## 文档索引

| 文档 | 用途 |
|---|---|
| `AGENTS.md` | 工程速查：宪法、命令、坑位、代码地图（先读这个） |
| `docs/ROADMAP.md` | 产品定位、S1–S7 里程碑、猫的笔记本、信封收费设计 |
| `docs/ARCHITECTURE.md` | 技术架构：分层、进程模型、数据流、IPC、存储、安全、手机端 |
| `docs/RELEASING.md` | 变更纪律：文档 + 功能测试 + tag + Release |
| `docs/SKIN-AUTHORING.md` | 皮肤与图标制作：AI 生图 prompt + 图集打包 + 验收 |
| `docs/STRIP-LOG.md` | 从 fortune-ball 的剥离清单（追溯用） |
| `README.md` | 项目说明与构建方式 |
| `docs/legal/` | 隐私政策、用户协议、免责声明、第三方许可 |
| `electron-builder*.yml` | 公开版 / 个人版构建配置 |
