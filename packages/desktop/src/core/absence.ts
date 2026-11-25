// absence.ts - 缺席日志（领域层，零平台依赖）
//
// P1 的核心判断（docs/PRODUCT-THESIS.md 第四节）：
//   所有 AI 陪伴产品都在优化「你在的时候」（聊天）；
//   只有桌面端能优化「你不在的时候」。
//
// 三条硬规则：
//   1. **确定性**：同一段缺席永远生成同一句话。笔记本每次打开都变，就不像日记了。
//      所以随机源是「缺席开始时间 + 时长档位」的哈希，不是 Math.random()。
//   2. **允许空白**：不是每次缺席都有话说。白天离开两小时，不需要台词。
//   3. **不说数字**：不写「你离开 9 小时 23 分」，写「你走了很久」。
//
// 素材 = 时长档 × 回来时的时段 × 天气 × 季节。全部本地生成，零 token。

export type AbsenceBucket = 'short' | 'overnight' | 'long' | 'very-long'

/** 回来时的时段 */
export type ReturnTime = 'dawn' | 'morning' | 'afternoon' | 'evening' | 'night'

export type Season = 'spring' | 'summer' | 'autumn' | 'winter'

/** 天气只取「有氛围」的几种；clear/cloudy 不参与，避免每次天晴都写一句 */
export type AbsenceWeather = 'rain' | 'snow' | 'storm' | 'fog' | 'none'

/** 少于这个时长不写：短暂离开是常态，写成日记会很吵 */
export const ABSENCE_MIN_MS = 8 * 60 * 60 * 1000
/** 超过这个时长，「很久」的写法才成立 */
export const ABSENCE_LONG_MS = 24 * 60 * 60 * 1000
/** 超过这个时长，按「好几天」处理 */
export const ABSENCE_VERY_LONG_MS = 3 * 24 * 60 * 60 * 1000

export interface AbsenceInput {
  /** 离开的时间（毫秒时间戳） */
  awayStart: number
  /** 回来的时间 */
  awayEnd: number
  /** 回来时的天气 */
  weather?: AbsenceWeather
  /** 用于确定性抽样；默认用 awayStart */
  seed?: number
}

export interface AbsenceRecord {
  bucket: AbsenceBucket
  returnTime: ReturnTime
  /** 离开跨过的天数（0 = 当天离开当天回） */
  nights: number
}

// ---------- 判定 ----------

export function bucketOf(awayMs: number): AbsenceBucket {
  if (awayMs >= ABSENCE_VERY_LONG_MS) return 'very-long'
  if (awayMs >= ABSENCE_LONG_MS) return 'long'
  // 8–24 小时：多半是「晚上走了，第二天回来」
  return 'overnight'
}

export function returnTimeOf(now: number): ReturnTime {
  const h = new Date(now).getHours()
  if (h < 6) return 'dawn'
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  if (h < 23) return 'evening'
  return 'night'
}

export function seasonOf(now: number): Season {
  const m = new Date(now).getMonth() // 0–11
  if (m >= 2 && m <= 4) return 'spring'
  if (m >= 5 && m <= 7) return 'summer'
  if (m >= 8 && m <= 10) return 'autumn'
  return 'winter'
}

/** 跨过几个夜晚：用「离开日的次日」到「回来日」之间的天数 */
export function nightsBetween(start: number, end: number): number {
  const a = new Date(start)
  const b = new Date(end)
  const dayA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  const dayB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.max(0, Math.round((dayB - dayA) / 86400000) - 1)
}

export function describeAbsence(input: AbsenceInput): AbsenceRecord {
  const awayMs = Math.max(0, input.awayEnd - input.awayStart)
  return {
    bucket: bucketOf(awayMs),
    returnTime: returnTimeOf(input.awayEnd),
    nights: nightsBetween(input.awayStart, input.awayEnd),
  }
}

// ---------- 确定性随机 ----------

/** 32 位整数哈希（FNV-1a 变体），保证同输入同输出 */
function hash(n: number): number {
  let x = n | 0
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  x = x ^ (x >>> 16)
  return x >>> 0
}

function pick<T>(arr: readonly T[], seed: number): T {
  return arr[hash(seed) % arr.length]!
}

