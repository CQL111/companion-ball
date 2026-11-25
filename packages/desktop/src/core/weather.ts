// weather.ts - 天气氛围（领域层，零平台依赖）
// 只做「天气代码 → 氛围」的映射，不发起任何网络请求。
//
// 产品原则（docs/ROADMAP.md S4）：
//   - 纯氛围，不播报：不显示温度、不报「今天 10℃」
//   - 默认关闭，用户主动开启并填写城市
//   - 只到城市级别，不采集精确位置

export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'snow' | 'storm' | 'fog'

export interface WeatherSnapshot {
  kind: WeatherKind
  /** 白天 / 夜晚；夜晚的氛围文案不同 */
  isDay: boolean
  /** 观测时间（本地 ISO），仅本地保存，不上报 */
  observedAt: string
}

/**
 * WMO 天气代码 → 氛围类型。
 * 参考 open-meteo 文档的 WMO Weather interpretation codes。
 */
export function kindOfCode(code: number): WeatherKind {
  // WMO 代码只有 0–99，越界说明数据异常——按多云处理，不猜成雷暴
  if (!Number.isFinite(code) || code < 0 || code > 99) return 'cloudy'
  if (code === 0) return 'clear'
  if (code <= 3) return 'cloudy'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 67) return 'rain'
  if (code >= 71 && code <= 77) return 'snow'
  if (code >= 80 && code <= 82) return 'rain'
  if (code === 85 || code === 86) return 'snow'
  if (code >= 95) return 'storm'
  return 'cloudy'
}

/** 每种天气对应的氛围台词（说感受，不报数据） */
export const WEATHER_LINES: Record<WeatherKind, { day: string[]; night: string[] }> = {
  clear: {
    day: ['外面太阳挺好的。', '光线暖洋洋的。', '这种天气适合发呆。'],
    night: ['今晚星星应该不少。', '外面很安静，天黑透了。'],
  },
  cloudy: {
    day: ['今天有点灰。', '云压得有点低。', '光线软软的。'],
    night: ['外面的云把月亮挡住了。', '今晚看不见星星。'],
  },
  rain: {
    day: ['外面在下雨。', '雨声挺好听的。', '我趴在窗边看雨。', '记得带伞。'],
    night: ['夜里在下雨。', '雨声一直没停。', '这种晚上适合待着。'],
  },
  snow: {
    day: ['外面在下雪。', '雪落得很慢。', '好安静。'],
    night: ['外面在下雪，很静。', '夜里下雪了。'],
  },
  storm: {
    day: ['外面风很大。', '今天的雨有点凶。', '我被雷声吓了一跳。'],
    night: ['打雷了。', '外面的风很响。'],
  },
  fog: {
    day: ['外面起雾了。', '看不清远处。'],
    night: ['雾很重，路灯都糊了。'],
  },
}

/**
 * 天气对情绪的影响：很轻微，只影响「基础情绪」的倾向，不覆盖用户交互。
 * 返回 null 表示无倾向。
 */
export function moodBias(kind: WeatherKind, isDay: boolean): 'doze' | 'neutral' | 'smile' | null {
  if (kind === 'rain' || kind === 'snow' || kind === 'fog') return 'doze' // 安静，想趴着
  if (kind === 'storm') return 'neutral'
  if (kind === 'clear' && isDay) return 'smile' // 晴天精神一点
  return null
}

/** 天气变化时是否值得说一句（避免每次刷新都说话） */
export function shouldMentionWeather(
  prev: WeatherKind | null,
  next: WeatherKind,
  now: number,
  lastMentionAt: number,
): boolean {
  if (prev === next) return false
  if (next !== 'rain' && next !== 'snow' && next !== 'storm') return false
  // 至少间隔 3 小时，且只在「值得提」的天气说出来。
  // 例外：这是本次启动后第一次知道天气（prev === null 且从未说过）时，允许立刻说。
  if (lastMentionAt === 0 && prev === null) return true
  const GAP = 3 * 60 * 60 * 1000
  return now - lastMentionAt >= GAP
}

/** 选一句天气台词（按种类与昼夜） */
export function pickWeatherLine(kind: WeatherKind, isDay: boolean, random: () => number = Math.random): string | null {
  const pool = isDay ? WEATHER_LINES[kind].day : WEATHER_LINES[kind].night
  if (!pool.length) return null
  return pool[Math.floor(random() * pool.length)] ?? null
}

export interface WeatherPlace {
  /** 用户输入的城市名（仅本地保存） */
  city: string
  /** 解析出的地名，用于界面回显 */
  label: string
  latitude: number
  longitude: number
}

/** 校验坐标是否合法（防止坏数据进入网络请求） */
export function isValidPlace(p: unknown): p is WeatherPlace {
  if (!p || typeof p !== 'object') return false
  const o = p as Partial<WeatherPlace>
  return (
    typeof o.latitude === 'number' &&
    typeof o.longitude === 'number' &&
    Number.isFinite(o.latitude) &&
    Number.isFinite(o.longitude) &&
    Math.abs(o.latitude) <= 90 &&
    Math.abs(o.longitude) <= 180 &&
    typeof o.label === 'string' &&
    o.label.length > 0
  )
}

/** 天气刷新间隔：30 分钟足够，不必更频繁 */
export const WEATHER_TTL_MS = 30 * 60 * 1000
