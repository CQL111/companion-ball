// scripts/build-e2e.mjs - 带调试入口的构建（仅供 e2e 使用）
//
// 为什么单独一个脚本：`COMPANION_E2E=1 npm run build` 在 Windows 的 cmd 下不生效
// （那是 POSIX 语法）。这里用 Node 设置环境变量，跨平台可靠。
//
// 产物与正式版**不可混用**：这个构建带有 window.debugSpeak 等后门，只能用于测试。
import { spawnSync } from 'node:child_process'

const result = spawnSync('npx', ['electron-vite', 'build'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, COMPANION_E2E: '1' },
})

process.exit(result.status ?? 1)