// ---------- 台词素材 ----------
// 原则：说感受，不说数据；不制造愧疚；第一人称

/** 回来时的第一句：按时段 */
const RETURN_LINES: Record<ReturnTime, readonly string[]> = {
  dawn: ['天还没亮你就回来了。我一直醒着。', '这个点回来，是被什么吵醒了吗。'],
  morning: ['早上好。我等你等了一整夜。', '你回来了，光刚好照到桌角。'],
  afternoon: ['下午了。我睡了很久，醒了好几次。', '你不在的时候，我数了会儿窗外的影子。'],
  evening: ['你回来了。天快黑了。', '傍晚了，我一直在桌上。'],
  night: ['这么晚才回来。', '你回来了。夜里的屋子很安静。'],
}

/** 按缺席档位的补充句 */
const BUCKET_LINES: Record<AbsenceBucket, readonly string[]> = {
  overnight: [
    '你走后我一直趴着，没怎么动。',
    '夜里有点凉，我把尾巴收起来了。',
    '房间安静了很久。我听了会儿风扇的声音。',
  ],
  long: [
    '你走了很久。我以为你今天不会回来了。',
    '我睡了又醒，醒着又睡。桌子一直没变。',
    '好久没听见你的声音了。',
  ],
  'very-long': [
    '你走了好几天。我有点忘了你上次说话是什么时候。',
    '这些天我一直在等。桌角的位置我没动过。',
  ],
  short: [],
}

/** 天气：同一场雨原则——它和你经历的是同一件事 */
const WEATHER_LINES: Record<Exclude<AbsenceWeather, 'none'>, readonly string[]> = {
  rain: ['外面一直在下雨。我趴在窗口看了一会儿，雨没停。', '下雨了。我听着雨声，等你。'],
  snow: ['下雪了。窗户上结了薄薄一层白。', '外面下雪了，屋里很静。'],
  storm: ['打雷了，我在桌角缩成一团。', '外面刮风下雨，我把耳朵压下来了。'],
  fog: ['外面起了雾。看不太清远处。', '雾很大。我盯着窗口看了很久。'],
}

/** 季节：只在没天气时补一句，避免堆叠 */
const SEASON_LINES: Record<Season, readonly string[]> = {
  spring: ['春天了。窗外的树在动。'],
  summer: ['夏天。屋里有点闷，我摊在桌角。'],
  autumn: ['秋天了。光变得很软。'],
  winter: ['冬天。桌子有点凉。'],
}

// ---------- 生成 ----------

export interface AbsenceLinesOptions {
  input: AbsenceInput
  /** 用于确定性抽样；同一段缺席必须传同一个值（默认取 awayStart） */
  seed?: number
}

/**
 * 生成缺席日记行。
 * 返回空数组表示这段缺席不值得写——真日记允许空白。
 */
export function buildAbsenceLines({ input, seed }: AbsenceLinesOptions): string[] {
  const awayMs = input.awayEnd - input.awayStart
  // 太短不写
  if (awayMs < ABSENCE_MIN_MS) return []

  const rec = describeAbsence(input)
  const base = seed ?? input.awayStart
  const lines: string[] = []

  // 第一句永远有：你回来了
  lines.push(pick(RETURN_LINES[rec.returnTime], base + 1))

  // 第二句：缺席档位
  const bucketPool = BUCKET_LINES[rec.bucket]
  if (bucketPool.length) lines.push(pick(bucketPool, base + 2))

  // 第三句：天气优先，其次季节
  const w = input.weather ?? 'none'
  if (w !== 'none') {
    lines.push(pick(WEATHER_LINES[w], base + 3))
  } else {
    lines.push(pick(SEASON_LINES[seasonOf(input.awayEnd)], base + 4))
  }

  // 「好几天」再补一句，否则最多三句（日记 2–4 句的规矩）
  if (rec.bucket === 'very-long') {
    lines.push(pick(['不知道你在外面过得好不好。', '你回来就好。'], base + 5))
  }

  return lines.slice(0, 4)
}

/**
 * 这段缺席该不该写。
 * 明确暴露给调用方，避免各处的阈值判断不一致。
 */
export function shouldRecordAbsence(awayMs: number): boolean {
  return awayMs >= ABSENCE_MIN_MS
}
