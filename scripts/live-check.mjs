// scripts/live-check.mjs - 联调验证：桌面端扔瓶 → 后台批准 → 网页可见
//
// 前提：npm run dev:platform 已经在跑（8080），且你知道管理员的 API Key 与 TOTP 密钥。
// 用法：npm run live:check -- <API_KEY> <TOTP_SECRET>
//
// 它会扔一张公开的测试瓶子、用后台批准、然后验证网页橱窗能看到。
// 测试内容会留在库里——不想要就 npm run db:reset。
import { createHmac } from 'node:crypto'

const BASE = 'http://127.0.0.1:8080'
const API_KEY = process.argv[2]
const TOTP_SECRET = process.argv[3]

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function b32d(s) {
  const out = []
  let bits = 0, val = 0
  for (const ch of s.toUpperCase()) {
    const i = B32.indexOf(ch)
    if (i < 0) continue
    val = (val << 5) | i
    bits += 5
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return Buffer.from(out)
}
function totp(secret) {
  const c = Math.floor(Date.now() / 1000 / 30)
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(c / 2 ** 32), 0)
  buf.writeUInt32BE(c >>> 0, 4)
  const h = createHmac('sha1', b32d(secret)).update(buf).digest()
  const o = h[h.length - 1] & 0x0f
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(code % 1e6).padStart(6, '0')
}

const out = []
const check = (n, ok, d = '') => { out.push({ n, ok }); console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`) }

// 和桌面端一样的设备令牌算法：HMAC-SHA256(installId)
const deviceToken = createHmac('sha256', 'local-test-install-id').update('companion-ball-bottle-v1').digest('hex')
const H = { 'Content-Type': 'application/json', 'X-Device-Token': deviceToken }

// 1) 桌面端扔一张公开的
const body = '今天加班到很晚，回家路上的月亮很亮。'
const throwRes = await fetch(BASE + '/v1/bottle', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ body, utcOffsetMinutes: 480, requestPublic: true }),
})
const thrown = await throwRes.json()
check('桌面端扔瓶（勾选公开）', throwRes.ok && thrown.ok, JSON.stringify(thrown).slice(0, 80))

// 2) 登录后台
const login = await fetch(BASE + '/admin/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: BASE },
  body: JSON.stringify({ username: 'admin', apiKey: API_KEY, totp: totp(TOTP_SECRET) }),
})
const loginJson = await login.json()
check('后台登录', login.ok && loginJson.ok, JSON.stringify(loginJson).slice(0, 60))
const cookie = (login.headers.get('set-cookie') || '').split(';')[0]

// 3) 待审队列
const mod = await (await fetch(BASE + '/admin/api/moderation?status=pending', { headers: { Cookie: cookie } })).json()
const item = mod.items?.find((x) => x.body.includes('月亮很亮'))
check('出现在后台待审队列', !!item, item ? item.id.slice(0, 8) : 'not found')

// 4) 批准
if (item) {
  const ap = await fetch(BASE + `/admin/api/moderation/${item.id}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'approve', note: '联调测试' }),
  })
  check('批准', ap.ok)
}

// 5) 网页橱窗能看到
let visible = false
for (const pool of ['night', 'morning', 'day', 'evening']) {
  const g = await (await fetch(BASE + `/v1/gallery?pool=${pool}`)).json()
  if ((g.items || []).some((x) => x.body.includes('月亮很亮'))) visible = true
}
check('网页橱窗能看到这张纸条', visible)

// 6) 网页 HTML 也能拿到（/gallery 页面 + 接口）
const galleryPage = await fetch(BASE + '/gallery')
check('/gallery 页面可访问', galleryPage.ok)

// 7) 前台拿不到任何身份信息
const one = (await (await fetch(BASE + '/v1/gallery?pool=night')).json()).items?.[0] ??
  (await (await fetch(BASE + '/v1/gallery?pool=day')).json()).items?.[0]
if (one) {
  check('前台只返回 4 个字段', JSON.stringify(Object.keys(one).sort()) === '["alias","body","id","pool"]', Object.keys(one).join(','))
  check('不返回作者/设备/seed', !JSON.stringify(one).includes('author') && !('seed' in one))
}

const failed = out.filter((r) => !r.ok)
console.log(`\n[联调] ${out.length - failed.length}/${out.length} 通过`)
process.exit(failed.length ? 1 : 0)
