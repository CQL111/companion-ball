// tests/api-admin.test.ts - 后台认证 / 限流 / 隐私红线
import { describe, expect, it } from 'vitest'
import { hashSecret, sealSecret } from '../src/crypto'
import { handleRequest } from '../src/handler'
import { counterAt, generateTotpSecret, hotp } from '../src/auth/totp'
import * as gm from '../src/repo/admins'
import { makeCfg, makeDb, req, TOKEN } from './helpers'

const MASTER = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64')

/** 建一个 admin，返回登录用凭据 */
async function seedAdmin(db: Awaited<ReturnType<typeof makeDb>>, role = 'admin' as const) {
  const apiKey = 'k'.repeat(64)
  const totpSecret = generateTotpSecret()
  await gm.insertAdmin(db, {
    id: 'admin-1',
    username: 'admin',
    keyHash: await hashSecret(apiKey, 'admin-key'),
    totpSecret: await sealSecret(totpSecret, MASTER),
    role,
    now: Date.now(),
  })
  return { apiKey, totpSecret }
}

async function login(cfg: ReturnType<typeof makeCfg>, apiKey: string, totpSecret: string, now = Date.now()): Promise<Response> {
  const code = await hotp(totpSecret, counterAt(now), 6)
  return handleRequest(
    req('/admin/api/login', { apiKey, totp: code, username: 'admin' }, { token: null, headers: { Origin: 'https://boringtime.cn' } }),
    cfg,
  )
}

function cookieOf(res: Response): string {
  const raw = res.headers.get('Set-Cookie') ?? ''
  return raw.split(';')[0] ?? ''
}

describe('登录', () => {
  it('正确的 API Key + TOTP 登录成功，下发 __Host- Cookie', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const { apiKey, totpSecret } = await seedAdmin(db)
    const res = await login(cfg, apiKey, totpSecret)
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain('__Host-sid=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Strict')
  })

  it('API Key 错误 → 401', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const { totpSecret } = await seedAdmin(db)
    const res = await login(cfg, 'wrong-key', totpSecret)
    expect(res.status).toBe(401)
  })

  it('TOTP 错误 → BAD_TOTP', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const { apiKey } = await seedAdmin(db)
    const res = await handleRequest(
      req('/admin/api/login', { apiKey, totp: '000000', username: 'admin' }, { token: null }),
      cfg,
    )
    const j = (await res.json()) as { error: string }
    expect(j.error).toBe('BAD_TOTP')
  })

  it('跨站 Origin → 403', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const { apiKey, totpSecret } = await seedAdmin(db)
    const code = await hotp(totpSecret, counterAt(Date.now()), 6)
    const res = await handleRequest(
      req('/admin/api/login', { apiKey, totp: code, username: 'admin' }, { token: null, headers: { Origin: 'https://evil.example' } }),
      cfg,
    )
    expect(res.status).toBe(403)
  })

  it('连续失败 6 次后锁定（第 6 次开始 429）', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const { totpSecret } = await seedAdmin(db)
    // LOGIN_MAX_PER_ACCOUNT = 5
    for (let i = 0; i < 5; i++) await login(cfg, 'wrong-' + i, totpSecret)
    const locked = await login(cfg, 'wrong-6', totpSecret)
    expect(locked.status).toBe(429)
    const j = (await locked.json()) as { error: string }
    expect(j.error).toBe('LOGIN_LOCKED')
  })

  it('登录成功后同一窗口的失败计数被清零', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const { apiKey, totpSecret } = await seedAdmin(db)
    for (let i = 0; i < 4; i++) await login(cfg, 'wrong-' + i, totpSecret)
    const ok = await login(cfg, apiKey, totpSecret)
    expect(ok.status).toBe(200)
    // 清零后还能继续登录 5 次而不锁
    const again = await login(cfg, apiKey, totpSecret)
    expect(again.status).toBe(200)
  })

  it('未登录访问受保护接口 → 401', async () => {
    const cfg = makeCfg(await makeDb())
    const res = await handleRequest(req('/admin/api/overview', undefined, { token: null }), cfg)
    expect(res.status).toBe(401)
  })

  it('viewer 不能写开关（403）', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const { apiKey, totpSecret } = await seedAdmin(db, 'viewer')
    const res = await login(cfg, apiKey, totpSecret)
    const cookie = cookieOf(res)
    const flagRes = await handleRequest(
      req('/admin/api/flags', { key: 'EMERGENCY_OFF', value: true, reason: 'x' }, { token: null, headers: { Cookie: cookie } }),
      cfg,
    )
    expect(flagRes.status).toBe(403)
  })

  it('logout 清 Cookie 且会话失效', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const { apiKey, totpSecret } = await seedAdmin(db)
    const cookie = cookieOf(await login(cfg, apiKey, totpSecret))
    const out = await handleRequest(req('/admin/api/logout', {}, { token: null, headers: { Cookie: cookie } }), cfg)
    const setCookie = out.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain('Max-Age=0')
    const me = await handleRequest(req('/admin/api/me', undefined, { token: null, headers: { Cookie: cookie } }), cfg)
    expect(me.status).toBe(401)
  })
})

