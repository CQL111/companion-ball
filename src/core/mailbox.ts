// mailbox.ts - 许愿瓶的领域规则（零平台依赖）
// 客户端与服务端**共用**这里的常量与纯函数，保证两边行为一致：
// 时段分池、7 天沉海、内容校验、匿名代号。网络传输与存储不在这里。
//
// 产品原则（docs/ROADMAP.md 第四节）：
//   - 结构上不可私聊：没有会话、不能追问
//   - 不显示任何数字：无已读、无点赞、无被捡次数
//   - 回信不保证送达：7 天没人捡就沉海

export const BOTTLE_MAX_LENGTH = 60
export const REPLY_MAX_LENGTH = 60
export const BOTTLE_TTL_DAYS = 7
export const MAX_PICKS = 3
export const DAILY_BOTTLE_LIMIT = 3
export const DAILY_REPLY_LIMIT = 10

/**
 * 内容审核策略（产品决定：不限制内容）。
 *   'open'     = 只做技术校验（非空、长度），不拦截任何内容
 *   'filtered' = 额外拦截联系方式与链接（需要时改这一个常量）
 * 客户端与服务端必须一致，tests/rules-parity.test.ts 会校验。
 */
export const CONTENT_POLICY: 'open' | 'filtered' = 'open'

export type Pool = 'night' | 'morning' | 'day' | 'evening'

/**
 * 按本地时间分池。只返回时段标签——服务端不保存时区或坐标。
 * @param utcOffsetMinutes 客户端时区偏移（东八区 = 480）
 */
export function poolFor(nowMs: number, utcOffsetMinutes: number): Pool {
  const localMs = nowMs + utcOffsetMinutes * 60 * 1000
  const hour = new Date(localMs).getUTCHours()
  if (hour >= 22 || hour < 5) return 'night'
  if (hour < 11) return 'morning'
  if (hour < 18) return 'day'
  return 'evening'
}

/** 是否「深夜」——用于客户端文案（「这个时间还没睡的人」） */
export function isLateNight(pool: Pool): boolean {
  return pool === 'night'
}

export function expiresAt(createdAtMs: number): number {
  return createdAtMs + BOTTLE_TTL_DAYS * 24 * 60 * 60 * 1000
}

export function isExpired(bottle: { expiresAt: number }, nowMs: number): boolean {
  return nowMs >= bottle.expiresAt
}

/** 内容校验结果：ok=false 时 reason 给客户端展示 */
export interface TextCheck {
  ok: boolean
  reason?: 'EMPTY' | 'TOO_LONG' | 'CONTACT' | 'LINK'
  cleaned: string
}

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
 * 校验纸条/回信正文。
 * CONTENT_POLICY = 'open'（当前）：只做非空与长度校验，不拦截内容。
 * 切成 'filtered' 时额外拦截联系方式与链接。
 */
