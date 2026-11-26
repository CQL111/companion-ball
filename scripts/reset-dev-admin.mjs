// scripts/reset-dev-admin.mjs - 只重建本地开发的管理员账号
//
// 和 db:reset 的区别：**不动其他数据**（瓶子、新闻、橱窗都还在），只换一个新的
// 管理员账号并打印新的 API Key 与 TOTP 密钥。
//
// 什么时候用：
//   - 忘了 API Key / TOTP 密钥
//   - 改了 TOTP_MASTER_KEY，导致旧管理员解不开
//
// 用法：npm run dev:reset-admin

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'packages', 'server')
const DB_PATH = join(SERVER, 'data', 'dev.db')

function readEnv() {
  const file = join(ROOT, '.env')
  const out = {}
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return out
}

const masterKey = process.env.TOTP_MASTER_KEY || readEnv().TOTP_MASTER_KEY
if (!masterKey) {
  console.error('❌ 缺少 TOTP_MASTER_KEY（在仓库根目录 .env 里配置）')
  process.exit(1)
}

if (!existsSync(DB_PATH)) {
  console.log('本地开发库还不存在——直接 npm run dev:platform，它会自动建库并创建管理员。')
  process.exit(0)
}

// 删掉现有管理员（保留瓶子、新闻等数据）
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode=WAL;')
const before = db.prepare('SELECT COUNT(*) AS n FROM admin_users').get()
db.prepare('DELETE FROM admin_users').run()
db.prepare('DELETE FROM admin_sessions').run()
db.close()
console.log(`已移除 ${Number(before?.n ?? 0)} 个旧管理员（其他数据保留）\n`)

// 复用 bootstrap 脚本创建新管理员
execFileSync(process.execPath, ['--experimental-sqlite', 'scripts/bootstrap-admin.mjs', 'admin'], {
  cwd: SERVER,
  stdio: 'inherit',
  env: { ...process.env, TOTP_MASTER_KEY: masterKey, DB_PATH },
})
