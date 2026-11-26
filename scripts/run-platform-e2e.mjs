// scripts/run-platform-e2e.mjs - 平台端到端（自动准备构建与临时密钥）
//
// 用法：node scripts/run-platform-e2e.mjs
// 环境变量：TOTP_MASTER_KEY 可选（不设时随机生成一次供本次测试用）

import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const env = {
  ...process.env,
  TOTP_MASTER_KEY: process.env.TOTP_MASTER_KEY || randomBytes(32).toString('base64'),
}

console.log('→ 构建前台 / 后台 / 服务端…')
execSync('npm run build:platform', { cwd: ROOT, stdio: 'inherit', env })

console.log('\n→ 运行平台端到端…')
execSync('node tests/e2e/platform.mjs', {
  cwd: resolve(ROOT, 'packages', 'server'),
  stdio: 'inherit',
  env,
})
