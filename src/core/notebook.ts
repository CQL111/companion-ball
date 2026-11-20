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
  /** 素材来源，便于将来调试与「为什么写这句」 */
  source: 'template'
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
 */
export function upsertDiary(notebook: Notebook, now: number, lines: string[]): Notebook {
  const date = dateKey(now)
  const createdAt = new Date(now).toISOString()
  const entries = notebook.entries.filter((e) => e.date !== date)
  // 空白日记不落盘：没有话说就不留痕（避免制造「今天没记录」的压力）
  if (lines.length) entries.push({ date, createdAt, lines, source: 'template' })
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  return { version: 1, entries: entries.slice(0, MAX_ENTRIES) }
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
      .map((e) => `## ${e.date}\n\n${e.lines.map((l) => `- ${l}`).join('\n')}`)
      .join('\n\n') +
    '\n'
  )
}

/** 空白日记的判断：模板可能给出通用句，真正的「没话说」由调用方决定不调用 */
export function isEmptyDiary(lines: string[]): boolean {
  return lines.every((l) => !l.trim())
}
