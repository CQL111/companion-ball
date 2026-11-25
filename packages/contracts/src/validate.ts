// validate.ts - 纸条 / 回信正文校验（客户端与服务端共用）
import { BOTTLE_MAX_LENGTH, CONTENT_POLICY } from './constants'
import type { TextCheck } from './types'

const CONTACT_PATTERNS: Array<[RegExp, TextCheck['reason']]> = [
  // 手机号：兼容 +86 / 空格 / 横线分隔的写法
  [/(?:\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}/, 'CONTACT'],
  // 微信 / QQ：关键词后允许分隔符与连接字（「我威信是 abc」这种写法）
  // 注意 \w 不匹配中文，所以内容部分用 [^\s，。！？] 表达
  [/(?:weixin|wechat|vx|wx|微信|威信|薇信)[\s:：是为号]*[^\s，。！？,.!?]{2,}/i, 'CONTACT'],
  [/(?:qq|扣扣|企鹅)[\s:：是为号]*\d{4,}/i, 'CONTACT'],
  // 裸数字串：7 位以上连续数字多半是号码
  [/\d{7,}/, 'CONTACT'],
  [/(?:https?:\/\/|www\.)\S+/i, 'LINK'],
]

/**
 * 校验纸条 / 回信正文。
 * CONTENT_POLICY = 'open'（当前）：只做非空与长度校验，不拦截内容。
 * 切成 'filtered' 时额外拦截联系方式与链接。
 */
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
      if (re.test(cleaned)) return { ok: false, reason, cleaned }
    }
  }
  return { ok: true, cleaned }
}

/** 客户端展示用的错误文案 */
export function textErrorText(reason: TextCheck['reason']): string {
  switch (reason) {
    case 'EMPTY':
      return '写点什么再放进去吧'
    case 'TOO_LONG':
      return `最多 ${BOTTLE_MAX_LENGTH} 个字`
    case 'CONTACT':
      return '这里不能留联系方式'
    case 'LINK':
      return '这里不能放链接'
    default:
      return '这张纸条放不进去'
  }
}
