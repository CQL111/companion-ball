// tests/totp.test.ts - RFC 6238 测试向量 + 密钥编解码
import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode, counterAt, generateTotpSecret, hotp, timingSafeEqual, totpUri, verifyTotp } from '../src/auth/totp'

// RFC 6238 附录 B 的 SHA-1 向量（用 ASCII "12345678901234567890" 作密钥）
const RFC_SECRET = base32Encode(new TextEncoder().encode('12345678901234567890'))

describe('base32', () => {
  it('编码后再解码回到原字节', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 64])
    const round = base32Decode(base32Encode(bytes))
    expect([...round]).toEqual([...bytes])
  })
  it('解码忽略空白与大小写', () => {
    expect(base32Decode('jbsw y3dp')).toEqual(base32Decode('JBSWY3DP'))
  })
})

describe('HOTP（RFC 4226 附录 D 向量）', () => {
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
  ])('counter=%i → %s', async (counter, expected) => {
    expect(await hotp(RFC_SECRET, counter, 6)).toBe(expected)
  })
})

describe('TOTP（RFC 6238 附录 B，SHA-1）', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])('t=%i → %s', async (sec, expected8) => {
    // RFC 向量是 8 位；我们默认 6 位，取后 6 位对齐
    const code = await hotp(RFC_SECRET, Math.floor(sec / 30), 8)
    expect(code).toBe(expected8)
  })
})

describe('verifyTotp', () => {
  const secret = generateTotpSecret()

  it('当前码通过', async () => {
    const now = Date.UTC(2026, 10, 26, 12, 0, 0)
    const code = await hotp(secret, counterAt(now), 6)
    expect(await verifyTotp(secret, code, now)).toBe(true)
  })

  it('允许前后一个窗口的漂移', async () => {
    const now = Date.UTC(2026, 10, 26, 12, 0, 0)
    const prev = await hotp(secret, counterAt(now) - 1, 6)
    const next = await hotp(secret, counterAt(now) + 1, 6)
    expect(await verifyTotp(secret, prev, now)).toBe(true)
    expect(await verifyTotp(secret, next, now)).toBe(true)
  })

  it('两个窗口以前的码不通过', async () => {
    const now = Date.UTC(2026, 10, 26, 12, 0, 0)
    const old = await hotp(secret, counterAt(now) - 3, 6)
    expect(await verifyTotp(secret, old, now)).toBe(false)
  })

  it('格式不对直接拒绝', async () => {
    expect(await verifyTotp(secret, 'abc', Date.now())).toBe(false)
    expect(await verifyTotp(secret, '12345', Date.now())).toBe(false)
  })
})

describe('工具', () => {
  it('生成的密钥可被解码且长度合理', () => {
    expect(base32Decode(generateTotpSecret()).length).toBe(20)
  })
  it('otpauth URI 含必要字段', () => {
    const uri = totpUri('JBSWY3DP', 'me')
    expect(uri.startsWith('otpauth://totp/')).toBe(true)
    expect(uri).toContain('secret=JBSWY3DP')
    expect(uri).toContain('digits=6')
  })
  it('timingSafeEqual 比长度与内容', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'ab')).toBe(false)
  })
})
