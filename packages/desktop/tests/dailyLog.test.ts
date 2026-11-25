// tests/dailyLog.test.ts - M7 日常记事
// 守四件事：只记带数量的今天的事、不维护总额、不评价、晚间只复述一次。

import { describe, expect, it } from 'vitest'
import {
  MAX_NOTES_PER_DAY,
  addNote,
  buildRecap,
  canRecap,
  extractDailyNote,
  localDay,
  needsRecap,
  notesOfDay,
  toRecapPhrase,
  type DailyNote,
} from '@core/dailyLog'

const NOW = new Date(2026, 10, 25, 20, 0, 0).getTime() // 晚上 8 点

describe('抽取：今天 + 数量', () => {
  it('「今天花了10块」被记下', () => {
    expect(extractDailyNote('今天花了10块', NOW)).toBe('今天花了10块')
  })

  it('「喝了3杯咖啡」被记下', () => {
    expect(extractDailyNote('喝了3杯咖啡', NOW)).toBe('喝了3杯咖啡')
  })

  it('「跑了5公里」被记下', () => {
    expect(extractDailyNote('跑了5公里', NOW)).toBe('跑了5公里')
  })

  it('中文数字也认', () => {
    expect(extractDailyNote('今天买了三样东西', NOW)).not.toBeNull()
  })

  it('没有数量的不说（「今天好累」不是记事）', () => {
    expect(extractDailyNote('今天好累', NOW)).toBeNull()
  })

  it('未来的事不在这里记（交给事件记忆）', () => {
    expect(extractDailyNote('明天花10块买咖啡', NOW)).toBeNull()
    expect(extractDailyNote('下周要买3本书', NOW)).toBeNull()
  })

  it('没动词也没「今天」的不记（避免闲聊被当账目）', () => {
    // 有数量但无动词、无「今天」→ 不记（可能是泛指）
    expect(extractDailyNote('我买了机票', NOW)).toBeNull()
    expect(extractDailyNote('三个朋友', NOW)).toBeNull()
    // 有「今天」+ 数量 → 记
    expect(extractDailyNote('今天三个朋友来找我', NOW)).toBe('今天三个朋友来找我')
  })

  it('只取第一句，不抄整段', () => {
    const r = extractDailyNote('今天花了10块。然后我去睡觉了，还做了个梦。', NOW)
    expect(r).toBe('今天花了10块')
  })

  it('超长输入不记', () => {
    expect(extractDailyNote('花了10块'.repeat(30), NOW)).toBeNull()
  })
})

describe('存储：一天、去重、上限', () => {
  it('记录带本地日期', () => {
    const list = addNote([], '今天花了10块', { now: NOW })
    expect(list[0]!.day).toBe(localDay(NOW))
  })

  it('同一天重复说同一句不重复记', () => {
    let list = addNote([], '今天花了10块', { now: NOW })
    list = addNote(list, '今天花了10块', { now: NOW + 1000 })
    expect(list.length).toBe(1)
  })

  it('不同的话都记', () => {
    let list = addNote([], '今天花了10块', { now: NOW })
    list = addNote(list, '喝了3杯咖啡', { now: NOW + 1000 })
    expect(list.length).toBe(2)
  })

  it(`一天最多 ${MAX_NOTES_PER_DAY} 条`, () => {
    let list: DailyNote[] = []
    for (let i = 0; i < MAX_NOTES_PER_DAY + 5; i++) {
      list = addNote(list, `今天花了${i + 1}块`, { now: NOW + i })
    }
    expect(list.length).toBe(MAX_NOTES_PER_DAY)
  })

  it('只保留最近 7 天', () => {
    const old = NOW - 8 * 86400000
    let list = addNote([], '今天花了10块', { now: old })
    list = addNote(list, '今天花了20块', { now: NOW })
    expect(list.length).toBe(1)
    expect(list[0]!.day).toBe(localDay(NOW))
  })

  it('按天取出并保持时间顺序', () => {
    let list = addNote([], '今天花了10块', { now: NOW })
    list = addNote(list, '喝了3杯', { now: NOW + 2000 })
    const today = notesOfDay(list, NOW)
    expect(today.map((n) => n.text)).toEqual(['今天花了10块', '喝了3杯'])
  })
})

describe('晚间复述', () => {
  it('18 点前不复述', () => {
    const morning = new Date(2026, 10, 25, 10, 0, 0).getTime()
    expect(canRecap(morning)).toBe(false)
    expect(canRecap(NOW)).toBe(true)
  })

  it('一天只复述一次', () => {
    const list = addNote([], '今天花了10块', { now: NOW })
    expect(needsRecap(list, '', NOW)).toBe(true)
    expect(needsRecap(list, localDay(NOW), NOW)).toBe(false)
  })

  it('没记录那天不复述（允许空白）', () => {
    expect(needsRecap([], '', NOW)).toBe(false)
  })

  it('复述用用户自己的说法，去掉「今天」', () => {
    expect(toRecapPhrase('今天花了10块')).toBe('花了10块')
    expect(toRecapPhrase('我买了3本书')).toBe('买了3本书')
  })

  it('一条时句子通顺', () => {
    const list = addNote([], '今天花了10块', { now: NOW })
    expect(buildRecap(list, NOW)).toBe('今天你说花了10块。')
  })

  it('两条时串成一句', () => {
    let list = addNote([], '今天花了10块', { now: NOW })
    list = addNote(list, '喝了3杯咖啡', { now: NOW + 1000 })
    expect(buildRecap(list, NOW)).toBe('今天你说花了10块。还说你喝了3杯咖啡。')
  })

  it('最多复述两条（多了变流水账）', () => {
    let list = addNote([], '今天花了10块', { now: NOW })
    list = addNote(list, '喝了3杯咖啡', { now: NOW + 1000 })
    list = addNote(list, '跑了5公里', { now: NOW + 2000 })
    const recap = buildRecap(list, NOW)!
    expect(recap).toContain('花了10块')
    expect(recap).toContain('喝了3杯')
    expect(recap).not.toContain('跑了5公里')
  })

  it('复述不出现总额、不评价', () => {
    let list = addNote([], '今天花了10块', { now: NOW })
    list = addNote(list, '喝了3杯咖啡', { now: NOW + 1000 })
    const recap = buildRecap(list, NOW)!
    // 不出现「一共」「合计」「总共」
    expect(recap).not.toMatch(/一共|合计|总共|累计|总计/)
    // 不出现评价
    expect(recap).not.toMatch(/有点多|太多了|要注意|节省|省点/)
  })

  it('当天没记录时返回 null', () => {
    expect(buildRecap([], NOW)).toBeNull()
  })
})
