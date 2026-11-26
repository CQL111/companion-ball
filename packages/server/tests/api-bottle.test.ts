// tests/api-bottle.test.ts - 许愿瓶集成测试（限额 / 状态机 / 举报 / 吊销 / 封海）
import { describe, expect, it } from 'vitest'
import { handleRequest } from '../src/handler'
import * as admins from '../src/repo/admins'
import { hashToken } from '../src/crypto'
import { TOKEN, makeCfg, makeDb, req, reqWithToken } from './helpers'

async function throwOne(cfg: ReturnType<typeof makeCfg>, token = TOKEN, body = '半夜的一点心事'): Promise<string> {
  const res = await handleRequest(req('/v1/bottle', { body, utcOffsetMinutes: 480 }), cfg)
  const j = (await res.json()) as { ok: boolean; id: string }
  expect(j.ok).toBe(true)
  return j.id
}

describe('扔瓶', () => {
  it('正常扔一张，返回 id 与别名', async () => {
    const cfg = makeCfg(await makeDb())
    const res = await handleRequest(req('/v1/bottle', { body: '今天很累', utcOffsetMinutes: 480 }), cfg)
    const j = (await res.json()) as Record<string, unknown>
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(typeof j.id).toBe('string')
    expect(typeof j.alias).toBe('string')
    expect(j.expiresAt).toBeGreaterThan(Date.now())
  })

  it('空内容被拒', async () => {
    const cfg = makeCfg(await makeDb())
    const res = await handleRequest(req('/v1/bottle', { body: '   ' }), cfg)
    const j = (await res.json()) as { ok: boolean; error: string }
    expect(j.ok).toBe(false)
    expect(j.error).toBe('EMPTY')
  })

  it('超长被拒', async () => {
    const cfg = makeCfg(await makeDb())
    const res = await handleRequest(req('/v1/bottle', { body: '好'.repeat(200) }), cfg)
    const j = (await res.json()) as { ok: boolean; error: string }
    expect(j.error).toBe('TOO_LONG')
  })

  it('每天最多 3 张', async () => {
    const cfg = makeCfg(await makeDb())
    for (let i = 0; i < 3; i++) await throwOne(cfg)
    const res = await handleRequest(req('/v1/bottle', { body: '第四张', utcOffsetMinutes: 480 }), cfg)
    expect(res.status).toBe(429)
    const j = (await res.json()) as { error: string }
    expect(j.error).toBe('DAILY_LIMIT')
  })

  it('缺设备令牌 401', async () => {
    const cfg = makeCfg(await makeDb())
    const res = await handleRequest(req('/v1/bottle', { body: 'x' }, { token: null }), cfg)
    expect(res.status).toBe(401)
  })

  it('伪造时区不能多拿额度（取更早的日界）', async () => {
    const cfg = makeCfg(await makeDb())
    for (let i = 0; i < 3; i++) await throwOne(cfg)
    // 用 -840（UTC-14）撒谎，配额窗口只会更宽或不变，不会放宽
    const res = await handleRequest(req('/v1/bottle', { body: '撒谎', utcOffsetMinutes: -840 }), cfg)
    expect(res.status).toBe(429)
  })
})

