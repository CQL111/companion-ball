// scripts/bootstrap-admin.mjs - 创建第一个管理员（一次性 CLI）
//
// 用法：
//   node scripts/bootstrap-admin.mjs <username>
//   node --experimental-sqlite scripts/bootstrap-admin.mjs admin
//
// 为什么需要 CLI：后台是邀请制、无公开注册。没有第一个账号，就没人能登进去创建第二个。
// 输出只展示一次：API Key 与 TOTP 密钥。请立刻存好。

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const MASTER = process.env.TOTP_MASTER_KEY || ''
if (!MASTER) {
  console.error('❌ 需要环境变量 TOTP_MASTER_KEY（32 字节的 base64）')
  console.error('   生成：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"')
  process.exit(1)
}

const username = process.argv[2]
if (!username) {
  console.error('用法：node scripts/bootstrap-admin.mjs <username>')
  process.exit(1)
}

// bootstrap 只跑一次，直接在此实现最小写入（不值得为它导出内部模块）
const { webcrypto } = await import('node:crypto')
const cryptoApi = globalThis.crypto ?? webcrypto

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}
async function sha256(s) {
  const d = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return hex(new Uint8Array(d))
}
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function base32(bytes) {
  let out = '', bits = 0, value = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}
function b64ToBytes(b64) {
  const bin = Buffer.from(b64, 'base64')
  return new Uint8Array(bin)
}
async function seal(plain, masterB64) {
  const material = b64ToBytes(masterB64)
  const key = await cryptoApi.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = cryptoApi.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)))
  const all = new Uint8Array(iv.length + ct.length)
  all.set(iv)
  all.set(ct, 12)
  return Buffer.from(all).toString('base64')
}

const dbPath = resolve(PKG, process.env.DB_PATH || 'data/companion.db')
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA journal_mode=WAL;')

// 迁移
const migrationsDir = join(PKG, 'migrations')
for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
  // 已有 schema_migrations 时跳过（迁移文件幂等，重复执行无害）
  const sql = readFileSync(join(migrationsDir, f), 'utf8')
  for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
    try {
      db.exec(stmt)
    } catch (e) {
      if (!String(e.message).includes('duplicate column')) throw e
    }
  }
}

const apiKey = hex(cryptoApi.getRandomValues(new Uint8Array(32)))
const totpSecret = base32(cryptoApi.getRandomValues(new Uint8Array(20)))
const id = hex(cryptoApi.getRandomValues(new Uint8Array(16)))
const keyHash = await sha256('companion-ball:admin-key:' + apiKey)
const sealedTotp = await seal(totpSecret, MASTER)

db.prepare(
  'INSERT INTO admin_users (id, username, key_hash, totp_secret, role, disabled, created_at) VALUES (?,?,?,?,?,0,?)',
).run(id, username, keyHash, sealedTotp, 'admin', Date.now())
db.close()

console.log('\n✅ 管理员已创建（这些只显示这一次）\n')
console.log('  账号：', username)
console.log('  角色：', 'admin')
console.log('  API Key：', apiKey)
console.log('  TOTP 密钥：', totpSecret)
console.log('\n把 TOTP 密钥加进验证器 App（或手输），然后访问 /admin 登录。\n')
