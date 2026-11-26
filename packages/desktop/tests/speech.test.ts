// tests/speech.test.ts - 「它为什么开口」单测
import { describe, expect, it } from 'vitest'
import {
  RETURN_GREET_MIN_MS,
  bucketFor,
  chooseObservation,
  composeSpeech,
  observationLine,
  speechText,
  type SpeakContext,
} from '@core/speech'

const MIN = 60 * 1000
const T0 = new Date('2026-11-20T14:00:00').getTime()

function ctx(patch: Partial<SpeakContext> = {}): SpeakContext {
  return {
    now: T0,
    mood: 'neutral',
    loco: 'idle',
    lastInteractAt: T0,
    lastSpokeAt: 0,
    speaking: false,
    ...patch,
  }
}

describe('观察优先级', () => {
  it('用户回来优先于其他一切', () => {
    const obs = chooseObservation(ctx({ justReturned: true, awayMinutes: 45, sittingMinutes: 90, pendingNeed: 'hungry' }))
    expect(obs.kind).toBe('user-back')
  })

  // 回归：短离开不该触发「回来」台词。否则 Win+L 一秒钟回来，
  // 它也会说一句「你回来了」——回来就从惊喜变成噪音。
  it('离开不到半小时回来 → 不说「回来」', () => {
    const obs = chooseObservation(ctx({ justReturned: true, awayMinutes: 10 }))
    expect(obs.kind).not.toBe('user-back')
  })

  it('刚好半小时回来 → 说「回来」', () => {
    expect(RETURN_GREET_MIN_MS).toBe(30 * 60 * 1000)
    const obs = chooseObservation(ctx({ justReturned: true, awayMinutes: 30 }))
    expect(obs.kind).toBe('user-back')
  })

  it('离开很久会独立成一种观察', () => {
    const obs = chooseObservation(ctx({ awayMinutes: 150 }))
    expect(obs.kind).toBe('user-away-long')
  })

  it('没有回来事件但久坐时，优先久坐', () => {
    const obs = chooseObservation(ctx({ sittingMinutes: 60 }))
    expect(obs.kind).toBe('sitting-long')
  })

  it('没有事件时有需求就提需求', () => {
    const obs = chooseObservation(ctx({ pendingNeed: 'lonely' }))
    expect(obs.kind).toBe('need')
  })

  it('睡觉时不主动说话', () => {
    expect(chooseObservation(ctx({ mood: 'sleep', pendingNeed: 'hungry' })).kind).toBe('none')
    expect(chooseObservation(ctx({ mood: 'doze' })).kind).toBe('none')
  })

  it('长时间未交互是弱理由，有节流', () => {
    const longIdle = ctx({ lastInteractAt: T0 - 60 * MIN, lastSpokeAt: 0 })
    expect(chooseObservation(longIdle).kind).toBe('idle-for')
    // 三小时内刚说过就不再提
    const recentlySpoke = ctx({ lastInteractAt: T0 - 60 * MIN, lastSpokeAt: T0 - 30 * MIN })
    expect(chooseObservation(recentlySpoke).kind).toBe('none')
  })
})

describe('观察 → 台词组', () => {
  it('久坐与长时间未交互各有专用台词组（不能拿无关台词硬拼）', () => {
    expect(bucketFor({ kind: 'sitting-long', minutes: 60 })).toBe('sitting')
    expect(bucketFor({ kind: 'idle-for', minutes: 50 })).toBe('idle')
  })
  it('回来走 return 组', () => {
    expect(bucketFor({ kind: 'user-back', awayMinutes: 40 })).toBe('return')
    expect(bucketFor({ kind: 'user-away-long', awayMinutes: 150 })).toBe('return')
  })
  it('天气与需求不占台词组（各有自己的池）', () => {
    expect(bucketFor({ kind: 'weather', weather: 'rain' })).toBeNull()
    expect(bucketFor({ kind: 'need', need: 'hungry' })).toBeNull()
  })
})

describe('合成一句话', () => {
  it('久坐会带上分钟数，读起来像「它注意到了」', () => {
    expect(observationLine({ kind: 'sitting-long', minutes: 62 })).toBe('你坐了62分钟。')
  })

  it('短时间离开不啰嗦', () => {
    expect(observationLine({ kind: 'user-back', awayMinutes: 35 })).toBeNull()
  })

  it('有观察 + 台词时用感叹号以外的连接，避免像两条消息', () => {
    const speech = composeSpeech({ kind: 'sitting-long', minutes: 60 }, '肩膀放下来一点。')
    expect(speechText(speech!)).toBe('你坐了60分钟。肩膀放下来一点。')
  })

  it('只有台词时不加前缀', () => {
    const speech = composeSpeech({ kind: 'user-back', awayMinutes: 20 }, '你回来了。')
    expect(speechText(speech!)).toBe('你回来了。')
  })

  it('没有台词返回 null（宁可沉默）', () => {
    expect(composeSpeech({ kind: 'none' }, null)).toBeNull()
  })

  it('观察与台词相同不重复', () => {
    const speech = composeSpeech({ kind: 'user-back', awayMinutes: 90 }, '你回来了。')
    expect(speechText(speech!)).toBe('你回来了。')
  })
})
