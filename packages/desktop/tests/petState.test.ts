// tests/petState.test.ts - 情绪状态机单测（纯 node，可注入时间）
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPTIONS,
  dateKey,
  idleMood,
  initPetState,
  persistableState,
  reducePetState,
  type PetState,
} from '@core/petState'

const T0 = new Date('2026-11-20T14:00:00').getTime() // 本地下午 2 点
const NINE_AM = new Date('2026-11-20T09:00:00').getTime()
const THREE_AM = new Date('2026-11-20T03:00:00').getTime()
const MIN = 60 * 1000

function fresh(now = T0): PetState {
  return initPetState(now)
}

describe('idleMood', () => {
  it('刚交互过 → neutral（白天）', () => {
    expect(idleMood(fresh(T0), T0)).toBe('neutral')
  })
  it('30 分钟无交互 → doze', () => {
    expect(idleMood(fresh(T0), T0 + DEFAULT_OPTIONS.napAfterMs)).toBe('doze')
  })
  it('60 分钟无交互 → sleep', () => {
    expect(idleMood(fresh(T0), T0 + DEFAULT_OPTIONS.sleepAfterMs)).toBe('sleep')
  })
  it('凌晨即便刚交互也半睡', () => {
    expect(idleMood(fresh(THREE_AM), THREE_AM)).toBe('doze')
  })
})

describe('click 触发', () => {
  it('普通点击 → smile + tap', () => {
    const r = reducePetState(fresh(T0), { type: 'click', now: T0 })
    expect(r.state.mood).toBe('smile')
    expect(r.trigger).toBe('tap')
  })

  it('早间第一次点击 → morning，且当天只问候一次', () => {
    const r1 = reducePetState(fresh(NINE_AM), { type: 'click', now: NINE_AM })
    expect(r1.trigger).toBe('morning')
    expect(r1.state.lastGreetDate).toBe(dateKey(NINE_AM))

    const r2 = reducePetState(r1.state, { type: 'click', now: NINE_AM + 5 * MIN })
    expect(r2.trigger).toBe('tap')
  })

  it('10 秒内连点 5 次 → annoyed', () => {
    let s = fresh(T0)
    let trigger: string | undefined
    for (let i = 0; i < 5; i++) {
      const r = reducePetState(s, { type: 'click', now: T0 + i * 500 })
      s = r.state
      trigger = r.trigger
    }
    expect(trigger).toBe('annoyed')
    expect(s.mood).toBe('annoyed')
    expect(s.clicks).toEqual([]) // 判定后清零，避免持续烦
  })

  it('不耐烦期间继续点击保持不耐烦，且不重复触发', () => {
    let s = fresh(T0)
    for (let i = 0; i < 5; i++) s = reducePetState(s, { type: 'click', now: T0 + i * 500 }).state
    expect(s.mood).toBe('annoyed')
    const again = reducePetState(s, { type: 'click', now: T0 + 2600 })
    expect(again.state.mood).toBe('annoyed')
    expect(again.trigger).toBeUndefined()
  })

  it('点击分散在 10 秒窗口外不算连点', () => {
    let s = fresh(T0)
    for (let i = 0; i < 4; i++) {
      s = reducePetState(s, { type: 'click', now: T0 + i * 11 * 1000 }).state
    }
    const r = reducePetState(s, { type: 'click', now: T0 + 60 * 1000 })
    expect(r.trigger).toBe('tap')
  })
})

describe('临时情绪与 tick', () => {
  it('smile 在 3 秒内保持，之后回到 neutral', () => {
    const r = reducePetState(fresh(T0), { type: 'click', now: T0 })
    const stillSmile = reducePetState(r.state, { type: 'tick', now: T0 + 1000 })
    expect(stillSmile.state.mood).toBe('smile')
    const back = reducePetState(r.state, { type: 'tick', now: T0 + 5000 })
    expect(back.state.mood).toBe('neutral')
  })

  it('tick 不产生触发（S1 不主动出声）', () => {
    const r = reducePetState(fresh(T0), { type: 'tick', now: T0 + 5 * MIN })
    expect(r.trigger).toBeUndefined()
  })

  it('久无交互后 tick → doze → sleep', () => {
    const r1 = reducePetState(fresh(T0), { type: 'tick', now: T0 + DEFAULT_OPTIONS.napAfterMs + 1000 })
    expect(r1.state.mood).toBe('doze')
    const r2 = reducePetState(r1.state, { type: 'tick', now: T0 + DEFAULT_OPTIONS.sleepAfterMs + 1000 })
    expect(r2.state.mood).toBe('sleep')
  })
})

