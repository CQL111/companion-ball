// dailyLog.ts - 日常记事（领域层，零平台依赖）
//
// M7 的判断（docs/PRODUCT-THESIS.md）：
//   陪伴类产品的留存引擎，是**用户愿不愿意开口**。
//   记账 / 写日记 / 列待办都失败在同一个地方——**报备需要听众，但账本是死的**。
//   用户只要说一句「今天花了10块」，不用打开第二个 App、不用填表单。
//
// 三条硬约束：
//   1. **不维护总额**：一旦有「今日合计」，就会忍不住给建议、做对比，变成记账软件。
//   2. **不评价、不追问**：不说「花得有点多」，不问「还有别的吗」。
//   3. **数字可以出现，但只属于用户**：
//      「你花了10块」是「我听见了」的证据；「陪你3小时」是给关系打分——后者永远不做。
//
// 判据：数字属于谁，不是有没有数字。

export interface DailyNote {
  id: string
  /** 用户原话（去掉「今天」这类时间前缀前的完整句子） */
  text: string
  /** 记录时间（ms） */
  at: number
  /** 本地日期 YYYY-MM-DD */
  day: string
}

/** 晚间复述的起始小时：18 点后 |
 * 太早说「今天你说…」会显得着急 */
export const RECAP_FROM_HOUR = 18
/** 一天最多记这么多条，防止把聊天当流水账 */
export const MAX_NOTES_PER_DAY = 20
/** 保留最近几天的记录（笔记本显示用） */
export const KEEP_DAYS = 7

// ---------- 抽取 ----------

/** 中文/阿拉伯数字 */
const NUM = '[0-9０-９一二两三四五六七八九十百千万半]+'
/** 量词：只认「可数的东西」，避免把「我有点累」当数字 */
const UNIT = '(?:块钱|块|元|杯|公里|千米|小时|分钟|个|次|斤|页|章|集|步|瓶|碗|根|支|张|件|趟|回|样|种|道|顿|片|本|双|台|家)'
/** 消费 / 活动动词 */
const VERB =
  '(?:花了|花掉|花|付了|付|买了|买|喝了|喝|吃了|吃|跑了|跑|走了|走|用了|用|看了|看|读了|读|写了|写|睡了|睡|玩了|玩)'
/** 今天的标记（有它就不需要动词，例如「今天10块」） */
const TODAY = /(?:今天|今日|今儿)/

const NOTE_PATTERNS: RegExp[] = [
  // 动词 + 数字 + 量词：花了10块 / 喝了3杯 / 跑了5公里
  new RegExp(`${VERB}\\s*${NUM}\\s*${UNIT}`),
  // 数字 + 量词（今天在场时可用）：今天10块
  new RegExp(`${NUM}\\s*${UNIT}`),
]

/** 这些说法是「未来的事」，交给事件记忆（occasions），不是日常记事 */
const FUTURE_MARK = /(?:明天|后天|下周|下周[一二三四五六日天]|下个月|月底|这周末|周末|[0-9]+月[0-9]+[日号])/

/**
 * 从一句话里抽「今天的事」。
 *
 * 判定顺序很重要：
 *   1. 像未来的事 → 不记（那是事件记忆的活）
 *   2. 没有数字 + 量词 → 不记（「今天好累」留给普通记忆）
 *   3. 其余命中 → 记为今天的一条
 *
 * 返回 null 表示这不是「今天的、带数量的事实」。
 */
export function extractDailyNote(message: string, now: number): string | null {
  const text = String(message || '').trim()
  if (!text || text.length > 120) return null

  // 未来的事不在这里记
  if (FUTURE_MARK.test(text)) return null

  const hasNumber = NOTE_PATTERNS[0]!.test(text)
  if (!hasNumber) {
    // 没有动词时，必须带「今天」才认（避免「我买了机票」这种一次性闲聊）
    if (!TODAY.test(text) || !NOTE_PATTERNS[1]!.test(text)) return null
  }

  // 只保留第一句，避免把整段话抄下来
  const firstSentence = text.split(/[。！？!?；;]/)[0]?.trim() || text
  return firstSentence.slice(0, 100)
}

// ---------- 存储 ----------

export function localDay(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function makeNoteId(): string {
  return `n_${Math.random().toString(36).slice(2, 10)}`
}

export interface AddNoteOptions {
  now?: number
  makeId?: () => string
}

/**
 * 记一条。同一天里完全相同的话不重复记（用户可能复述）。
 * 保留最近 KEEP_DAYS 天，超出即淘汰。
 */
export function addNote(notes: DailyNote[], text: string, opts: AddNoteOptions = {}): DailyNote[] {
  const now = opts.now ?? Date.now()
  const newId = opts.makeId ?? makeNoteId
  const day = localDay(now)
  const clean = text.replace(/\s+/g, ' ').trim()

  if (notes.some((n) => n.day === day && n.text === clean)) return notes

  const today = notes.filter((n) => n.day === day)
  if (today.length >= MAX_NOTES_PER_DAY) return notes

  const next: DailyNote[] = [...notes, { id: newId(), text: clean, at: now, day }]

  // 只保留最近 KEEP_DAYS 天
  const cutoff = now - KEEP_DAYS * 86400000
  return next.filter((n) => n.at >= cutoff)
}

export function notesOfDay(notes: DailyNote[], now: number): DailyNote[] {
  const day = localDay(now)
  return notes.filter((n) => n.day === day).sort((a, b) => a.at - b.at)
}

// ---------- 晚间复述 ----------

/** 是否到了可以复述的时间 */
export function canRecap(now: number): boolean {
  return new Date(now).getHours() >= RECAP_FROM_HOUR
}

/** 把原话变成「它复述时的样子」：去掉「今天」，保留用户自己的说法 */
export function toRecapPhrase(text: string): string {
  return text
    .replace(/^(?:今天|今日|今儿)\s*/, '')
    .replace(/^(?:我|俺)\s*/, '')
    .trim()
}

/**
 * 生成晚间复述的句子。
 * 返回 null 表示今天没有可复述的事（允许空白）。
 *
 * 最多复述两条：多了就成流水账，反而像报表。
 */
export function buildRecap(notes: DailyNote[], now: number): string | null {
  const today = notesOfDay(notes, now)
  if (!today.length) return null

  const phrases = today.slice(0, 2).map((n) => toRecapPhrase(n.text)).filter(Boolean)
  if (!phrases.length) return null

  if (phrases.length === 1) {
    return `今天你说${phrases[0]}。`
  }
  return `今天你说${phrases[0]}。还说你${phrases[1]}。`
}

/**
 * 今天是否已经复述过。
 * 规则：**一天只复述一次**，错过的那天不补——猫不该像个有未读消息的应用。
 */
export function needsRecap(notes: DailyNote[], lastRecapDay: string, now: number): boolean {
  if (!canRecap(now)) return false
  const day = localDay(now)
  if (lastRecapDay === day) return false
  return notesOfDay(notes, now).length > 0
}
