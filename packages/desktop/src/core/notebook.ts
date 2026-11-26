// notebook.ts - 猫的笔记本（领域层，零平台依赖）
// 一等公民容器：日记（每日一条，允许空白）+ 将来的瓶子。S2 先做日记。
//
// 写作规则（docs/ROADMAP.md 第五节）：
// - 猫的第一人称，2–4 句，有日期，允许空白
// - 不出现任何数字和统计
// - 说感受，不说数据
//
// S2 的日记由「记忆摘要 + 模板」拼装，不调模型；S4 接入环境后再考虑让模型润色。

import { dateKey } from './petState'
import { memoryTopics, type Memory } from './memory'

export interface DiaryEntry {
  /** 本地日期 YYYY-MM-DD */
  date: string
  createdAt: string // UTC ISO
  /** 空的句子数组表示「今天没话说」 */
  lines: string[]
  /**
   * 素材来源，便于调试与「为什么写这句」：
   *   template = 按当天交互拼的通用日记（会被重算覆盖）
   *   absence  = 长时间离开后回来写的（真实事件，不能被覆盖）
   */
  source: 'template' | 'absence'
  /**
   * P2 页边一句话：用户在这一页留下的私密回话。
   * 与 `lines` 完全隔离——猫的日记怎么重算都不会碰它。
   * 可以写在任意一页（旧的那页也能补一句）。
   */
  margin?: MarginNote
}

/**
 * 页边一句话（M4）。
 * 硬限制（都写成了测试）：≤1 行、非即时（没有回复通道）、不可公开。
 * 它是最好的记忆素材，但**永远不进任何出网通路**（P2 验收红线）。
 */
export interface MarginNote {
  /** 本地日期 YYYY-MM-DD（写下这句的那天） */
  date: string
  text: string
  createdAt: string // UTC ISO
}

export const MARGIN_MAX_CHARS = 60

/**
 * 规范化一条页边话。返回 null 表示这句不该被留下。
 * 规则：
 *   1. 只有一行——换行折成空格（不让它变回聊天框）
 *   2. 去掉首尾空白；空的不要
 *   3. 超长截断，**不报错**——页边不该有表单校验的压迫感
 */
export function normalizeMargin(text: string): string | null {
  const one = String(text).replace(/\s+/g, ' ').trim()
  if (!one) return null
  return one.length > MARGIN_MAX_CHARS ? one.slice(0, MARGIN_MAX_CHARS) : one
}

export interface Notebook {
  version: 1
  entries: DiaryEntry[]
}

export const EMPTY_NOTEBOOK: Notebook = { version: 1, entries: [] }
export const MAX_ENTRIES = 365

export interface BuildDiaryInput {
  /** now 用于取本地日期与时段判断 */
  now: number
  /** 已说话的用户轮次数（当天的） */
  userTurns: number
  /** 与猫的交互次数（点击 / 拖动 / 靠近） */
  interactions: number
  memories: Memory[]
  /** 今天是否第一次打开对话 */
  talkedToday: boolean
}

function timeOfDay(now: number): 'morning' | 'afternoon' | 'evening' | 'night' {
  const h = new Date(now).getHours()
  if (h < 6) return 'night'
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  if (h < 23) return 'evening'
  return 'night'
}

/**
 * 生成今天的日记行。返回空数组表示今天不写（真日记允许空白）。
 * 素材全部来自本地记录：不调模型、不出现数字。
 */
export function buildDiaryLines({ now, userTurns, interactions, memories, talkedToday }: BuildDiaryInput): string[] {
  const tod = timeOfDay(now)
  const topics = memoryTopics(memories)
  const lines: string[] = []

  if (userTurns >= 5) {
    lines.push(talkedToday ? '今天你说了不少话。' : '今天你说了很多，我一直听着。')
  } else if (userTurns > 0) {
    lines.push('今天你和我说了几句话。')
  } else if (interactions >= 3) {
    lines.push('你今天没怎么说话，只是时不时看我一眼。')
  } else if (interactions === 0) {
    lines.push('今天你几乎没出现。')
  } else {
    lines.push('今天很安静。')
  }

  if (memories.length && topics.length) {
    const labels = topics.slice(0, 2).join('和')
    lines.push(`我记得你在忙${labels}的事。`)
  } else if (memories.length) {
    lines.push('我还记得你之前说过的那些事。')
  }

  if (tod === 'night' && interactions > 0) {
    lines.push('夜深了，我有点困，但想等你先睡。')
  } else if (tod === 'morning' && userTurns === 0) {
    lines.push('早上很安静，我趴在桌角等你来。')
  } else if (interactions <= 1 && userTurns === 0) {
    lines.push('我在桌上待了一整天，看着光线慢慢变了。')
  } else {
    lines.push('就这样待着，也挺好。')
  }

  return lines.slice(0, 4)
}

