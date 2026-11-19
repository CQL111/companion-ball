# CLAUDE.md

本项目的完整工程说明见 **[AGENTS.md](./AGENTS.md)**。

## 项目速览

- **产品**：桌面陪伴 · 团子猫（companion-ball）— Windows 桌面 AI 陪伴角色
- **当前阶段**：S0（角色壳 + AI 对话骨架），见 `docs/ROADMAP.md` 的剥离清单
- **版本**：0.1.0
- **来源**：从 `fortune-ball`（`C:\personal\claude`，tag v1.3.0）剥离，独立 git 历史

## 硬约束

- **不引入任何运势 / 黄历 / 卡片 / 精灵代码**（它们属于 fortune-ball）
- 不建 monorepo；壳层只在本仓库维护，不复用 fortune-ball 的代码包
- appId 固定为 `com.companion.ball`，与 fortune-ball 的 `com.fortune.ball` 互不干扰

## 文档索引

| 文档 | 用途 |
|---|---|
| `AGENTS.md` | 工程全貌（先读这个） |
| `README.md` | 项目说明与构建方式 |
| `docs/ROADMAP.md` | 从 fortune-ball 的剥离清单与后续里程碑 |
| `docs/legal/` | 隐私政策、用户协议、免责声明、第三方许可 |
| `electron-builder*.yml` | 公开版 / 个人版构建配置 |
