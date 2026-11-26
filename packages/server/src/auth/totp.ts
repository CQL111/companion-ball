// auth/totp.ts - RFC 6238 TOTP（只用 WebCrypto 标准原语）
//
// 为什么自己写：Cloudflare 免费档 CPU 只有 10ms，PBKDF2 10 万轮跑不完，
// 而 HMAC-SHA1 + 一次比较是微秒级。**不自己发明算法**——这里严格按 RFC 6238。
// 参考：RFC 4226（HOTP）、RFC 4648（Base32）。

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx < 0) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/** 生成新的 TOTP 密钥（20 字节 = 160 bit，RFC 4226 推荐长度） */
export function generateTotpSecret(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  return base32Encode(bytes)
}

/** 用于 otpauth:// URI（二维码） */
export function totpUri(secret: string, username: string, issuer = '团子猫灯塔'): string {
  const label = encodeURIComponent(`${issuer}:${username}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

export interface TotpOptions {
  /** 时间步长（秒），RFC 默认 30 */
  period?: number
  /** 位数，默认 6 */
  digits?: number
  /** 允许前后偏移多少个窗口（时钟漂移），默认 1 */
  window?: number
}

/** 计算某个时间片的一次性密码 */
export async function hotp(secret: string, counter: number, digits = 6): Promise<string> {
  const keyBytes = base32Decode(secret)
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])

  const buf = new ArrayBuffer(8)
  const view = new DataView(buf)
  // counter 最多 2^53，拆成高低 32 位
  view.setUint32(0, Math.floor(counter / 0x100000000))
  view.setUint32(4, counter >>> 0)
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf))

  // 动态截断（RFC 4226 §5.3）
  const offset = sig[sig.length - 1]! & 0x0f
  const code =
    ((sig[offset]! & 0x7f) << 24) | (sig[offset + 1]! << 16) | (sig[offset + 2]! << 8) | sig[offset + 3]!
  return String(code % 10 ** digits).padStart(digits, '0')
}

/** 当前时间片 */
export function counterAt(now: number, period = 30): number {
  return Math.floor(now / 1000 / period)
}

/**
 * 验证用户输入的 TOTP。
 * 允许前后各 1 个窗口的漂移（手机时间不一定准），同时用常量时间比较避免时序侧信道。
 */
export async function verifyTotp(secret: string, input: string, now: number, opts: TotpOptions = {}): Promise<boolean> {
  const period = opts.period ?? 30
  const digits = opts.digits ?? 6
  const window = opts.window ?? 1
  const code = String(input).replace(/\s/g, '')
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return false

  const base = counterAt(now, period)
  for (let d = -window; d <= window; d++) {
    const expected = await hotp(secret, base + d, digits)
    if (timingSafeEqual(expected, code)) return true
  }
  return false
}

/** 等长字符串的常量时间比较 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
