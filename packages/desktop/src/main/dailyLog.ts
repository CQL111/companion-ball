// dailyLog.ts - 日常记事的主进程编排（M7）
//
// 与 main/occasions.ts 的分工：
//   未来有日期的事 → occasions（T-1 / 当天 / T+1 的提醒节奏）
//   今天的带数量事实 → dailyLog（晚间复述一次，不追不评价）
//
// 三条硬规则（docs/PRODUCT-THESIS.md）：
//   1. 不维护总额：一旦有「今日合计」就会忍不住给建议
//   2. 不评价、不追问：不说「花得有点多」
//   3. 一天只复述一次，错过的那天不补

import * as daily from '../core/dailyLog'
import { logger } from './services/logger'
import { store } from './store'

/** 记一条「今天的事」。返回是否记下了。永不抛出。 */
export function rememberDaily(message: string, now = Date.now()): boolean {
  try {
    const text = daily.extractDailyNote(message, now)
    if (!text) return false

    const before = store.get('dailyNotes') || []
    const after = daily.addNote(before, text, { now })
    if (after.length === before.length && !after.some((n) => n.text === text)) return false
    if (after === before) return false

    store.set('dailyNotes', after)
    logger.info('daily.note', `recorded: ${text.slice(0, 30)}`)
    return true
  } catch (e) {
    logger.warn('daily.note', `failed: ${(e as Error).message}`)
    return false
  }
}

/**
 * 今晚该不该复述。
 * 返回 null 表示不说（太早 / 今天没记 / 已经说过了）。
 *
 * 注意：调用方负责占用打扰预算——这里只判断。
 */
export function peekRecap(now = Date.now()): string | null {
  try {
    const notes = store.get('dailyNotes') || []
    const lastRecapDay = String(store.get('lastRecapDay') || '')
    if (!daily.needsRecap(notes, lastRecapDay, now)) return null
    return daily.buildRecap(notes, now)
  } catch (e) {
    logger.warn('daily.recap', `failed: ${(e as Error).message}`)
    return null
  }
}

/** 复述说出口后调用：标记今天已复述。 */
export function markRecapped(now = Date.now()): void {
  store.set('lastRecapDay', daily.localDay(now))
  logger.info('daily.recap', 'done')
}

/** 今天的记录（笔记本展示用） */
export function todayNotes(now = Date.now()): daily.DailyNote[] {
  return daily.notesOfDay(store.get('dailyNotes') || [], now)
}

/** 最近几天的记录（按天分组，新的在前） */
export function recentNotes(now = Date.now()): Array<{ day: string; notes: daily.DailyNote[] }> {
  const all = store.get('dailyNotes') || []
  const byDay = new Map<string, daily.DailyNote[]>()
  for (const n of all) {
    const list = byDay.get(n.day) ?? []
    list.push(n)
    byDay.set(n.day, list)
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, notes]) => ({ day, notes: notes.sort((a, b) => a.at - b.at) }))
}

export function removeNote(id: string): boolean {
  const before = store.get('dailyNotes') || []
  const after = before.filter((n) => n.id !== id)
  if (after.length === before.length) return false
  store.set('dailyNotes', after)
  return true
}
