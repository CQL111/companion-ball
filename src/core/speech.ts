// speech.ts - 「它为什么开口」（领域层，零平台依赖）
//
// 问题：之前每次说话都是随机抽一句台词，用户听三天就知道底了，
// 因为「随机」本身是可感知的——一旦察觉，主动说话就变成噪音。
//
// 解法：**先有原因，再有台词**。
// 每次开口都必须产出一个 observation（它注意到了什么），
// 由 observation 决定台词组，并作为气泡里的第一句或附加信息。
//
// 例：
//   观察：你 37 分钟没动了
//   台词：tap 组 → 「肩膀放下来一点。」
//   合成：「你坐了一会儿了。」+「肩膀放下来一点。」

import type { PetMood } from './petState'
import type { LocoState } from './locomotion'
import type { QuipBucket } from './quips'
import type { NeedKind } from './needs'

/**
 * 它注意到的事。每一种都来自**真实状态**，不是随机。
 * 这是「可信的主动」与「随机打扰」的分界线。
 */
export type Observation =
  | { kind: 'idle-for'; minutes: number }
  | { kind: 'just-woke' }
  | { kind: 'late-night' }
  | { kind: 'user-back'; awayMinutes: number }
  | { kind: 'user-away-long'; awayMinutes: number }
  | { kind: 'sitting-long'; minutes: number }
  | { kind: 'weather'; weather: 'rain' | 'snow' | 'storm' }
  | { kind: 'need'; need: NeedKind }
  | { kind: 'morning-first' }
  | { kind: 'restless'; mood: PetMood }
  | { kind: 'none' }

/** 观察 → 台词组 */
export function bucketFor(obs: Observation): QuipBucket | null {
  switch (obs.kind) {
    case 'idle-for':
      return 'idle'
    case 'just-woke':
      return 'wake'
    case 'late-night':
      return 'night'
    case 'user-back':
    case 'user-away-long':
      return 'return'
    case 'sitting-long':
      return 'sitting'
    case 'weather':
      return null // 天气有自己的台词池（core/weather）
    case 'need':
      return null // 需求有自己的台词池（core/needs）
    case 'morning-first':
      return 'morning'
    case 'restless':
      return obs.mood === 'annoyed' ? 'annoyed' : obs.mood === 'sulk' ? 'return' : 'tap'
    case 'none':
      return null
  }
}

/**
 * 给一个观察配一句「它注意到的事」。
 * 这句话要短、具体、不卖惨；它证明猫在看你，而不是在自言自语。
 */
export function observationLine(obs: Observation): string | null {
  switch (obs.kind) {
    case 'idle-for':
      if (obs.minutes >= 120) return '你好像忙了很久。'
      if (obs.minutes >= 40) return '你坐了好一会儿了。'
      return null
    case 'just-woke':
      return null // 唤醒台词本身就是反应，不需要额外一句
    case 'late-night':
      return null // 深夜不主动开口
    case 'user-back':
      return obs.awayMinutes >= 60 ? '你回来了。' : null
    case 'user-away-long':
      return null // 闷的时候不需要替自己解释
    case 'sitting-long':
      return `你坐了${obs.minutes}分钟。`
    case 'weather':
      return null
    case 'need':
      return null
    case 'morning-first':
      return null
    case 'restless':
      return null
    case 'none':
      return null
  }
}

export interface ComposedSpeech {
  /** 先说的观察（没有则为 null） */
  observation: string | null
  /** 后说的台词 */
  line: string
}

/** 把观察与台词拼成一段话；两者都有时用破折号分隔，避免读起来像两条消息 */
export function composeSpeech(obs: Observation, line: string | null): ComposedSpeech | null {
  if (!line) return null
  const observation = observationLine(obs)
  if (observation && observation !== line) return { observation, line }
  if (observation === line) return { observation: null, line }
  return { observation: null, line }
}

/** 拼成气泡文本 */
export function speechText(speech: ComposedSpeech): string {
  return speech.observation ? `${speech.observation}${speech.line}` : speech.line
}

/**
 * 决定此刻要不要主动说话，以及说什么。
 * 输入都是**真实状态**，不在这里抽随机——随机留给具体台词。
 *
 * 优先级（越靠前越「有理由」，越靠后越像打扰）：
 *   1. 用户回来（明确事件）
 *   2. 久坐（有具体依据）
 *   3. 需求（有诉求）
 *   4. 长时间未交互（弱理由，仅一次）
 */
export interface SpeakContext {
  now: number
  mood: PetMood
  loco: LocoState
  lastInteractAt: number
  awayMinutes?: number
  justReturned?: boolean
  sittingMinutes?: number
  weather?: 'rain' | 'snow' | 'storm'
  pendingNeed?: NeedKind | null
  /** 上一次主动说话的时间（用于「长时间未交互」只提一次） */
  lastSpokeAt: number
  speaking: boolean
}

export function chooseObservation(ctx: SpeakContext): Observation {
  const idleMinutes = Math.floor((ctx.now - ctx.lastInteractAt) / 60000)

  if (ctx.justReturned && ctx.awayMinutes && ctx.awayMinutes >= 30) {
    return { kind: 'user-back', awayMinutes: ctx.awayMinutes }
  }
  if (ctx.awayMinutes && ctx.awayMinutes >= 120) {
    return { kind: 'user-away-long', awayMinutes: ctx.awayMinutes }
  }
  if (ctx.sittingMinutes && ctx.sittingMinutes >= 50) {
    return { kind: 'sitting-long', minutes: ctx.sittingMinutes }
  }
  // 睡觉/打盹时，任何主动表达都暂停（既不说需求，也不说话）
  if (ctx.mood === 'sleep' || ctx.mood === 'doze') {
    return { kind: 'none' }
  }
  if (ctx.pendingNeed) {
    return { kind: 'need', need: ctx.pendingNeed }
  }
  // 长时间未交互：只在刚超过阈值的那一次提，之后不再重复（避免反复念叨）
  if (idleMinutes >= 45 && ctx.now - ctx.lastSpokeAt > 3 * 60 * 60 * 1000) {
    return { kind: 'idle-for', minutes: idleMinutes }
  }
  return { kind: 'none' }
}
