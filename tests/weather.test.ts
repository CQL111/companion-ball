// tests/weather.test.ts - 天气氛围单测
import { describe, expect, it } from 'vitest'
import {
  isValidPlace,
  kindOfCode,
  moodBias,
  pickWeatherLine,
  shouldMentionWeather,
  WEATHER_LINES,
  type WeatherKind,
} from '@core/weather'

describe('WMO 代码映射', () => {
  it('晴天 / 多云 / 雾', () => {
    expect(kindOfCode(0)).toBe('clear')
    expect(kindOfCode(1)).toBe('cloudy')
    expect(kindOfCode(3)).toBe('cloudy')
    expect(kindOfCode(45)).toBe('fog')
    expect(kindOfCode(48)).toBe('fog')
  })

  it('雨（毛毛雨到暴雨）', () => {
    for (const c of [51, 55, 61, 65, 80, 82]) expect(kindOfCode(c)).toBe('rain')
  })

  it('雪与雷暴', () => {
    expect(kindOfCode(71)).toBe('snow')
    expect(kindOfCode(77)).toBe('snow')
    expect(kindOfCode(85)).toBe('snow')
    expect(kindOfCode(95)).toBe('storm')
    expect(kindOfCode(99)).toBe('storm')
  })

  it('未知代码退化为多云，不抛错', () => {
    expect(kindOfCode(12345)).toBe('cloudy')
  })
})

describe('情绪倾向', () => {
  it('下雨/下雪/起雾 → 安静想趴着', () => {
    expect(moodBias('rain', true)).toBe('doze')
    expect(moodBias('snow', false)).toBe('doze')
    expect(moodBias('fog', true)).toBe('doze')
  })

  it('晴天白天 → 精神一点；夜里不额外偏置', () => {
    expect(moodBias('clear', true)).toBe('smile')
    expect(moodBias('clear', false)).toBeNull()
  })

  it('雷暴 → 中性（不额外偏置）', () => {
    expect(moodBias('storm', true)).toBe('neutral')
  })
})

describe('何时提天气', () => {
  it('天气没变不说话', () => {
    expect(shouldMentionWeather('rain', 'rain', 0, 0)).toBe(false)
  })

  it('第一次遇到雨会说', () => {
    expect(shouldMentionWeather(null, 'rain', 0, 0)).toBe(true)
  })

  it('晴转多云不值得特意说', () => {
    expect(shouldMentionWeather('clear', 'cloudy', 0, 0)).toBe(false)
  })

  it('三小时内不重复说', () => {
    const now = 10 * 60 * 60 * 1000
    expect(shouldMentionWeather('clear', 'rain', now, now - 60 * 60 * 1000)).toBe(false)
    expect(shouldMentionWeather('clear', 'rain', now, now - 4 * 60 * 60 * 1000)).toBe(true)
  })
})

describe('台词', () => {
  it('每种天气都有昼夜两套台词', () => {
    for (const kind of Object.keys(WEATHER_LINES) as WeatherKind[]) {
      expect(WEATHER_LINES[kind].day.length).toBeGreaterThan(0)
      expect(WEATHER_LINES[kind].night.length).toBeGreaterThan(0)
    }
  })

  it('不说数据：台词里不出现温度与数字', () => {
    for (const kind of Object.keys(WEATHER_LINES) as WeatherKind[]) {
      for (const line of [...WEATHER_LINES[kind].day, ...WEATHER_LINES[kind].night]) {
        expect(line).not.toMatch(/\d/)
        expect(line.length).toBeLessThanOrEqual(20)
      }
    }
  })

  it('按昼夜选择不同台词池', () => {
    const day = pickWeatherLine('rain', true, () => 0)
    const night = pickWeatherLine('rain', false, () => 0)
    expect(WEATHER_LINES.rain.day).toContain(day!)
    expect(WEATHER_LINES.rain.night).toContain(night!)
  })
})

describe('坐标校验', () => {
  it('合法地点通过', () => {
    expect(isValidPlace({ city: '杭州', label: '杭州，浙江', latitude: 30.27, longitude: 120.15 })).toBe(true)
  })

  it('越界或缺失被拒绝', () => {
    expect(isValidPlace({ label: 'x', latitude: 91, longitude: 0 })).toBe(false)
    expect(isValidPlace({ label: 'x', latitude: 30, longitude: 181 })).toBe(false)
    expect(isValidPlace({ label: '', latitude: 30, longitude: 120 })).toBe(false)
    expect(isValidPlace({ label: 'x', latitude: Number.NaN, longitude: 120 })).toBe(false)
    expect(isValidPlace(null)).toBe(false)
  })
})