describe('唤醒与拖动', () => {
  it('睡着时指针进入 → curious + wake', () => {
    const sleeping: PetState = { ...fresh(T0 - DEFAULT_OPTIONS.sleepAfterMs), mood: 'sleep' }
    const r = reducePetState(sleeping, { type: 'pointer-enter', now: T0 })
    expect(r.state.mood).toBe('curious')
    expect(r.trigger).toBe('wake')
  })

  it('醒着时指针进入 → curious 但无 wake 触发', () => {
    const r = reducePetState(fresh(T0), { type: 'pointer-enter', now: T0 })
    expect(r.state.mood).toBe('curious')
    expect(r.trigger).toBeUndefined()
  })

  it('拖动中保持 curious，甩放 → dizzy', () => {
    const start = reducePetState(fresh(T0), { type: 'drag-start', now: T0 })
    expect(start.state.dragging).toBe(true)
    expect(start.state.mood).toBe('curious')

    const flung = reducePetState(start.state, { type: 'drag-end', now: T0 + 800, flung: true })
    expect(flung.state.mood).toBe('dizzy')
    expect(flung.trigger).toBe('dizzy')
    expect(flung.state.dragging).toBe(false)
  })

  it('轻放不眩晕', () => {
    const start = reducePetState(fresh(T0), { type: 'drag-start', now: T0 })
    const gentle = reducePetState(start.state, { type: 'drag-end', now: T0 + 3000, flung: false })
    expect(gentle.state.mood).toBe('curious')
    expect(gentle.trigger).toBeUndefined()
  })
})

describe('离开 / 回来（S4 修复）', () => {
  it('离开时猫自己待着，不主动出声', () => {
    const r = reducePetState(fresh(T0), { type: 'away', now: T0, awayMs: 0 })
    expect(r.state.mood).toBe('doze')
    expect(r.trigger).toBeUndefined()
  })

  it('离开很久再回来 → sulk，并触发 return 台词', () => {
    const r = reducePetState(fresh(T0), { type: 'returned', now: T0, awayMs: 3 * 60 * MIN })
    expect(r.state.mood).toBe('sulk')
    expect(r.trigger).toBe('return')
  })

  it('短时间回来 → curious，也触发 return 台词', () => {
    const r = reducePetState(fresh(T0), { type: 'returned', now: T0, awayMs: 5 * MIN })
    expect(r.state.mood).toBe('curious')
    expect(r.trigger).toBe('return')
  })

  // 回归：睡眠 3 小时回来，lastInteractAt 若停在旧值，
  // 下一秒 tick 的 idleMood 看到「60 分钟没交互」会判 sleep，
  // sulk 连一秒都撑不到——用户看到的不是「闷」，而是直接又睡着了。
  it('长时间回来后的下一 tick 不会立刻睡着', () => {
    const back = reducePetState(fresh(T0), { type: 'returned', now: T0, awayMs: 3 * 60 * MIN })
    expect(back.state.mood).toBe('sulk')
    const next = reducePetState(back.state, { type: 'tick', now: T0 + 1000 })
    expect(next.state.mood).toBe('sulk')
  })

  // 短离开不碰 lastInteractAt：它本来就该按真实空闲继续走。
  it('短时间回来保留真实空闲（不会被伪造为刚交互）', () => {
    const base = fresh(T0)
    const r = reducePetState(base, { type: 'returned', now: T0 + 5 * MIN, awayMs: 5 * MIN })
    expect(r.state.lastInteractAt).toBe(base.lastInteractAt)
  })
})

describe('持久化', () => {
  it('只持久化 lastInteractAt 与 lastGreetDate', () => {
    const s = reducePetState(fresh(NINE_AM), { type: 'click', now: NINE_AM }).state
    const p = persistableState(s)
    expect(Object.keys(p).sort()).toEqual(['lastGreetDate', 'lastInteractAt'])
  })

  it('不修改入参（纯函数）', () => {
    const s = fresh(T0)
    const snapshot = JSON.stringify(s)
    reducePetState(s, { type: 'click', now: T0 })
    expect(JSON.stringify(s)).toBe(snapshot)
  })
})
