// tests/mailbox.test.ts - 许愿瓶领域规则单测
import { describe, expect, it } from 'vitest'
import {
  BOTTLE_MAX_LENGTH,
  BOTTLE_TTL_DAYS,
  MAX_PICKS,
  canPick,
  canReply,
  checkText,
  expiresAt,
  isExpired,
  poolFor,
  randomAlias,
  shouldGoOut,
  statusOf,
  textErrorText,
  withinDailyLimit,
  type BottleState,
} from '@core/mailbox'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0) // 2026-11-20 12:00 UTC

describe('时段分池', () => {
  it('按本地时间分四个池（东八区）', () => {
    const at = (utcHour: number) => T0 - 12 * 3600e3 + utcHour * 3600e3
    // 东八区 23:00 = UTC 15:00
    expect(poolFor(at(15), 480)).toBe('night')
    // 东八区 07:00 = UTC 23:00（前一天）→ 用 Day0 的 UTC 23 点
    expect(poolFor(Date.UTC(2026, 10, 19, 23), 480)).toBe('morning')
    // 东八区 13:00 = UTC 05:00
    expect(poolFor(at(5), 480)).toBe('day')
    // 东八区 20:00 = UTC 12:00
    expect(poolFor(at(12), 480)).toBe('evening')
  })

  it('深夜边界：22:00 与 05:00 都算 night/非 night 的分界', () => {
    expect(poolFor(Date.UTC(2026, 10, 20, 14), 480)).toBe('night') // 本地 22:00
    expect(poolFor(Date.UTC(2026, 10, 20, 21), 480)).toBe('morning') // 本地 05:00
  })

  it('不同时区得到不同池（只按时段，不存时区）', () => {
    const utcNoon = Date.UTC(2026, 10, 20, 12)
    expect(poolFor(utcNoon, 480)).toBe('evening') // 北京 20:00
    expect(poolFor(utcNoon, 0)).toBe('day') // 伦敦 12:00
  })
})

describe('过期与沉海', () => {
  it('7 天后过期', () => {
    const exp = expiresAt(T0)
    expect(exp - T0).toBe(BOTTLE_TTL_DAYS * DAY)
    expect(isExpired({ expiresAt: exp }, exp - 1)).toBe(false)
    expect(isExpired({ expiresAt: exp }, exp)).toBe(true)
  })

  it('没人捡 → sunk', () => {
    const b: BottleState = { createdAt: T0, expiresAt: expiresAt(T0), picks: 0 }
    expect(statusOf(b, T0 + DAY)).toBe('floating')
    expect(statusOf(b, T0 + 8 * DAY)).toBe('sunk')
  })

  it('回信后状态固定为 replied', () => {
    const b: BottleState = { createdAt: T0, expiresAt: expiresAt(T0), picks: 2, replyId: 'r1' }
    expect(statusOf(b, T0 + 1000)).toBe('replied')
  })
})

describe('能否捡 / 能否回', () => {
  const base: BottleState = { createdAt: T0, expiresAt: expiresAt(T0), picks: 0 }

  it('漂浮中可捡', () => {
    expect(canPick(base, T0 + 1000)).toBe(true)
  })
  it('被捡满 MAX_PICKS 次后不可再捡', () => {
    expect(canPick({ ...base, picks: MAX_PICKS }, T0 + 1000)).toBe(false)
  })
  it('过期后不可捡也不可回', () => {
    expect(canPick(base, T0 + 8 * DAY)).toBe(false)
    expect(canReply(base, T0 + 8 * DAY)).toBe(false)
  })
  it('一个瓶子最多收一封回信', () => {
    expect(canReply(base, T0 + 1000)).toBe(true)
    expect(canReply({ ...base, replyId: 'r1' }, T0 + 1000)).toBe(false)
  })
})

