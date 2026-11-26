// node.ts - 自建服务器运行时（Node 22.5+，零第三方依赖）
//
// ⚠️ 不能直接用 `node src/node.ts`：ESM 下相对 import 需要扩展名，
// 且要引用 workspace 里的 @companion/contracts 源码。用打包后的产物运行：
//   npm run build   → dist/node.mjs
//   node --experimental-sqlite dist/node.mjs
// （Node 24+ 不需要 --experimental-sqlite）
//
// 环境变量：
//   PORT / DB_PATH / DOWNLOAD_BASE_URL / BOTTLE_TTL_DAYS / MAX_PICKS
//   DAILY_BOTTLE_LIMIT / DAILY_REPLY_LIMIT / PICK_PER_HOUR / INBOX_PER_HOUR
//   REPORT_PER_DAY / IP_RATE_LIMIT_PER_MIN / EMERGENCY_OFF / TRUST_PROXY
//
// TRUST_PROXY=1：信任反代（Caddy/Nginx）写入的 X-Real-IP / CF-Connecting-IP。
//                不设时只认 socket 地址，客户端伪造的头一律无效。

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sqliteAdapter, type RateCounter, type SqliteDatabase } from './db'
import { handleRequest, type ServerConfig } from './handler'
import { migrate } from './migrate'
import { createStaticServer } from './static'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 包根：源码运行时是 packages/server，打包后是 dist/ 的上一级 */
const PKG_ROOT = resolve(HERE, '..')

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase
}

async function loadSqlite(): Promise<SqliteModule> {
  return (await import('node:sqlite')) as SqliteModule
}

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const MAX_BODY = 64 * 1024

/** 把 Node 原生请求读成标准 Request；超过 64KB 直接拒绝 */
async function toWebRequest(req: IncomingMessage): Promise<Request | { tooLarge: true }> {
  const method = req.method || 'GET'
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x))
    else if (v !== undefined) headers.set(k, v)
  }

  // GET/HEAD 不需要 body：直接丢弃，避免被大 body 拖住
  if (method === 'GET' || method === 'HEAD') {
    req.resume()
    return new Request(`http://${req.headers.host || 'localhost'}${req.url || '/'}`, { method, headers })
  }

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY) {
      req.destroy()
      return { tooLarge: true }
    }
    chunks.push(buf)
  }

  const body = chunks.length ? Buffer.concat(chunks) : undefined
  return new Request(`http://${req.headers.host || 'localhost'}${req.url || '/'}`, { method, headers, body })
}

async function writeWebResponse(res: ServerResponse, web: Response): Promise<void> {
  res.statusCode = web.status
  web.headers.forEach((value, key) => res.setHeader(key, value))
  if (!web.body) {
    res.end()
    return
  }
  const buf = Buffer.from(await web.arrayBuffer())
  res.setHeader('content-length', String(buf.length))
  res.end(buf)
}

/** 限流计数：单表 upsert；过期行按分钟节流清理 */
function sqliteRateCounter(db: ReturnType<typeof sqliteAdapter>): RateCounter {
  let lastSweep = 0
  return {
    async incr(key, ttlSeconds) {
      const now = Date.now()
      if (now - lastSweep > 60000) {
        lastSweep = now
        await db.prepare('DELETE FROM rate_counters WHERE expires_at < ?').bind(now).run()
      }
      await db
        .prepare(
          `INSERT INTO rate_counters (key, count, expires_at) VALUES (?, 1, ?)
           ON CONFLICT(key) DO UPDATE SET count = count + 1`,
        )
        .bind(key, now + ttlSeconds * 1000)
        .run()
      const row = await db.prepare('SELECT count FROM rate_counters WHERE key = ?').bind(key).first<{ count: number }>()
      return row?.count ?? 1
    },
  }
}