/**
 * 写入今天的日记。同一天重复调用会覆盖（日记每天最多一条）。
 * 返回新 Notebook，不修改入参。
 *
 * 例外：如果当天已有 source='absence' 的条目，普通模板日记**不覆盖它**——
 * 缺席是真实发生的事件，不是可以重算的统计。
 */
export function upsertDiary(notebook: Notebook, now: number, lines: string[], source: 'template' | 'absence' = 'template'): Notebook {
  const date = dateKey(now)
  const createdAt = new Date(now).toISOString()
  const prev = notebook.entries.find((e) => e.date === date)
  // P2：页边一句话是用户的东西，日记怎么重算都必须原样带过去。
  const margin = prev?.margin

  // 模板日记不能覆盖缺席日记（但缺席可以补充/覆盖模板）
  if (source === 'template' && prev?.source === 'absence' && lines.length) {
    // 保留缺席那几句，把模板内容接在后面（总长 ≤4）
    const merged = [...prev.lines, ...lines].slice(0, 4)
    const entries = notebook.entries.filter((e) => e.date !== date)
    entries.push({ date, createdAt, lines: merged, source: 'absence', ...(margin ? { margin } : {}) })
    entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    return { version: 1, entries: entries.slice(0, MAX_ENTRIES) }
  }

  const entries = notebook.entries.filter((e) => e.date !== date)
  // 空白日记不落盘：没有话说就不留痕（避免制造「今天没记录」的压力）
  // ——但如果用户在空白的一页留了话，这一页必须存在，否则他的话就没了
  if (lines.length || margin) {
    entries.push({ date, createdAt, lines, source, ...(margin ? { margin } : {}) })
  }
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  return { version: 1, entries: entries.slice(0, MAX_ENTRIES) }
}

/**
 * 在某一页留一句话（P2）。
 * 返回 null 表示这句不该被留下（空的 / 全是空白）。
 *
 * 允许写在任意一页——包括猫那天什么都没写的空白页。
 * 一页只有一句：再留会覆盖上一句，因为「页边」的隐喻就是只有那么窄一条。
 */
export function writeMargin(
  notebook: Notebook,
  date: string,
  text: string,
  now: number,
): Notebook | null {
  const one = normalizeMargin(text)
  if (!one) return null

  const createdAt = new Date(now).toISOString()
  const margin: MarginNote = { date: dateKey(now), text: one, createdAt }
  const existing = notebook.entries.find((e) => e.date === date)

  if (existing) {
    const entries = notebook.entries.map((e) => (e.date === date ? { ...e, margin } : e))
    return { version: 1, entries }
  }

  // 空白页也要建出来：用户写的话不能被「空白不落盘」的规则吞掉
  const entries = [...notebook.entries, { date, createdAt, lines: [], source: 'template' as const, margin }]
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  return { version: 1, entries: entries.slice(0, MAX_ENTRIES) }
}

/** 抹掉某一页的页边话（用户后悔了）。数据不保留。 */
export function eraseMargin(notebook: Notebook, date: string): Notebook | null {
  const existing = notebook.entries.find((e) => e.date === date)
  if (!existing?.margin) return null
  return {
    version: 1,
    entries: notebook.entries.map((e) => (e.date === date ? { ...e, margin: undefined } : e)),
  }
}

/** 最近 N 天的日记（含今天，允许缺失） */
export function recentEntries(notebook: Notebook, days: number): DiaryEntry[] {
  return notebook.entries.slice(0, Math.max(0, days))
}

/** 导出为 Markdown（本地导出，不同步、不分享是产品边界） */
export function toMarkdown(notebook: Notebook): string {
  const header = '# 猫的笔记本\n\n'
  if (!notebook.entries.length) return header + '_还没有记录。_\n'
  return (
    header +
    notebook.entries
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map((e) => {
        const diary = e.lines.length ? e.lines.map((l) => `- ${l}`).join('\n') : '-'
        // 页边一句话必须出现在导出里：它是用户自己写的，导出是「全量可带走」的承诺
        const margin = e.margin ? `\n> 页边：${e.margin.text}` : ''
        return `## ${e.date}\n\n${diary}${margin}`
      })
      .join('\n\n') +
    '\n'
  )
}

/** 空白日记的判断：模板可能给出通用句，真正的「没话说」由调用方决定不调用 */
export function isEmptyDiary(lines: string[]): boolean {
  return lines.every((l) => !l.trim())
}
