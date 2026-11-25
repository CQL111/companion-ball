// occasions.ts - 事件记忆：随口说一句，被记住（领域层，零平台依赖）
//
// P1.5 的核心判断（docs/PRODUCT-THESIS.md 第四节）：
//   记忆不只记过去，还要**预支未来**。
//   用户随口说「我下周三要面试」，她期待的不是一个闹钟，是**它记得**。
//
// 三条硬约束（照 OCCASIONS.md 第九节的验收写）：
//   1. **只到「日」，不到「时」**：降低出错率，也避免「你怎么知道我几点」的越权感
//   2. **存用户原话**：不重写；日记里才可以润色
//   3. **不做日历**：不做待办列表、不做准时闹钟、不出现「还剩 N 天」
//
// 抽取默认**零 token**：事件词 + 日期词正则同时命中才生成候选。
// 记住与接住的规则必须是可预测、可单测的纯函数。

export type OccasionKind = 'interview' | 'exam' | 'trip' | 'appointment' | 'anniversary' | 'other'

export type OccasionStatus = 'upcoming' | 'passed' | 'dismissed'

export interface Occasion {
  id: string
  /** 用户原话片段，用于展示与删除（不加工） */
  text: string
  kind: OccasionKind
  /** 只精确到「日」：YYYY-MM-DD（本地日期，不是 UTC 时刻） */
  date: string
  /** 「下周三」→ vague；「11月27日」→ day */
  certainty: 'vague' | 'day'
  status: OccasionStatus
  createdAt: string
  /** 三个接住时机各只触发一次 */
  noticedAt?: string // T-1 提过一句
  askedAt?: string // T+1 问过结果
}

/** 最多同时记住这么多「未来的事」；超了淘汰最远的 */
export const MAX_UPCOMING = 10
/** passed / dismissed 保留多久后清理 */
export const CLEANUP_AFTER_MS = 30 * 24 * 60 * 60 * 1000

// ---------- 日期工具 ----------

/** 本地日期 → YYYY-MM-DD */
export function toDateKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** YYYY-MM-DD → 当天 0 点的本地时间戳 */
export function parseDateKey(key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime()
}

/** 两个日期相差几天（按本地日历，不按 24 小时） */
export function daysBetween(fromKey: string, toKey: string): number {
  const a = parseDateKey(fromKey)
  const b = parseDateKey(toKey)
  const da = new Date(a)
  const db = new Date(b)
  return Math.round(
    (Date.UTC(db.getFullYear(), db.getMonth(), db.getDate()) - Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())) /
      86400000,
  )
}

// ---------- 抽取：事件词 + 日期词 ----------

/** 常见公司名：用来识别「面字节」这种省略说法（真实用户口语） */
const COMPANY = '字节|腾讯|阿里|百度|美团|京东|华为|小米|网易|快手|滴滴|拼多多|微软|谷歌'

const EVENT_WORDS: Array<[RegExp, OccasionKind]> = [
  // 「面字节」「字节面试」「字节二面」都算面试
  [new RegExp(`面(?:试)?(?:${COMPANY})|(?:${COMPANY})[^，。！？]{0,4}面(?:试)?`), 'interview'],
  [/面试|复试|笔试|终面|群面|一面|二面|三面/, 'interview'],
  [/考试|测验|模拟考|期末|期中|考研|考公/, 'exam'],
  [/答辩|汇报|路演|演讲|评审/, 'other'],
  [/体检|复诊|看牙|挂号|手术/, 'appointment'],
  [/旅行|旅游|出差|飞|高铁|坐飞机|搬家/, 'trip'],
  [/生日|纪念日|周年|结婚|婚礼/, 'anniversary'],
  [/约会|约了|见面|聚餐|朋友来/, 'appointment'],
]

/**
 * 否定 / 已完成的说法：不建 occasion。
 * 必须要求「过去时间词 + 事件词」同时出现，或明确的取消说法——
 * 否则「我下周三下午要面字节」里的「下午」会被「下」误伤（真实踩过的坑）。
 */
const NEGATIVE =
  /(?:上周|上个月|去年|昨天|前天)[^，。！？]{0,10}(?:面试|考试|答辩|体检|旅行|出差|去了|完了|过了)|(?:面试|考试|答辩|体检|旅行|出差)(?:已经?|早就)(?:完|过|结束)|取消了|没去成|不去了/

interface DateHit {
  date: string
  certainty: 'vague' | 'day'
}

/**
 * 从一句话里解析日期。
 * 只认「相对日期的常见说法」与「明确的月日」，其余一律不猜。
 */