describe('内容校验（open 策略：不限制内容）', () => {
  it('正常短句通过', () => {
    const r = checkText('今天加班到很晚')
    expect(r.ok).toBe(true)
    expect(r.cleaned).toBe('今天加班到很晚')
  })

  it('空内容 / 纯空白不行（技术校验仍然生效）', () => {
    expect(checkText('').reason).toBe('EMPTY')
    expect(checkText('   \n ').reason).toBe('EMPTY')
  })

  it('超长不行（60 字上限）', () => {
    expect(checkText('字'.repeat(BOTTLE_MAX_LENGTH)).ok).toBe(true)
    expect(checkText('字'.repeat(BOTTLE_MAX_LENGTH + 1)).reason).toBe('TOO_LONG')
  })

  it('open 策略下不拦截联系方式与链接（产品决定：内容不限制）', () => {
    expect(checkText('加我 13800138000').ok).toBe(true)
    expect(checkText('加我微信 abc123').ok).toBe(true)
    expect(checkText('看这个 https://example.com').ok).toBe(true)
  })

  it('归一化空白', () => {
    expect(checkText('  今天   好累  ').cleaned).toBe('今天 好累')
  })

  it('filtered 策略下仍然能拦住（开关保留）', () => {
    expect(checkText('加我 13800138000', 60, 'filtered').reason).toBe('CONTACT')
    expect(checkText('加我微信 abc123', 60, 'filtered').reason).toBe('CONTACT')
    expect(checkText('我威信是 abc', 60, 'filtered').reason).toBe('CONTACT')
    expect(checkText('qq:12345678', 60, 'filtered').reason).toBe('CONTACT')
    expect(checkText('看这个 https://example.com', 60, 'filtered').reason).toBe('LINK')
    expect(checkText('今天走了 3 公里', 60, 'filtered').ok).toBe(true)
  })

  it('错误文案可读', () => {
    for (const r of ['EMPTY', 'TOO_LONG', 'CONTACT', 'LINK'] as const) {
      expect(textErrorText(r).length).toBeGreaterThan(2)
    }
  })
})

describe('匿名代号', () => {
  it('形如「夜里的橘子」，每次可不同', () => {
    const alias = randomAlias(() => 0)
    expect(alias).toMatch(/^.+.$/)
    expect(alias).toBe('夜里的橘子')
  })

  it('随机源不同则代号不同（不复用同一身份）', () => {
    expect(randomAlias(() => 0)).not.toBe(randomAlias(() => 0.99))
  })

  it('大量生成不重复度足够高', () => {
    // 用 mulberry32：真实伪随机分布。注意不要用「i×黄金比例 mod 1」做测试随机源——
    // 相邻两次调用的值是线性相关的，二维取样会退化成一条直线上的少数组合。
    let s = 0x12345678
    const rnd = () => {
      s = (s + 0x6d2b79f5) | 0
      let t = Math.imul(s ^ (s >>> 15), 1 | s)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const set = new Set<string>()
    for (let k = 0; k < 400; k++) set.add(randomAlias(rnd))
    expect(set.size).toBeGreaterThan(100)
  })

  it('随机源是常量时也能得到合法代号（同一组合），不会崩', () => {
    expect(randomAlias(() => 0.5)).toBe(randomAlias(() => 0.5))
  })
})

describe('猫出门的节奏', () => {
  it('45 分钟内不再出门', () => {
    expect(shouldGoOut(T0 + 10 * 60 * 1000, T0, () => 0)).toBe(false)
  })
  it('超过 45 分钟后按概率出门', () => {
    expect(shouldGoOut(T0 + 60 * 60 * 1000, T0, () => 0)).toBe(true)
    expect(shouldGoOut(T0 + 60 * 60 * 1000, T0, () => 0.99)).toBe(false)
  })
})

describe('每日配额', () => {
  it('达到上限后不可再投', () => {
    expect(withinDailyLimit(2)).toBe(true)
    expect(withinDailyLimit(3)).toBe(false)
  })
})
