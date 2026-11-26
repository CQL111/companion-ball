// scripts/dev-platform.mjs - 本地一键启动：server + 前台 + 后台
//
// 用法：
//   npm run dev:platform              # 起服务（含前台与后台静态）
//   npm run dev:platform -- --watch   # 前台/后台改文件自动重新构建
//
// 为什么不是一个命令起三个进程：
//   同源部署下前台与后台是**静态资源**，由服务端一起提供（boringtime.cn 单 Worker 的本地版）。
//   所以本地只需要一个服务：改页面 → 构建 → 刷新浏览器；改服务端 → 重启。
//
// 端口：8080（可用 PORT 覆盖）
// 数据：packages/server/data/dev.db（不碰 .env 里的生产配置）

import { execSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'packages', 'server')
const PORT = process.env.PORT || '8080'
const watchMode = process.argv.includes('--watch')

/** 读 .env（只读需要的键，不打印任何值） */
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

function run(cmd, cwd = ROOT, extraEnv = {}) {
  execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, ...extraEnv } })
}

const fileEnv = readEnv()
const masterKey = process.env.TOTP_MASTER_KEY || fileEnv.TOTP_MASTER_KEY

if (!masterKey) {
  console.error('')
  console.error('❌ 缺少 TOTP_MASTER_KEY（后台登录需要）')
  console.error('')
  console.error('   在仓库根目录的 .env 里加一行：')
  console.error('   TOTP_MASTER_KEY=' + randomBytes(32).toString('base64'))
  console.error('')
  console.error('   或者临时跑一次：')
  console.error('   TOTP_MASTER_KEY=$(node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))") npm run dev:platform')
  console.error('')
  process.exit(1)
}

const dataDir = join(SERVER, 'data')
mkdirSync(dataDir, { recursive: true })
const dbPath = join(dataDir, 'dev.db')

// ---------- 1. 构建前台与后台（它们只是静态资源）----------
console.log('\n▸ 构建前台与后台…')
run('npm run build -w @companion/web')
run('npm run build -w @companion/admin')

// ---------- 2. 构建服务端 ----------
console.log('\n▸ 构建服务端…')
run('npm run build -w @companion/server')

// ---------- 3. 是否有管理员？没有就创建一个 ----------
const hasAdmin = await (async () => {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    if (!existsSync(dbPath)) return false
    const db = new DatabaseSync(dbPath)
    const row = db.prepare('SELECT COUNT(*) AS n FROM admin_users').get()
    db.close()
    return Number(row?.n ?? 0) > 0
  } catch {
    return false
  }
})()

if (!hasAdmin) {
  console.log('\n▸ 还没有管理员，创建一个（只显示一次）…')
  run(`node --experimental-sqlite scripts/bootstrap-admin.mjs admin`, SERVER, {
    TOTP_MASTER_KEY: masterKey,
    DB_PATH: dbPath,
  })
}

// ---------- 4. 起服务 ----------
const serverEnv = {
  ...process.env,
  PORT,
  DB_PATH: dbPath,
  SITE_ORIGIN: `http://127.0.0.1:${PORT}`,
  TOTP_MASTER_KEY: masterKey,
  NEWS_INGEST_TOKEN: process.env.NEWS_INGEST_TOKEN || fileEnv.NEWS_INGEST_TOKEN || '',
  TRUST_PROXY: '0',
  DOWNLOAD_BASE_URL: process.env.DOWNLOAD_BASE_URL || fileEnv.DOWNLOAD_BASE_URL || '',
}

console.log('\n▸ 启动服务（前台 + 后台 + API 同一个端口）…')
console.log(`\n     前台  http://127.0.0.1:${PORT}/`)
console.log(`     看海  http://127.0.0.1:${PORT}/gallery`)
console.log(`     后台  http://127.0.0.1:${PORT}/admin`)
console.log(`     健康  http://127.0.0.1:${PORT}/v1/health`)
console.log(`\n     数据库 ${dbPath}`)
console.log('     Ctrl+C 停止\n')

const child = spawn(process.execPath, ['--experimental-sqlite', join(SERVER, 'dist', 'node.mjs')], {
  cwd: SERVER,
  env: serverEnv,
  stdio: 'inherit',
})

// ---------- 5.（可选）监听页面变更自动重建 ----------
if (watchMode) {
  let timer = null
  const rebuild = (label, cmd) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      console.log(`\n▸ ${label} 变更，重新构建…`)
      try {
        run(cmd)
        console.log('▸ 已更新，刷新浏览器即可')
      } catch {
        console.error('▸ 构建失败，请看上面的错误')
      }
    }, 350)
  }
  watch(join(ROOT, 'packages', 'web', 'public'), { recursive: true }, () => rebuild('前台', 'npm run build -w @companion/web'))
  watch(join(ROOT, 'packages', 'admin', 'src'), { recursive: true }, () => rebuild('后台', 'npm run build -w @companion/admin'))
  console.log('▸ 已开启监听（前台 public/ 与后台 src/）\n')
}

child.on('exit', (code) => {
  process.exit(code ?? 0)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child.kill()
    process.exit(0)
  })
}
