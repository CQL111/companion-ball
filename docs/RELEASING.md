# 发版流程（变更纪律）

> **硬规则：每一次变更都必须同时具备——文档记录、功能测试、tag、GitHub Release。**
> 缺任何一项，这次提交就不算完成。

## 一、一次变更的完成定义（DoD）

| # | 要求 | 怎么验证 |
|---|---|---|
| 1 | **文档记录** | `CHANGELOG.md` 有对应版本的条目，按「新增 / 变更 / 修复 / 移除 / 验证」分组 |
| 2 | **功能测试** | `npm run test:e2e` 通过（真实启动应用）；core 逻辑另有 Vitest |
| 3 | **tag** | `vX.Y.Z` 注解 tag，指向发布提交 |
| 4 | **Release** | GitHub Release 带安装包资产与 CHANGELOG notes |

**粒度**：一个可交付版本 = 一个 tag + 一个 Release。不建议每个 commit 都发版
（安装包构建 2–5 分钟、Release 列表会被噪音淹没）。若确实需要更细粒度，可只打 tag 不发布资产。

## 二、标准流程

```bash
# 1. 写代码 + 写 CHANGELOG（在同一批提交里）
vim src/...
vim CHANGELOG.md          # 在顶部新增 "## [X.Y.Z] — 标题（日期）" 与分组条目

# 2. 本地自测
npm test                  # Vitest + core 边界
npm run typecheck
npm run build
npm run test:e2e          # 真实启动应用的功能测试
# 或者一步到位：
npm run test:all

# 3. 提交（工作区必须干净，release 会检查）
git add -A && git commit -m "feat: ..."

# 4. 发版：自动升版本 → 门禁 → tag → 推送 → 构建公开版 → 发布
npm run release:minor     # 或 release:patch / release:major
```

`scripts/release.js` 的门禁顺序（任何一项失败都中止，不会推送）：

```
工作区干净 → tag 不存在 → CHANGELOG 有该版本条目且非空
  → npm test → npm run typecheck → npm run build → node tests/e2e/smoke.mjs
  → git commit + git tag -a vX.Y.Z → git push --follow-tags
  → electron-builder 公开版（--publish always）
  → Release notes 取自 CHANGELOG
```

### 安全边界：内置 Key 版永不发布

`electron-builder.key.yml` 会把 `.env` 里的真实 Key 打进安装包。一旦上传到公开的 GitHub
Release，任何人解包就能取出 Key 并消耗你的额度。因此：

- `release.js` **只发布公开版**；即使存在 `bundled-ai.json` 也明确跳过内置 Key 版
- 需要个人版安装包时在本机执行 `npm run build:key`，产物只在 `out-release-key/`，
  自己安装或私下分发，**不要上传到任何公开位置**
- 如果曾经误传过，立即轮换 Key（`.env` 与设置面板同时更新）

## 三、版本号规则

| 类型 | 何时用 |
|---|---|
| `patch`（0.2.x） | 修 bug、文案、样式、内部重构，不改行为契约 |
| `minor`（0.x.0） | 新功能（S1 状态机、S2 记忆…）、架构迁移 |
| `major`（1.x） | 对外承诺变更（S6 猫邮局开门） |

S 阶段与版本对应关系见 `docs/ROADMAP.md` 第二节。

## 四、功能测试覆盖什么

`tests/e2e/smoke.mjs`（无第三方依赖，Node 22 自带 fetch / WebSocket）：

1. 以隔离 `--user-data-dir` 启动打包前的应用（不会碰用户配置）
2. 团子猫窗口：渲染、菜单入口、位置 transform
3. 从宠物窗口打开设置面板与对话浮窗，验证 React 渲染
4. 有 `DEEPSEEK_API_KEY` 时发一条真实消息，断言助手回复渲染
5. 主进程日志不得出现 error / critical / 意外 warn
6. 结束后按 PID 精确结束它启动的进程并清理临时目录

新增窗口或新增关键交互时，**同步在 smoke.mjs 里加断言**，否则新功能没有功能测试。

## 五、发布前人工检查（无法自动化的部分）

- [ ] 托盘菜单、拖拽、点击穿透（需要真实鼠标）
- [ ] 设置面板保存 Key / 测试连接
- [ ] 安装包能安装、能启动（`npm run build:public` 后手动跑一次）
- [ ] 隐私政策 / 用户协议有改动时：`AGREEMENT_VERSION` 已 +1、`npm run build:legal` 已执行

## 六、发布失败怎么办

| 情况 | 处理 |
|---|---|
| 门禁失败（测试/类型/CHANGELOG） | 修复后重新提交，再跑 `npm run release:*` |
| 已推送 tag 但构建失败 | 修复后：`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`，重新发版 |
| Release 资产缺失 | 重新执行 `electron-builder --publish always --config <yml>`（同一 tag 会追加到已有 Release） |
| 已经发布但发现严重 bug | **不发补丁版覆盖**：升 patch 版本重新发布，旧版本保留可追溯 |
