// margin.ts - 页边一句话的主进程编排（P2）
//
// 产品红线（docs/ROADMAP.md P2）：
//   1. 一页只有一行、非即时（没有回复通道）、不可公开
//   2. **猫可能回，也可能不回**——本文件里没有任何「生成回复」的代码，这是故意的
//   3. 永不进入任何出网通路：这里不 import 天气/许愿瓶/AI，只写本地 store
//
// 与笔记本文档的隔离：写进 DiaryEntry.margin，而不是 lines。
// 猫的日记每天会重算（upsertDiary），margin 由 core 层原样保留。

import * as notebook from '../core/notebook'
import { logger } from './services/logger'
import { getNotebook, setNotebook } from './store'

/**
 * 在某一页留一句话。返回写入后的那一页；null = 这句话不该被留下（空 / 全是空白）。
 * 永不抛出。
 */
export function writeMargin(date: string, text: string, now = Date.now()): notebook.DiaryEntry | null {
  try {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ''
    if (!day) return null

    const next = notebook.writeMargin(getNotebook(), day, text, now)
    if (!next) return null
    setNotebook(next)
    const entry = next.entries.find((e) => e.date === day) ?? null
    // 日志不记录正文——页边是用户最私密的东西
    logger.info('notebook.margin', `written on ${day} (${notebook.normalizeMargin(text)?.length ?? 0} chars)`)
    return entry
  } catch (e) {
    logger.warn('notebook.margin', `write failed: ${(e as Error).message}`)
    return null
  }
}

/** 抹掉某一页的页边话。返回是否删掉了。 */
export function eraseMargin(date: string): boolean {
  try {
    const next = notebook.eraseMargin(getNotebook(), date)
    if (!next) return false
    setNotebook(next)
    logger.info('notebook.margin', `erased on ${date}`)
    return true
  } catch (e) {
    logger.warn('notebook.margin', `erase failed: ${(e as Error).message}`)
    return false
  }
}

/**
 * 今日这一页有没有用户留下的页边话。
 *
 * 用途：给日记的「合写」留一个**可选**的入口——但 P2 阶段刻意不接自动回话。
 * 猫回不回是产品自由，不是工程义务；先让用户习惯落笔，再谈它怎么回应。
 */
export function hasMarginToday(now = Date.now()): boolean {
  const day = new Date(now)
  const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  return !!getNotebook().entries.find((e) => e.date === key)?.margin
}
