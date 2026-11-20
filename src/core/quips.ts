// quips.ts - 台词选择（领域层，零平台依赖）
// 职责：给定「触发 + 本地时间 + 已说过的台词」，挑一句没重复说过的话。
// 台词内容在 src/data/quips.json，不内嵌在代码里（手机端直接复用）。
//
// 规则（docs/ROADMAP.md 两条红线）：
// - 宁少勿滥：一行一句，禁止长句
// - 冷却：同一条台词在 cooldownMs 内不再出现；全体台词轮完一轮前不重复

import type { PetMood, PetTrigger } from './petState'

export type QuipBucket =
  | 'tap'
  | 'wake'
  | 'morning'
  | 'annoyed'
  | 'dizzy'
  | 'night'
  | 'drag'
  | 'pat'
  | 'grumble'
  | 'return'

export interface QuipDatabase {
  version: number
  lines: Record<QuipBucket, string[]>
  /** 未命中任何 bucket 时的兜底（避免说空话） */
  fallback: string[]
}

export interface QuipPickerOptions {
  /** 同一句在多久内不重复（默认 20 分钟） */
  cooldownMs?: number
  /** 随机源，便于测试注入（默认 Math.random） */
  random?: () => number
}

export interface QuipRecord {
  /** 上次说这句话的时间戳 */
  at: number
}

export type QuipHistory = Record<string, QuipRecord>

export const DEFAULT_COOLDOWN_MS = 20 * 60 * 1000
/** 历史只保留最近的若干条，避免无限增长 */
export const MAX_HISTORY = 200

/**
 * 选择 bucket：触发优先，其次按时段兜底。
 * 深夜（0–6 点）用户点了猫，给的是「夜聊」语气而不是白天问候。
 */
export function pickBucket(
  trigger: PetTrigger | undefined,
  now: number,
  dragging = false,
  forced?: QuipBucket,
): QuipBucket {
  if (forced) return forced
  if (dragging) return 'drag'
  if (trigger === 'morning') return 'morning'
  if (trigger === 'annoyed') return 'annoyed'
  if (trigger === 'dizzy') return 'dizzy'
  if (trigger === 'return') return 'return'
  const hour = new Date(now).getHours()
  if (hour < 6) return 'night'
  if (trigger === 'wake') return 'wake'
  return 'tap'
}

/**
 * 挑一句台词。返回 null 表示没有可用候选（调用方应保持安静）。
 * 选择策略：过滤冷却期内的 → 优先选「最久没说过」的 → 在其中随机取一句。
 */
export function pickQuip(
  db: QuipDatabase,
  bucket: QuipBucket,
  history: QuipHistory,
  now: number,
  opts: QuipPickerOptions = {},
): string | null {
  const cooldown = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const random = opts.random ?? Math.random

  const pool = (db.lines[bucket] || []).filter((line) => {
    const rec = history[line]
    return !rec || now - rec.at >= cooldown
  })
  const candidates = pool.length ? pool : db.lines[bucket] || []
  if (!candidates.length) {
    const fb = db.fallback || []
    return fb.length ? fb[Math.floor(random() * fb.length)] ?? null : null
  }

  // 最久没说过的那批（从未说过的视为最早）
  let oldest = Number.POSITIVE_INFINITY
  for (const line of candidates) {
    const at = history[line]?.at
    const score = at === undefined ? -1 : at
    if (score < oldest) oldest = score
  }
  const neverSaid = candidates.filter((l) => history[l] === undefined)
  const sameAge = neverSaid.length
    ? neverSaid
    : candidates.filter((l) => (history[l]?.at ?? -1) === oldest)
  const pick = sameAge[Math.floor(random() * sameAge.length)]
  return pick ?? null
}

/** 记录已说过的台词，并把历史裁剪到最近 MAX_HISTORY 条 */
export function rememberQuip(history: QuipHistory, line: string, now: number): QuipHistory {
  const next: QuipHistory = { ...history, [line]: { at: now } }
  const entries = Object.entries(next)
  if (entries.length <= MAX_HISTORY) return next
  entries.sort((a, b) => b[1].at - a[1].at)
  return Object.fromEntries(entries.slice(0, MAX_HISTORY))
}

/** 校验台词库结构，构建期/测试用 */
export function validateQuipDatabase(db: unknown): string[] {
  const errors: string[] = []
  if (!db || typeof db !== 'object') return ['台词库不是对象']
  const d = db as Partial<QuipDatabase>
  for (const key of ['tap', 'wake', 'morning', 'annoyed', 'dizzy', 'night', 'drag', 'pat', 'grumble', 'return'] as const) {
    const list = d.lines?.[key]
    if (!Array.isArray(list) || list.length === 0) errors.push(`lines.${key} 为空`)
    else if (list.some((l) => typeof l !== 'string' || !l.trim())) errors.push(`lines.${key} 含空台词`)
  }
  if (!Array.isArray(d.fallback) || d.fallback.length === 0) errors.push('fallback 为空')
  return errors
}

/** mood → 可用 bucket 的映射说明（供文档与测试使用） */
export const MOOD_BUCKETS: Record<PetMood, QuipBucket[]> = {
  neutral: ['tap'],
  smile: ['tap', 'morning'],
  curious: ['wake', 'drag'],
  doze: ['night'],
  sleep: ['night'],
  annoyed: ['annoyed'],
  dizzy: ['dizzy'],
  sulk: ['return'],
}