export function parseDate(text: string, now: number): DateHit | null {
  const today = new Date(now)
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())

  const offsetDays = (n: number) => {
    const d = new Date(base)
    d.setDate(d.getDate() + n)
    return toDateKey(d)
  }

  // 今天 / 明天 / 后天 / 大后天
  if (/大后天/.test(text)) return { date: offsetDays(3), certainty: 'day' }
  if (/后天/.test(text)) return { date: offsetDays(2), certainty: 'day' }
  if (/明天|明日/.test(text)) return { date: offsetDays(1), certainty: 'day' }
  if (/今天|今日|今晚/.test(text)) return { date: offsetDays(0), certainty: 'day' }

  // 这周末 / 下周末
  const weekdayMap: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
  const mWeek = /(下|这|本)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(text)
  if (mWeek) {
    const target = weekdayMap[mWeek[2]!]
    if (target !== undefined) {
      const cur = base.getDay()
      let diff = target - cur
      if (mWeek[1] === '下') diff += 7
      else if (diff < 0) diff += 7 // 「这周三」已过 → 下一个周三
      return { date: offsetDays(diff), certainty: 'vague' }
    }
  }
  const mWeekend = /(下|这|本)?(?:周|星期)末/.exec(text)
  if (mWeekend) {
    const cur = base.getDay()
    // 周末按周六算
    let diff = (6 - cur + 7) % 7
    if (mWeekend[1] === '下') diff += 7
    if (diff === 0 && mWeekend[1] !== '下') diff = 0
    return { date: offsetDays(diff), certainty: 'vague' }
  }

  // 下个月 X 号 / X 月 X 日 / X 号（本月或下月）
  const mExplicit = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text)
  if (mExplicit) {
    const month = Number(mExplicit[1])
    const day = Number(mExplicit[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let year = base.getFullYear()
      const candidate = new Date(year, month - 1, day)
      // 已经过去 → 取最近的下一年（「3 月 5 日」在 3 月之后说）
      if (candidate.getTime() < base.getTime()) year += 1
      return { date: toDateKey(new Date(year, month - 1, day)), certainty: 'day' }
    }
  }

  const mMonthDay = /下个?月\s*(\d{1,2})\s*[日号]/.exec(text)
  if (mMonthDay) {
    const day = Number(mMonthDay[1])
    const d = new Date(base.getFullYear(), base.getMonth() + 1, day)
    return { date: toDateKey(d), certainty: 'vague' }
  }

  const mDayOnly = /(?:(\d{1,2})\s*[日号])/.exec(text)
  if (mDayOnly) {
    const day = Number(mDayOnly[1])
    if (day >= 1 && day <= 31) {
      let d = new Date(base.getFullYear(), base.getMonth(), day)
      if (d.getTime() < base.getTime()) d = new Date(base.getFullYear(), base.getMonth() + 1, day)
      return { date: toDateKey(d), certainty: 'vague' }
    }
  }

  // 月底
  if (/月底/.test(text)) {
    const d = new Date(base.getFullYear(), base.getMonth() + 1, 0)
    return { date: toDateKey(d), certainty: 'vague' }
  }

  return null
}

function kindOf(text: string): OccasionKind | null {
  for (const [re, kind] of EVENT_WORDS) {
    if (re.test(text)) return kind
  }
  return null
}

export interface ExtractedOccasion {
  text: string
  kind: OccasionKind
  date: string
  certainty: 'vague' | 'day'
}

/**
 * 从一句话里抽取事件记忆。返回 null 表示不是「未来的事」。
 *
 * 只认「事件词 + 日期词」同时命中；任缺其一都不建（规格第四节）。
 */
export function extractOccasion(message: string, now: number): ExtractedOccasion | null {
  const text = String(message || '').trim()
  if (!text || text.length > 200) return null

  // 否定 / 已完成：不抽
  if (NEGATIVE.test(text)) return null

  const kind = kindOf(text)
  if (!kind) return null

  const hit = parseDate(text, now)
  if (!hit) return null

  // 过去的事不是「未来的事」
  const todayKey = toDateKey(new Date(now))
  if (daysBetween(todayKey, hit.date) < 0) return null

  return { text: text.slice(0, 100), kind, date: hit.date, certainty: hit.certainty }
}

// ---------- 记住：合并 / 状态机 ----------

function makeOccasionId(): string {
  return `o_${Math.random().toString(36).slice(2, 10)}`
}

export interface AddOptions {
  now?: number
  makeId?: () => string
}

/**
 * 加入一条事件记忆。同一天同类事件视为重复，不重复记。
 * 超过 MAX_UPCOMING 时淘汰日期最远的那条（保留最近的）。
 */