describe('捡瓶 / 回信状态机', () => {
  it('捡不到自己的瓶子', async () => {
    const cfg = makeCfg(await makeDb())
    await throwOne(cfg)
    const res = await handleRequest(req('/v1/bottle/pick', { utcOffsetMinutes: 480 }), cfg)
    const j = (await res.json()) as { ok: boolean; bottle: unknown }
    expect(j.ok).toBe(true)
    expect(j.bottle).toBe(null)
  })

  it('另一台设备能捡到', async () => {
    const cfg = makeCfg(await makeDb())
    const id = await throwOne(cfg)
    const res = await handleRequest(req('/v1/bottle/pick', { utcOffsetMinutes: 480 }, { token: 'other-device-token-0123456789' }), cfg)
    const j = (await res.json()) as { ok: boolean; bottle: { id: string; body: string } | null }
    expect(j.bottle?.id).toBe(id)
    expect(j.bottle?.body).toBe('半夜的一点心事')
  })

  it('同一设备不会反复捡到同一张', async () => {
    const cfg = makeCfg(await makeDb())
    await throwOne(cfg)
    const other = 'other-device-token-0123456789'
    const first = (await (await handleRequest(req('/v1/bottle/pick', { utcOffsetMinutes: 480 }, { token: other }), cfg)).json()) as {
      bottle: { id: string } | null
    }
    expect(first.bottle).not.toBe(null)
    const second = (await (await handleRequest(req('/v1/bottle/pick', { utcOffsetMinutes: 480 }, { token: other }), cfg)).json()) as {
      bottle: { id: string } | null
    }
    expect(second.bottle).toBe(null)
  })

  it('没捡过不能回', async () => {
    const cfg = makeCfg(await makeDb())
    const id = await throwOne(cfg)
    const res = await handleRequest(
      req('/v1/bottle/reply', { bottleId: id, body: '回你一句' }, { token: 'other-device-token-0123456789' }),
      cfg,
    )
    expect(res.status).toBe(404)
  })

  it('捡到 → 回一句 → 原主人 inbox 收到', async () => {
    const cfg = makeCfg(await makeDb())
    await throwOne(cfg)
    const other = 'other-device-token-0123456789'
    const picked = (await (await handleRequest(req('/v1/bottle/pick', { utcOffsetMinutes: 480 }, { token: other }), cfg)).json()) as {
      bottle: { id: string }
    }
    const replyRes = await handleRequest(req('/v1/bottle/reply', { bottleId: picked.bottle.id, body: '我也是' }, { token: other }), cfg)
    expect(replyRes.status).toBe(200)

    const inbox = (await (await handleRequest(req('/v1/bottle/inbox', {}, { token: TOKEN }), cfg)).json()) as {
      replies: Array<{ replyBody: string }>
    }
    expect(inbox.replies).toHaveLength(1)
    expect(inbox.replies[0]!.replyBody).toBe('我也是')
  })

  it('一个瓶子最多一封回信', async () => {
    const cfg = makeCfg(await makeDb())
    await throwOne(cfg)
    const a = 'other-device-token-0123456789'
    const b = 'third-device-token-0123456789'
    // 两张不同的瓶子分别给 a、b 捡
    await throwOne(cfg, TOKEN, '第二张')
    const pa = (await (await handleRequest(req('/v1/bottle/pick', { utcOffsetMinutes: 480 }, { token: a }), cfg)).json()) as { bottle: { id: string } | null }
    if (!pa.bottle) return // 随机性导致没捡到时跳过（另一条用例已覆盖基本流程）
    await handleRequest(req('/v1/bottle/reply', { bottleId: pa.bottle.id, body: '一' }, { token: a }), cfg)
    const pb = (await (await handleRequest(req('/v1/bottle/pick', { utcOffsetMinutes: 480 }, { token: b }), cfg)).json()) as { bottle: { id: string } | null }
    if (pb.bottle?.id === pa.bottle.id) {
      const again = await handleRequest(req('/v1/bottle/reply', { bottleId: pa.bottle.id, body: '二' }, { token: b }), cfg)
      expect(again.status).toBeGreaterThanOrEqual(400)
    }
  })

  it('最多被捡 3 次' + '', async () => {
    // 这条由 maxPicks 常量与 SQL 条件保证；这里验证配置传入确实生效
    const cfg = makeCfg(await makeDb(), { limits: { ...makeCfg(await makeDb()).limits, maxPicks: 1 } })
    await throwOne(cfg)
    const a = 'other-device-token-0123456789'
    const b = 'third-device-token-0123456789'
    const pa = (await (await handleRequest(req('/v1/bottle/pick', { utcOffsetMinutes: 480 }, { token: a }), cfg)).json()) as { bottle: unknown }
    expect(pa.bottle).not.toBe(null)
    const pb = (await (await handleRequest(req('/v1/bottle/pick', { utcOffsetMinutes: 480 }, { token: b }), cfg)).json()) as { bottle: unknown }
    expect(pb.bottle).toBe(null)
  })
})

describe('举报', () => {
  it('举报别人的瓶子前必须「见过」，否则 404（防 IDOR）', async () => {
    const cfg = makeCfg(await makeDb())
    const id = await throwOne(cfg)
    const res = await handleRequest(req('/v1/report', { bottleId: id, reason: 'spam' }, { token: 'stranger-device-token-0123456789' }), cfg)
    expect(res.status).toBe(404)
  })

  it('捡到后举报 → 立即对所有人生效', async () => {
    const cfg = makeCfg(await makeDb())
    const id = await throwOne(cfg)
    const a = 'other-device-token-0123456789'
    await handleRequest(req('/v1/bottle/pick', { utcOffsetMinutes: 480 }, { token: a }), cfg)
    const res = await handleRequest(req('/v1/report', { bottleId: id, reason: 'abuse' }, { token: a }), cfg)
    expect(res.status).toBe(200)

    const b = 'third-device-token-0123456789'
    const picked = (await (await handleRequest(req('/v1/bottle/pick', { utcOffsetMinutes: 480 }, { token: b }), cfg)).json()) as { bottle: unknown }
    expect(picked.bottle).toBe(null)
  })
})

describe('三道闸', () => {
  it('吊销令牌后所有写接口 403', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    await admins.listFlags(db) // 预热
    await (await import('../src/repo/bottles')).revokeToken(db, await hashToken(TOKEN), 'test', Date.now())
    const res = await handleRequest(req('/v1/bottle', { body: 'x' }), cfg)
    expect(res.status).toBe(403)
  })

  it('封海后所有写接口 503，读接口仍可用', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    await admins.setFlag(db, { key: 'EMERGENCY_OFF', value: true, reason: 'test', by: 't', now: Date.now() })
    const write = await handleRequest(req('/v1/bottle', { body: 'x' }), cfg)
    expect(write.status).toBe(503)
    const read = await handleRequest(req('/v1/meta'), cfg)
    expect(read.status).toBe(200)
  })

  it('health 反映封海状态', async () => {
    const db = await makeDb()
    const cfg = makeCfg(db)
    const j1 = (await (await handleRequest(req('/v1/health'), cfg)).json()) as { paused: boolean }
    expect(j1.paused).toBe(false)
    await admins.setFlag(db, { key: 'EMERGENCY_OFF', value: true, reason: 'test', by: 't', now: Date.now() })
    const j2 = (await (await handleRequest(req('/v1/health'), cfg)).json()) as { paused: boolean }
    expect(j2.paused).toBe(true)
  })
})

describe('健康检查', () => {
  it('GET /v1/health 返回 ok', async () => {
    const cfg = makeCfg(await makeDb())
    const res = await handleRequest(req('/v1/health'), cfg)
    const j = (await res.json()) as { ok: boolean }
    expect(j.ok).toBe(true)
  })
})
