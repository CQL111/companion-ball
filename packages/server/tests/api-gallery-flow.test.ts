// tests/api-gallery-flow.test.ts - 完整联调链路：扔瓶（公开）→ 待审 → 批准 → 前台可见
import { describe, expect, it } from 'vitest'
import { handleRequest } from '../src/handler'
import { makeCfg, makeDb, req } from './helpers'

const OFFSET = { utcOffsetMinutes: 480 }

describe('扔瓶时勾选公开', () => {
  it('不勾 → 不产生待审记录', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    await handleRequest(req('/v1/bottle', { body: 'private', ...OFFSET }), cfg)
    const pending = await db.prepare("SELECT COUNT(*) n FROM gallery_bottles WHERE status='pending'").bind().first<{ n: number }>()
    expect(Number(pending?.n)).toBe(0)
  })

  it('勾了 → 产生一条待审记录，且是私池瓶的快照', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const res = await handleRequest(req('/v1/bottle', { body: '公开的心事', requestPublic: true, ...OFFSET }), cfg)
    const thrown = (await res.json()) as { id: string }

    const row = await db
      .prepare("SELECT * FROM gallery_bottles WHERE status='pending'")
      .bind()
      .first<{ body: string; source_bottle: string; seed: number; pool: string }>()
    expect(row?.body).toBe('公开的心事')
    expect(row?.source_bottle).toBe(thrown.id)
    expect(Number(row?.seed)).toBe(0)
  })

  it('橱窗关闭时不产生待审记录', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const { setFlag } = await import('../src/repo/admins')
    await setFlag(db, { key: 'GALLERY_OFF', value: true, reason: 'test', by: 't', now: Date.now() })
    await handleRequest(req('/v1/bottle', { body: 'x', requestPublic: true, ...OFFSET }), cfg)
    const pending = await db.prepare("SELECT COUNT(*) n FROM gallery_bottles").bind().first<{ n: number }>()
    expect(Number(pending?.n)).toBe(0)
  })
})

describe('完整联调链路', () => {
  it('扔瓶（公开）→ 后台批准 → 前台能看到，且看不到任何身份信息', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const admin = await import('../src/repo/admins')
    const { hashSecret, sealSecret } = await import('../src/crypto')
    const { generateTotpSecret, hotp, counterAt } = await import('../src/auth/totp')

    // 管理员
    const apiKey = 'k'.repeat(64)
    const totpSecret = generateTotpSecret()
    await admin.insertAdmin(db, {
      id: 'a1',
      username: 'admin',
      keyHash: await hashSecret(apiKey, 'admin-key'),
      totpSecret: await sealSecret(totpSecret, cfg.totpMasterKey!),
      role: 'admin',
      now: Date.now(),
    })
    const login = await handleRequest(
      req('/admin/api/login', { username: 'admin', apiKey, totp: await hotp(totpSecret, counterAt(Date.now()), 6) }, { token: null }),
      cfg,
    )
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0]

    // 1. 桌面端扔一张公开的
    const throwRes = await handleRequest(req('/v1/bottle', { body: '今天风很大', requestPublic: true, ...OFFSET }), cfg)
    expect(throwRes.status).toBe(200)

    // 2. 后台待审队列里看到
    const pending = (await (
      await handleRequest(req('/admin/api/moderation?status=pending', undefined, { token: null, headers: { Cookie: cookie } }), cfg)
    ).json()) as { items: Array<{ id: string; body: string }> }
    expect(pending.items).toHaveLength(1)
    expect(pending.items[0]!.body).toBe('今天风很大')

    // 3. 批准
    const approve = await handleRequest(
      req(`/admin/api/moderation/${pending.items[0]!.id}`, { action: 'approve', note: 'ok' }, { token: null, headers: { Cookie: cookie } }),
      cfg,
    )
    expect(approve.status).toBe(200)

    // 4. 前台四个潮汐池里能找到它
    let found: Array<Record<string, unknown>> = []
    for (const pool of ['night', 'morning', 'day', 'evening']) {
      const g = (await (await handleRequest(req(`/v1/gallery?pool=${pool}`, undefined, { token: null }), cfg)).json()) as {
        items: Array<Record<string, unknown>>
      }
      found = found.concat(g.items)
    }
    expect(found).toHaveLength(1)
    expect(found[0]!.body).toBe('今天风很大')

    // 5. 前台拿到的字段白名单：只有 id/body/alias/pool
    expect(Object.keys(found[0]!).sort()).toEqual(['alias', 'body', 'id', 'pool'])
  })

  it('桌面端撤回（举报）→ 橱窗立刻下架', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const res = await handleRequest(req('/v1/bottle', { body: '撤回测试', requestPublic: true, ...OFFSET }), cfg)
    const thrown = (await res.json()) as { id: string }

    // 直接批准（跳过登录，测的是联动）
    const g = await db.prepare("SELECT id FROM gallery_bottles WHERE status='pending'").bind().first<{ id: string }>()
    const { review } = await import('../src/repo/gallery')
    await review(db, { id: g!.id, status: 'approved', reviewer: 't', note: 'ok', now: Date.now(), ttlDays: 30 })

    // 作者举报自己的瓶子 = 撤回
    await handleRequest(req('/v1/report', { bottleId: thrown.id, reason: 'other' }, { token: undefined }), cfg)

    const after = (await (await handleRequest(req('/v1/gallery?pool=night', undefined, { token: null }), cfg)).json()) as {
      items: unknown[]
    }
    const afterDay = (await (await handleRequest(req('/v1/gallery?pool=day', undefined, { token: null }), cfg)).json()) as {
      items: unknown[]
    }
    expect([...after.items, ...afterDay.items]).toHaveLength(0)
  })
})

describe('内测模式：忽略时段池', () => {
  it('默认按池匹配（分时段碰不到）', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    // 东八区白天写
    await handleRequest(req('/v1/bottle', { body: '白天写的', utcOffsetMinutes: 480 }), cfg)
    // 用夜里 3 点去捡：池不同 → 捡不到
    const night = new Date()
    night.setHours(3, 0, 0, 0)
    const realNow = Date.now
    Date.now = () => night.getTime()
    try {
      const res = await handleRequest(req('/v1/bottle/pick', { utcOffsetMinutes: 480 }, { token: 'other-device-token-0123456789' }), cfg)
      const j = (await res.json()) as { bottle: unknown }
      expect(j.bottle).toBe(null)
    } finally {
      Date.now = realNow
    }
  })

  it('INTRA_TEST=1 时任何时段都能捡到', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db, { intraTest: true })
    await handleRequest(req('/v1/bottle', { body: '白天写的', utcOffsetMinutes: 480 }), cfg)
    const res = await handleRequest(req('/v1/bottle/pick', { utcOffsetMinutes: -480 }, { token: 'other-device-token-0123456789' }), cfg)
    const j = (await res.json()) as { bottle: { body: string } | null }
    expect(j.bottle?.body).toBe('白天写的')
  })
})