export async function startServer(): Promise<{ close(): Promise<void>; port: number }> {
  const port = envNum('PORT', 8787)
  const dbPath = resolve(PKG_ROOT, process.env.DB_PATH || 'data/companion.db')
  mkdirSync(dirname(dbPath), { recursive: true })

  const sqlite = await loadSqlite()

  // 迁移：有序执行 migrations/*.sql。建表必须成功——否则服务「看起来在跑」但所有接口 500
  const migrationsDir = join(PKG_ROOT, 'migrations')
  if (!existsSync(migrationsDir)) {
    throw new Error(`找不到迁移目录：${migrationsDir}`)
  }
  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ version: f, sql: readFileSync(join(migrationsDir, f), 'utf8') }))

  // 先开一个原始连接跑迁移（也顺便建 WAL）
  const bootstrap = new sqlite.DatabaseSync(dbPath)
  try {
    bootstrap.exec('PRAGMA journal_mode=WAL;')
    bootstrap.exec(
      `CREATE TABLE IF NOT EXISTS rate_counters (
         key        TEXT PRIMARY KEY,
         count      INTEGER NOT NULL,
         expires_at INTEGER NOT NULL
       );`,
    )
  } finally {
    bootstrap.close()
  }

  const db = sqliteAdapter(dbPath, (p) => new sqlite.DatabaseSync(p))
  const result = await migrate(db, migrations)
  if (result.applied.length) console.log(`[server] migrations applied: ${result.applied.join(', ')}`)

  const cfg: ServerConfig = {
    db,
    rate: sqliteRateCounter(db),
    downloadBaseUrl: process.env.DOWNLOAD_BASE_URL || '',
    trustProxy: process.env.TRUST_PROXY === '1',
    siteOrigin: process.env.SITE_ORIGIN || '',
    siteUrl: process.env.SITE_URL || '',
    intraTest: process.env.INTRA_TEST === '1',
    totpMasterKey: process.env.TOTP_MASTER_KEY || '',
    newsIngestToken: process.env.NEWS_INGEST_TOKEN || '',
    assets: existsSync(join(PKG_ROOT, 'public')) ? createStaticServer(join(PKG_ROOT, 'public')) : undefined,
    limits: {
      bottleTtlDays: envNum('BOTTLE_TTL_DAYS', 7),
      maxPicks: envNum('MAX_PICKS', 3),
      dailyBottleLimit: envNum('DAILY_BOTTLE_LIMIT', 3),
      dailyReplyLimit: envNum('DAILY_REPLY_LIMIT', 10),
      pickPerHour: envNum('PICK_PER_HOUR', 10),
      inboxPerHour: envNum('INBOX_PER_HOUR', 20),
      reportPerDay: envNum('REPORT_PER_DAY', 20),
      ipPerMinute: envNum('IP_RATE_LIMIT_PER_MIN', 30),
      emergencyOff: process.env.EMERGENCY_OFF === '1',
    },
  }

  const server = createServer(async (req, res) => {
    try {
      const web = await toWebRequest(req)
      if ('tooLarge' in web) {
        res.statusCode = 413
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: 'PAYLOAD_TOO_LARGE' }))
        return
      }
      // socket 地址是唯一可信来源（trustProxy 时才改用反代头）
      const socketIp = req.socket?.remoteAddress || undefined
      const out = await handleRequest(web, { ...cfg, socketIp })
      await writeWebResponse(res, out)
    } catch (e) {
      // 内部错误必须留痕，否则线上 500 无从排查
      console.error('[server] request failed', req.method, req.url, (e as Error)?.message)
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: 'INTERNAL' }))
    }
  })

  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(port, '0.0.0.0', () => {
      server.off('error', fail)
      done()
    })
  })
  console.log(`[server] listening on :${port}  db=${dbPath}  trustProxy=${cfg.trustProxy}`)

  return {
    port,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          db.close?.()
          done()
        })
      }),
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  startServer().catch((e) => {
    console.error('[server] 启动失败:', e?.message || e)
    process.exit(1)
  })
}