export function addOccasion(existing: Occasion[], incoming: ExtractedOccasion, opts: AddOptions = {}): Occasion[] {
  const nowMs = opts.now ?? Date.now()
  const makeId = opts.makeId ?? makeOccasionId
  const nowIso = new Date(nowMs).toISOString()

  const isDup = existing.some(
    (o) => o.status === 'upcoming' && o.kind === incoming.kind && o.date === incoming.date,
  )
  if (isDup) return existing

  const list: Occasion[] = [
    ...existing,
    {
      id: makeId(),
      text: incoming.text,
      kind: incoming.kind,
      date: incoming.date,
      certainty: incoming.certainty,
      status: 'upcoming',
      createdAt: nowIso,
    },
  ]

  const upcoming = list.filter((o) => o.status === 'upcoming')
  if (upcoming.length <= MAX_UPCOMING) return list

  // 淘汰日期最远的一条 upcoming
  const sorted = upcoming
    .slice()
    .sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? -1 : 1) : a.date < b.date ? -1 : 1))
  const victim = sorted[sorted.length - 1]
  return victim ? list.filter((o) => o.id !== victim.id) : list
}

export function dismissOccasion(list: Occasion[], id: string): Occasion[] {
  return list.map((o) => (o.id === id && o.status === 'upcoming' ? { ...o, status: 'dismissed' as const } : o))
}

export function removeOccasion(list: Occasion[], id: string): Occasion[] {
  return list.filter((o) => o.id !== id)
}

/** 关闭开关：清空所有未完成的（已过去的也清掉，避免重新打开时突然冒出来） */
export function clearOccasions(list: Occasion[]): Occasion[] {
  return list.filter((o) => o.status === 'passed' && Date.now() - parseDateKey(o.date) < 0)
}

/** 把状态推进到「已过去」，并清理 30 天前的旧条目 */
export function tickOccasions(list: Occasion[], now: number): Occasion[] {
  const todayKey = toDateKey(new Date(now))
  return list
    .map((o) => {
      if (o.status !== 'upcoming') return o
      // 日期已过 → passed
      if (daysBetween(o.date, todayKey) > 0) return { ...o, status: 'passed' as const }
      return o
    })
    .filter((o) => {
      // passed / dismissed 保留 30 天
      if (o.status === 'upcoming') return true
      return now - parseDateKey(o.date) < CLEANUP_AFTER_MS
    })
}

// ---------- 接住：三个节奏 ----------

export type OccasionBeat = 'approach' | 'today' | 'followup'

export interface OccasionPrompt {
  beat: OccasionBeat
  occasion: Occasion
  /** 给用户看的一句话（不出现数字、不报时间差） */
  line: string
}

const KIND_LABEL: Record<OccasionKind, string> = {
  interview: '面试',
  exam: '考试',
  trip: '出行',
  appointment: '约定',
  anniversary: '纪念日',
  other: '那件事',
}

export function kindLabel(kind: OccasionKind): string {
  return KIND_LABEL[kind]
}

/** 接近时的台词：不报「还剩几天」 */
export function approachLine(o: Occasion): string {
  return `快到你${KIND_LABEL[o.kind]}了。`
}

/** 当天：身体动作优先，这里只准备一句「如果你想说话」的备用台词 */
export function todayLine(o: Occasion): string {
  return `今天是你${KIND_LABEL[o.kind]}的日子。我在这儿。`
}

/** 之后：问一句结果，不逼问 */
export function followupLine(o: Occasion): string {
  return `${KIND_LABEL[o.kind]}怎么样了？`
}

/**
 * 当前该不该「接住」某条 occasion。
 * 每条 occasion 的每个 beat 只触发一次（用 noticedAt / askedAt 记录）。
 *
 * 返回 null 表示现在没有要说的。
 */
export function nextBeat(list: Occasion[], now: number): OccasionPrompt | null {
  const todayKey = toDateKey(new Date(now))

  for (const o of list) {
    if (o.status !== 'upcoming') continue
    const diff = daysBetween(todayKey, o.date) // 正数 = 还有几天

    // T-1：明天就是 → 提一句（仅一次）
    if (diff === 1 && !o.noticedAt) {
      return { beat: 'approach', occasion: o, line: approachLine(o) }
    }
    // 当天：身体动作（由渲染层消费），台词备用
    if (diff === 0) {
      return { beat: 'today', occasion: o, line: todayLine(o) }
    }
    // T+1：昨天的事 → 问一句结果（仅一次）
    if (diff === -1 && !o.askedAt) {
      return { beat: 'followup', occasion: o, line: followupLine(o) }
    }
  }
  return null
}

/** 标记某个 beat 已经触发过 */
export function markBeat(list: Occasion[], id: string, beat: OccasionBeat, now: number): Occasion[] {
  const iso = new Date(now).toISOString()
  return list.map((o) => {
    if (o.id !== id) return o
    if (beat === 'approach') return { ...o, noticedAt: iso }
    if (beat === 'followup') return { ...o, askedAt: iso }
    return o
  })
}

/** 日记里怎么写「我记住了这件事」（润色，但保留用户原话的分量） */
export function diaryLineFor(o: Occasion): string {
  return `今天听你说${o.text.replace(/^我/, '')}。我会记得的。`
}
