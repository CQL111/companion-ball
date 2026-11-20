// rules.ts - 服务端的瓶子规则
// ⚠️ 与 src/core/mailbox.ts **必须保持一致**（客户端也用这套常量做提前校验）。
// Workers 不能直接 import 仓库里的 TS 源码，所以这里是一份副本。
//
// 防漂移：仓库根有 tests/rules-parity.test.ts，会读这份文件并比对关键正则与常量，
// 两边不一致时测试直接失败。改规则时两边一起改。

export const BOTTLE_MAX_LENGTH = 60
export const REPLY_MAX_LENGTH = 60
export const BOTTLE_TTL_DAYS = 7
export const MAX_PICKS = 3

/** 内容审核策略，必须与 src/core/mailbox.ts 一致 */
export const CONTENT_POLICY: 'open' | 'filtered' = 'open'

export type Pool = 'night' | 'morning' | 'day' | 'evening'

/** 按客户端上报的时区偏移分池；只返回标签，不保存时区 */
export function poolFor(nowMs: number, utcOffsetMinutes: number): Pool {
  const localHour = new Date(nowMs + utcOffsetMinutes * 60 * 1000).getUTCHours()
  if (localHour >= 22 || localHour < 5) return 'night'
  if (localHour < 11) return 'morning'
  if (localHour < 18) return 'day'
  return 'evening'
}

// 与 src/core/mailbox.ts 的 CONTACT_PATTERNS 逐条一致
const CONTACT_PATTERNS: Array<[RegExp, string]> = [
  [/(?:\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}/, 'CONTACT'],
  [/(?:weixin|wechat|vx|wx|微信|威信|薇信)[\s:：是为号]*[^\s，。！？,.!?]{2,}/i, 'CONTACT'],
  [/(?:qq|扣扣|企鹅)[\s:：是为号]*\d{4,}/i, 'CONTACT'],
  [/\d{7,}/, 'CONTACT'],
  [/(?:https?:\/\/|www\.)\S+/i, 'LINK'],
]

export interface TextCheck {
  ok: boolean
  reason?: 'EMPTY' | 'TOO_LONG' | 'CONTACT' | 'LINK'
  cleaned: string
}

/** 服务端是真正的边界：客户端校验只是体验优化 */
export function checkText(
  raw: unknown,
  maxLength = BOTTLE_MAX_LENGTH,
  policy: 'open' | 'filtered' = CONTENT_POLICY,
): TextCheck {
  const cleaned = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return { ok: false, reason: 'EMPTY', cleaned }
  if (cleaned.length > maxLength) return { ok: false, reason: 'TOO_LONG', cleaned }
  if (policy === 'filtered') {
    for (const [re, reason] of CONTACT_PATTERNS) {
      if (re.test(cleaned)) return { ok: false, reason: reason as TextCheck['reason'], cleaned }
    }
  }
  return { ok: true, cleaned }
}

/** 设备令牌哈希：只存哈希，不存原文 */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode('companion-ball:' + token)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 匿名代号：12×20 = 240 种组合 */
const ADJ = [
  '夜里的', '路过的', '安静的', '早起的', '走神的', '发呆的',
  '慢吞吞的', '突然的', '刚睡醒的', '加班的', '淋了雨的', '不想说话的',
]
const NOUN = [
  '橘子', '路灯', '猫', '水杯', '窗台', '雨伞', '台灯', '影子', '枕头', '台阶',
  '咖啡渍', '玻璃', '钥匙', '空气', '月亮', '地铁', '纸团', '耳机', '拖鞋', '天气预报',
]

export function randomAlias(): string {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)] ?? '路过的'
  const n = NOUN[Math.floor(Math.random() * NOUN.length)] ?? '猫'
  return a + n
}
