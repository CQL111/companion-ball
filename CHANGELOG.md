# Changelog

## [0.1.0] — S0：从 fortune-ball 剥离（2026-11-19）

### 新增
- 独立项目 `companion-ball`：桌面陪伴 · 团子猫
- 陪伴壳：全屏透明窗口、点击穿透、拖拽、位置记忆、托盘、开机自启、单实例、DPI 处理
- AI 多轮对话骨架（DeepSeek / 本机 Ollama），S0 无工具调用
- 首次启动协议同意 + 法律文档（隐私 / 用户协议 / 免责 / 第三方）
- 双版本构建（公开版 `companion-ball-public.Setup.*`、内置 Key 版 `companion-ball.Setup.*`）
- GitHub Pages 产品页（`product-intro.html` → `docs/index.html`）

### 变更
- appId / userData / productName / 仓库名全部与 fortune-ball 隔离
- 法律文档与同意页文案改写为陪伴产品口径

### 移除
- 运势 / 黄历 / 农历 / 节气 / 典籍引擎
- 运势卡片（5 风格）、运势精灵、连续天数、行为偏好
- 签文 / 塔罗 / 宜忌 / 吉言 / 时辰提点等数据

### 验证
- `node smoke-test.js` → 21 通过
- 本地启动：协议页 → 主界面，托盘菜单、拖拽、位置持久化、设置面板正常