describe('概览', () => {
  it('返回待办 + 三个比率 + 开关状态', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const { apiKey, totpSecret } = await seedAdmin(db)
    const cookie = cookieOf(await login(cfg, apiKey, totpSecret))
    const res = await handleRequest(req('/admin/api/overview', undefined, { token: null, headers: { Cookie: cookie } }), cfg)
    const j = (await res.json()) as { ok: boolean; todo: Record<string, number>; flags: Record<string, boolean> }
    expect(j.ok).toBe(true)
    expect(j.todo).toHaveProperty('galleryPending')
    expect(j.flags.EMERGENCY_OFF).toBe(false)
  })

  it('不包含 DAU / PV 这类指标（只有约定的比率）', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const { apiKey, totpSecret } = await seedAdmin(db)
    const cookie = cookieOf(await login(cfg, apiKey, totpSecret))
    const res = await handleRequest(req('/admin/api/overview', undefined, { token: null, headers: { Cookie: cookie } }), cfg)
    const j = (await res.json()) as { ratios: Record<string, unknown> }
    expect(Object.keys(j.ratios).sort()).toEqual(['pickRate', 'replyRate', 'reportRate', 'seedShare'])
  })
})

describe('开关', () => {
  it('必须带理由', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const { apiKey, totpSecret } = await seedAdmin(db)
    const cookie = cookieOf(await login(cfg, apiKey, totpSecret))
    const res = await handleRequest(
      req('/admin/api/flags', { key: 'GALLERY_OFF', value: true, reason: '' }, { token: null, headers: { Cookie: cookie } }),
      cfg,
    )
    expect(res.status).toBe(400)
  })

  it('改开关后立即影响公开接口', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const { apiKey, totpSecret } = await seedAdmin(db)
    const cookie = cookieOf(await login(cfg, apiKey, totpSecret))
    await handleRequest(
      req('/admin/api/flags', { key: 'GALLERY_OFF', value: true, reason: '测试' }, { token: null, headers: { Cookie: cookie } }),
      cfg,
    )
    const g = await handleRequest(req('/v1/gallery', undefined, { token: null }), cfg)
    expect(g.status).toBe(503)
  })
})

describe('隐私红线：后台读不到私池', () => {
  it('没有「列出私池」的接口（任何 admin 路由都不返回私池正文集合）', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const { apiKey, totpSecret } = await seedAdmin(db)
    const cookie = cookieOf(await login(cfg, apiKey, totpSecret))

    // 先扔一张私池瓶子（不公开）
    await handleRequest(req('/v1/bottle', { body: '这是私密的心事，不该让管理员看到' }), cfg)

    const probes = ['/admin/api/overview', '/admin/api/reports', '/admin/api/gallery', '/admin/api/audit']
    for (const p of probes) {
      const res = await handleRequest(req(p, undefined, { token: null, headers: { Cookie: cookie } }), cfg)
      const text = await res.text()
      expect(text).not.toContain('这是私密的心事')
    }
  })

  it('被举报的那一条可以被看到（唯一的窄缝）', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const { apiKey, totpSecret } = await seedAdmin(db)
    const cookie = cookieOf(await login(cfg, apiKey, totpSecret))

    const thrown = (await (await handleRequest(req('/v1/bottle', { body: '被举报的内容', utcOffsetMinutes: 480 }), cfg)).json()) as { id: string }
    const other = 'other-device-token-0123456789'
    await handleRequest(req('/v1/bottle/pick', { utcOffsetMinutes: 480 }, { token: other }), cfg)
    await handleRequest(req('/v1/report', { bottleId: thrown.id, reason: 'abuse' }, { token: other }), cfg)

    const res = await handleRequest(req('/admin/api/reports', undefined, { token: null, headers: { Cookie: cookie } }), cfg)
    const text = await res.text()
    expect(text).toContain('被举报的内容')
  })

  it('设备封禁只按哈希，返回体不含设备任何信息', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const { apiKey, totpSecret } = await seedAdmin(db)
    const cookie = cookieOf(await login(cfg, apiKey, totpSecret))
    const res = await handleRequest(
      req('/admin/api/devices/deadbeef/revoke', { note: 'spam' }, { token: null, headers: { Cookie: cookie } }),
      cfg,
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(TOKEN)
  })
})
