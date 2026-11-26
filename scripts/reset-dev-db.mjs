// scripts/reset-dev-db.mjs - 重置本地开发数据库
//
// 只删 packages/server/data/dev.db（本地开发数据），**不碰** DB_PATH 指向的库。
// 删完下次 `npm run dev:platform` 会自动重建并创建管理员。

import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'packages', 'server', 'data')

if (process.env.DB_PATH) {
  console.error('❌ 检测到 DB_PATH 环境变量指向别处：' + process.env.DB_PATH)
  console.error('   为避免误删，本脚本只处理默认的本地开发库。请手动删除。')
  process.exit(1)
}

if (!existsSync(DATA)) {
  console.log('本地开发库不存在，无需重置。')
  process.exit(0)
}

function tryRemove(file) {
  const p = join(DATA, file)
  if (!existsSync(p)) return true
  try {
    rmSync(p, { force: true })
    console.log('已删除 ' + file)
    return true
  } catch (e) {
    if (String(e?.code).includes('EBUSY') || String(e?.message).includes('busy')) {
      console.error(`\n❌ ${file} 正被占用。`)
      console.error('   先停掉正在运行的 npm run dev:platform（Ctrl+C），再重置。\n')
      process.exit(1)
    }
    throw e
  }
}

// 先删 -wal / -shm，再删主库
for (const f of ['dev.db-wal', 'dev.db-shm', 'dev.db']) {
  tryRemove(f)
}

console.log('\n下次 npm run dev:platform 会自动重建并创建管理员。')
