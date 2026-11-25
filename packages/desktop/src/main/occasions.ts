// occasions.ts - 事件记忆的主进程编排（P1.5）
//
// 三层职责（docs/OCCASIONS.md 第二节）：
//   听懂 → 这里调用 core/occasions.extractOccasion（零 token 正则）
//   记住 → addOccasion / tickOccasions 落 store
//   接住 → nextBeat 产生一句，交给渲染端的「观察 → 台词」通道
//
// 原则：
//   - 抽取失败静默（不能影响对话）
//   - 不弹系统通知；所有「接住」都走气泡（3 秒自灭）
//   - 关闭开关即清空，并在日记里留一句说明

import * as occ from '../core/occasions'
import * as notebook from '../core/notebook'
import { dateKey } from '../core/petState'
import { logger } from './services/logger'
import {
  getNotebook,
  getOccasions,
  isOccasionsEnabled,
  setNotebook,
  setOccasions,
  setOccasionsEnabled,
} from './store'

/**
 * 从用户的一句话里抽事件记忆。返回抽到的条目（空数组 = 没抽到）。
 * 永不抛出。
 */
export function rememberFromMessage(message: string, now = Date.now()): occ.Occasion[] {
  try {
    if (!isOccasionsEnabled()) return []
    const hit = occ.extractOccasion(message, now)
    if (!hit) return []

    const before = getOccasions()
    const after = occ.addOccasion(before, hit, { now })
    // 没变化 = 重复，不写日记
    if (after.length === before.length) return []

    setOccasions(after)
    const added = after[after.length - 1]
    if (!added) return []

    // 隐式确认：写进当天日记，不弹窗
    writeDiaryLine(added, now)
    logger.info('occasion.extract', `added ${added.kind} on ${added.date}`)
    return [added]
  } catch (e) {
    logger.warn('occasion.extract', `failed: ${(e as Error).message}`)
    return []
  }
}

/** 把「我记住了这件事」写进当天日记（source 保持 absence 优先规则） */
function writeDiaryLine(o: occ.Occasion, now: number): void {
  try {
    const date = dateKey(now)
    const existing = getNotebook().entries.find((e) => e.date === date)
    const line = occ.diaryLineFor(o)
    // 已经写过同一句就不重复
    if (existing?.lines.includes(line)) return

    const lines = [...(existing?.lines ?? []), line].slice(-4)
    setNotebook(notebook.upsertDiary(getNotebook(), now, lines, existing?.source === 'absence' ? 'absence' : 'template'))
  } catch (e) {
    logger.warn('occasion.diary', `failed: ${(e as Error).message}`)
  }
}

/**
 * 每分钟评估一次：有没有该「接住」的事件。
 * 返回给渲染端的一句话（null = 现在没有）。
 *
 * 注意：这里只**判断**，不消费——调用方决定是否真的说出口（受打扰预算约束）。
 */
export function peekBeat(now = Date.now()): occ.OccasionPrompt | null {
  try {
    if (!isOccasionsEnabled()) return null
    const list = occ.tickOccasions(getOccasions(), now)
    setOccasions(list)
    return occ.nextBeat(list, now)
  } catch (e) {
    logger.warn('occasion.beat', `failed: ${(e as Error).message}`)
    return null
  }
}

/** 标记某个时机已经用掉（说出口之后调用） */
export function consumeBeat(prompt: occ.OccasionPrompt, now = Date.now()): void {
  try {
    setOccasions(occ.markBeat(getOccasions(), prompt.occasion.id, prompt.beat, now))
  } catch (e) {
    logger.warn('occasion.beat', `mark failed: ${(e as Error).message}`)
  }
}

/** 划掉一条（用户在日记里点一下） */
export function dismiss(id: string): boolean {
  const before = getOccasions()
  const after = occ.dismissOccasion(before, id)
  if (after === before) return false
  setOccasions(after)
  logger.info('occasion.dismiss', id)
  return true
}

/** 列表（设置面板与图片调试用），按日期升序 */
export function listOccasions(): occ.Occasion[] {
  return getOccasions()
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/**
 * 开关：关闭即清空所有条目，并在日记里留一句说明。
 * 打开不会恢复被清掉的内容（隐私优先）。
 */
export function setEnabled(enabled: boolean, now = Date.now()): void {
  setOccasionsEnabled(enabled)
  if (!enabled) {
    const had = getOccasions().length
    setOccasions([])
    if (had) {
      try {
        const date = dateKey(now)
        const existing = getNotebook().entries.find((e) => e.date === date)
        const lines = [...(existing?.lines ?? []), '我以后不记这些了。'].slice(-4)
        setNotebook(notebook.upsertDiary(getNotebook(), now, lines, 'template'))
      } catch {
        /* 日记写失败不影响关闭开关本身 */
      }
    }
    logger.info('occasion.toggle', `disabled, cleared ${had}`)
  } else {
    logger.info('occasion.toggle', 'enabled')
  }
}