export function checkText(
  raw: string,
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

// ---------- 匿名代号 ----------
// 每次随机，不复用：同一张纸条的投递者与回信者之间没有任何可关联的标识。

const ALIAS_ADJECTIVES = [
  '夜里的', '路过的', '安静的', '早起的', '走神的', '发呆的',
  '慢吞吞的', '突然的', '刚睡醒的', '加班的', '淋了雨的', '不想说话的',
]
const ALIAS_NOUNS = [
  '橘子', '路灯', '猫', '水杯', '窗台', '雨伞', '台灯', '影子', '枕头', '台阶',
  '咖啡渍', '玻璃', '钥匙', '空气', '月亮', '地铁', '纸团', '耳机', '拖鞋', '天气预报',
]

export function randomAlias(random: () => number = Math.random): string {
  // 两个维度用**不同的**随机值：正态的 random() 实现里，两次连续调用可能高度相关，
  // 那样代号会退化成只覆盖少量组合。
  const pickA = random()
  const pickN = random()
  const a = ALIAS_ADJECTIVES[Math.floor(pickA * ALIAS_ADJECTIVES.length)] ?? '路过的'
  const n = ALIAS_NOUNS[Math.floor(pickN * ALIAS_NOUNS.length)] ?? '猫'
  return a + n
}

// ---------- 本地状态（store.bottle）----------

export interface BottleSettings {
  /** 用户是否开启（默认 false，必须 opt-in） */
  enabled: boolean
  /** 服务端地址；留空表示用默认（公测地址在发布时填） */
  endpoint: string
  /** 上次出门巡游的时间（用于「猫出门」节奏） */
  lastOutAt: number
  /** 本地保存的最近一张收到的纸条，用于笔记本展示 */
  lastPickedAt: number
}

export const DEFAULT_BOTTLE_SETTINGS: BottleSettings = {
  enabled: false,
  endpoint: '',
  lastOutAt: 0,
  lastPickedAt: 0,
}

// ---------- 网络契约（客户端与服务端共用的数据形状）----------

export interface BottleDTO {
  id: string
  body: string
  alias: string
}

export interface ReplyDTO {
  bottleId: string
  bottleBody: string
  replyBody: string
  replyAlias: string
  createdAt: number
}

export type BottleErrorCode =
  | 'BAD_TOKEN'
  | 'DAILY_LIMIT'
  | 'SERVICE_PAUSED'
  | 'REVOKED'
  | 'NOT_FOUND'
  | 'ALREADY_REPLIED'
  | 'SELF_REPLY'
  | 'NO_BOTTLE'
  | 'EMPTY'
  | 'TOO_LONG'
  | 'CONTACT'
  | 'LINK'
  | 'NETWORK'
  | 'INTERNAL'

/** 把服务端错误码翻成给用户看的一句话 */
export function bottleErrorText(code: string): string {
  switch (code) {
    case 'DAILY_LIMIT':
      return '今天放得够多了，明天再来'
    case 'SERVICE_PAUSED':
      return '猫邮局暂时关门了'
    case 'REVOKED':
      return '这个设备暂时不能寄信了'
    case 'NOT_FOUND':
    case 'ALREADY_REPLIED':
      return '这张纸条已经漂走了'
    case 'SELF_REPLY':
      return '这是你自己写的'
    case 'NO_BOTTLE':
      return '纸条不见了'
    case 'NETWORK':
      return '海面不太平静，等会儿再试'
    case 'EMPTY':
    case 'TOO_LONG':
    case 'CONTACT':
    case 'LINK':
      return textErrorText(code as TextCheck['reason'])
    default:
      return '出了点问题，等会儿再试'
  }
}

// ---------- 投递 / 回信状态机 ----------
export type BottleStatus = 'floating' | 'picked' | 'replied' | 'sunk'

export interface BottleState {
  createdAt: number
  expiresAt: number
  picks: number
  replyId?: string
}

export function statusOf(b: BottleState, nowMs: number): BottleStatus {
  if (b.replyId) return 'replied'
  if (isExpired(b, nowMs)) return 'sunk'
  if (b.picks > 0) return 'picked'
  return 'floating'
}

/** 是否还能被捡 */
export function canPick(b: BottleState, nowMs: number): boolean {
  if (b.replyId) return false
  if (isExpired(b, nowMs)) return false
  return b.picks < MAX_PICKS
}

/** 是否还能被回（一个瓶子最多收一封回信） */
export function canReply(b: BottleState, nowMs: number): boolean {
  if (b.replyId) return false
  return !isExpired(b, nowMs)
}

/**
 * 客户端「猫出门」的节奏：不是每次出门都带东西回来。
 * 返回本次出门是否该带回一张纸条（由服务端决定是否真的有货）。
 */
export function shouldGoOut(nowMs: number, lastOutAt: number, random: () => number = Math.random): boolean {
  const GAP_MS = 45 * 60 * 1000 // 至少 45 分钟一次
  if (nowMs - lastOutAt < GAP_MS) return false
  return random() < 0.35
}

/** 每日配额判断（服务端同样校验，这里用于客户端提前提示） */
export function withinDailyLimit(todayCount: number, limit = DAILY_BOTTLE_LIMIT): boolean {
  return todayCount < limit
}
