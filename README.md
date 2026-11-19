# 桌面陪伴 · 团子猫（companion-ball）· S0

一只常驻桌角的 AI 团子猫。可以拖、可以放，点一下就能聊天；数据默认只在本机。

> 产品页：<https://cql111.github.io/companion-ball/>

## 当前状态：S0（角色壳 + AI 对话骨架）

这是从 `fortune-ball` 剥离出来的**最小可运行陪伴壳**。剥离清单见
[`docs/ROADMAP.md`](docs/ROADMAP.md)。

| 已有 | 尚未做（按里程碑） |
|---|---|
| 透明全屏窗口、点击穿透、拖拽、位置记忆 | 情绪状态机（S2） |
| 托盘菜单、开机自启、单实例锁、DPI 处理 | 台词库与主动互动（S2） |
| 首次启动协议同意、法律文档、日志自检 | 环境感知 / 久坐提醒（S3） |
| 多轮 AI 对话（DeepSeek / 本机 Ollama） | 角色美术与动画（持续） |
| 双版本构建与 GitHub Release 脚本 | 付费角色 / 皮肤（S4） |

## 开发

```bash
npm install
cp .env.example .env      # 填入 DEEPSEEK_API_KEY（可选）
npm start
node smoke-test.js        # 21 条断言
```

## 构建与发布

```bash
npm run build:legal
npm run build:public      # 公开版（不带 Key）
npm run build:personal    # 内置 Key 版（读 build/bundled-ai.json）
npm run release:patch     # 升版本 → tag → push → 双版本构建并发布
npm run build:site        # product-intro.html → docs/index.html（GitHub Pages）
```

资产命名：

- `companion-ball-public.Setup.X.Y.Z.exe` — 公开版
- `companion-ball.Setup.X.Y.Z.exe` — 内置 Key 版

## 目录

```
main.js                 主进程：窗口 / 托盘 / IPC / 位置 / 日志
preload.js              IPC 白名单
src/js/ball.js          角色渲染与拖拽
src/js/agent.js         AI 对话（多轮；S0 无工具）
src/js/ai.js            LLM 调用封装与连接测试
src/js/settings.js      设置面板
docs/legal/             隐私政策 / 用户协议 / 免责声明 / 第三方许可
```

工程约定、坑位与数据流见 **`AGENTS.md`**。

## 与 fortune-ball 的关系

`fortune-ball`（今日运势桌宠）已冻结在 v1.3.0，本项目从它复制了陪伴壳（窗口、托盘、
点击穿透、构建流水线），并**移除了全部运势 / 黄历 / 卡片 / 精灵领域代码**。

- 来源：`https://github.com/CQL111/desktop-icon`（tag `v1.3.0`）
- 本仓库是独立 git 历史，不与 fortune-ball 共享代码包
- 如需修改壳层，只改本项目这一份

## License

MIT
