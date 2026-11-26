// tests/e2e/platform.mjs - 平台端到端验证（真实起服务 + 真实 HTTP）
//
// 证明三件事能一起跑：前台页面 / 管理后台 / 服务端 API，同源一个端口。
//
// 用法：
//   npm run build -w @companion/server
//   npm run build -w @companion/web && npm run build -w @companion/admin
//   TOTP_MASTER_KEY=... node tests/e2e/platform.mjs
//
// 脚本会自己建一个临时库与临时管理员，不碰你的开发数据。

import { spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..', '..')
const TMP = mkdtempSync(join(os.tmpdir(), 'cb-platform-'))
const DB_PATH = join(TMP, 'test.db')
const PORT = 8899
const BASE = `http://127.0.0.1:${PORT}`
const MASTER = (process.env.TOTP_MASTER_KEY || '').trim()

const results = []
const check = (n, ok, d = '') => {
  results.push({ n, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`)
}

// ---------- 测试用的 TOTP（与服务端同算法）----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function b32decode(s) {
  const out = []
  let bits = 0
  let val = 0
  for (const ch of s.toUpperCase()) {
    const i = B32.indexOf(ch)
    if (i < 0) continue
    val = (val << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}
function base32(bytes) {
  let out = ''
  let bits = 0
  let val = 0
  for (const b of bytes) {
    val = (val << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31]
  return out
}
function totpNow(secret) {
  const counter = Math.floor(Date.now() / 1000 / 30)
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const h = createHmac('sha1', b32decode(secret)).update(buf).digest()
  const off = h[h.length - 1] & 0x0f
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(code % 1e6).padStart(6, '0')
}

// ---------- 建库 + 建管理员（直接写库，不跑 CLI）----------
async function seed() {
  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode=WAL;')
  for (const f of readdirSync(join(PKG, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(PKG, 'migrations', f), 'utf8')
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      try {
        db.exec(stmt)
      } catch (e) {
        const m = String(e.message).toLowerCase()
        if (!m.includes('duplicate column') && !m.includes('already exists')) throw e
      }
    }
  }

  const apiKey = randomBytes(32).toString('hex')
  const totpSecret = base32(randomBytes(20))
  const keyHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('companion-ball:admin-key:' + apiKey))).toString('hex')

  // AES-GCM 封 TOTP 密钥（与服务端一致）
  const masterBytes = Buffer.from(MASTER, 'base64')
  const material = masterBytes.length === 32 ? masterBytes : Buffer.from(await crypto.subtle.digest('SHA-256', masterBytes))
  const key = await crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(totpSecret)))
  const all = new Uint8Array(iv.length + ct.length)
  all.set(iv)
  all.set(ct, 12)

  db.prepare('INSERT INTO admin_users (id, username, key_hash, totp_secret, role, disabled, created_at) VALUES (?,?,?,?,?,0,?)').run(
    randomBytes(16).toString('hex'),
    'e2e',
    keyHash,
    Buffer.from(all).toString('base64'),
    'admin',
    Date.now(),
  )
  db.close()
  return { apiKey, totpSecret }
}

let child
try {
  if (!MASTER) {
    console.error('❌ 需要 TOTP_MASTER_KEY（32 字节 base64）')
    process.exit(1)
  }
  const { apiKey, totpSecret } = await seed()

  child = spawn(process.execPath, ['--experimental-sqlite', 'dist/node.mjs'], {
    cwd: PKG,
    env: { ...process.env, PORT: String(PORT), DB_PATH, SITE_ORIGIN: BASE, TRUST_PROXY: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (d) => (logs += d))
  child.stderr.on('data', (d) => (logs += d))

  let up = false
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + '/v1/health')
      if (r.ok) {
        up = true
        break
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  check('服务启动', up, up ? '' : logs.slice(0, 300))
  if (!up) throw new Error('server not up')

  // ---- 前台页面 ----
  for (const [p, kw] of [
    ['/', '团子猫'],
    ['/gallery', '此刻的海'],
    ['/download', '下载一只猫'],
    ['/privacy', '隐私'],
    ['/terms', '用户协议'],
  ]) {
    const r = await fetch(BASE + p)
    const t = await r.text()
    check(`页面 ${p}`, r.ok && t.includes(kw), `HTTP ${r.status}`)
  }

  // ---- 管理后台 SPA ----
  const adminRes = await fetch(BASE + '/admin')
  const adminHtml = await adminRes.text()
  check('后台 SPA /admin', adminRes.ok && adminHtml.includes('root'), `HTTP ${adminRes.status}`)
  const assetPath = /src="(\/admin\/assets\/[^"]+)"/.exec(adminHtml)?.[1]
  if (assetPath) {
    const a = await fetch(BASE + assetPath)
    check('后台 JS 资源可加载', a.ok, `HTTP ${a.status}`)
  }

  // ---- 登录 ----
  const loginRes = await fetch(BASE + '/admin/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ username: 'e2e', apiKey, totp: totpNow(totpSecret) }),
  })
  const loginJson = await loginRes.json()
  check('后台登录成功', loginRes.ok && loginJson.ok === true, JSON.stringify(loginJson))
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  check('下发 __Host- Cookie', cookie.startsWith('__Host-sid='), cookie.slice(0, 20))

  // ---- 概览 ----
  const ovRes = await fetch(BASE + '/admin/api/overview', { headers: { Cookie: cookie } })
  const ov = await ovRes.json()
  check('概览可用', ovRes.ok && ov.ok === true, JSON.stringify(ov.ratios ?? ov.error))

  // ---- 投递 → 待审 → 批准 → 前台可见 ----
  const H = { 'X-Device-Token': 'e2e-device-token-0123456789', 'Content-Type': 'application/json' }
  const throwRes = await fetch(BASE + '/v1/bottle', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ body: '今天风很大，我想起小时候的窗台。', requestPublic: true, utcOffsetMinutes: 480 }),
  })
  check('投递并请求公开', throwRes.ok)

  const modRes = await fetch(BASE + '/admin/api/moderation?status=pending', { headers: { Cookie: cookie } })
  const mod = await modRes.json()
  check('出现在待审队列', mod.items?.length === 1, `${mod.items?.length ?? 0} 条`)
  const gid = mod.items?.[0]?.id

  const approveRes = await fetch(BASE + `/admin/api/moderation/${gid}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'approve', note: 'ok' }),
  })
  check('批准上橱窗', approveRes.ok)

  const gDay = await (await fetch(BASE + '/v1/gallery?pool=day')).json()
  const gNight = await (await fetch(BASE + '/v1/gallery?pool=night')).json()
  const allItems = [...(gDay.items ?? []), ...(gNight.items ?? [])]
  check('前台橱窗可见', allItems.some((x) => x.body.includes('窗台')), `${allItems.length} 条`)
  check('橱窗不暴露 seed 字段', allItems.every((x) => !('seed' in x)))
  check('橱窗不暴露 sourceBottle', allItems.every((x) => !('sourceBottle' in x)))

  // ---- 新闻：草稿 → 发布 → SSR 页面 → 桌面端取一条 ----
  const newsRes = await fetch(BASE + '/admin/api/news', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '今天下了很久的雨',
      summary: '我把尾巴收起来了。',
      body: '雨从早上开始下，一直没有停。我趴在窗边看了一会儿。',
      category: 'rain',
      sourceName: '海边',
    }),
  })
  const newsJson = await newsRes.json()
  check('建立新闻草稿', newsRes.ok && newsJson.ok === true, JSON.stringify(newsJson))

  const pubRes = await fetch(BASE + `/admin/api/news/${newsJson.id}/publish`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  })
  check('发布新闻', pubRes.ok)

  const listHtml = await (await fetch(BASE + '/news')).text()
  check('新闻列表页（服务端渲染）', listHtml.includes('今天下了很久的雨'))
  const detailHtml = await (await fetch(BASE + `/news/${newsJson.id}`)).text()
  check('新闻详情页有正文（SEO）', detailHtml.includes('雨从早上开始下'))
  check('详情页有 OG 标签', detailHtml.includes('og:title'))

  const newsJsonRes = await (await fetch(BASE + '/v1/news')).json()
  check('新闻 JSON 不含 sourceUrl', newsJsonRes.items?.every((x) => !('sourceUrl' in x)))

  const pick1 = await (await fetch(BASE + '/v1/news/pick', { method: 'POST', headers: H, body: '{}' })).json()
  check('桌面端取到新闻', pick1.item?.title === '今天下了很久的雨', JSON.stringify(pick1.item?.title))
  const pick2 = await (await fetch(BASE + '/v1/news/pick', { method: 'POST', headers: H, body: '{}' })).json()
  check('一天只取一条', pick2.item === null)

  // ---- 封海 ----
  const flagRes = await fetch(BASE + '/admin/api/flags', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'GALLERY_OFF', value: true, reason: 'e2e' }),
  })
  check('关闭橱窗', flagRes.ok)
  const off = await fetch(BASE + '/v1/gallery?pool=day')
  check('橱窗关闭后 503', off.status === 503, `HTTP ${off.status}`)
  await fetch(BASE + '/admin/api/flags', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'GALLERY_OFF', value: false, reason: 'e2e done' }),
  })

  // ---- 鉴权 ----
  const noAuth = await fetch(BASE + '/admin/api/overview')
  check('未登录 401', noAuth.status === 401)

  // ---- 隐私红线 ----
  await fetch(BASE + '/v1/bottle', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ body: '私密的心事不该被管理员看到', utcOffsetMinutes: 480 }),
  })
  const ovText = JSON.stringify(await (await fetch(BASE + '/admin/api/overview', { headers: { Cookie: cookie } })).json())
  check('概览不含私池正文', !ovText.includes('私密的心事'))

  // ---- 日志里没有报错 ----
  check('服务端日志无 error', !/error|Error/.test(logs.replace(/ExperimentalWarning|trace-warnings/g, '')), logs.slice(0, 200))
} catch (e) {
  check('执行未抛异常', false, String(e?.message || e))
} finally {
  child?.kill()
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* Windows 上文件可能仍被占用 */
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n[platform] ${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
