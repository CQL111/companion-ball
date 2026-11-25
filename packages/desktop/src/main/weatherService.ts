// weatherService.ts - 天气氛围（主进程侧）
// 数据源：Open-Meteo（免费、无需 API Key，因此没有可泄露的凭据）。
// 隐私：只发送城市经纬度；不发送任何设备标识或用户内容。
// 默认关闭，用户主动开启并在设置里填城市。

import { net } from 'electron'
import {
  WEATHER_TTL_MS,
  isValidPlace,
  kindOfCode,
  pickWeatherLine,
  shouldMentionWeather,
  type WeatherKind,
  type WeatherPlace,
  type WeatherSnapshot,
} from '../core/weather'
import { logger } from './services/logger'
import { store } from './store'
import { windows } from './state'

export interface WeatherSettings {
  enabled: boolean
  place: WeatherPlace | null
}

export function weatherSettings(): WeatherSettings {
  const raw = store.get('weather') as WeatherSettings | undefined
  const place = raw && isValidPlace(raw.place) ? raw.place : null
  return { enabled: raw?.enabled === true && !!place, place }
}

export function setWeatherSettings(next: Partial<WeatherSettings>): WeatherSettings {
  const prev = weatherSettings()
  const merged = { ...prev, ...next }
  const place = merged.place && isValidPlace(merged.place) ? merged.place : null
  store.set('weather', { enabled: merged.enabled === true && !!place, place })
  return weatherSettings()
}

let cache: { at: number; snapshot: WeatherSnapshot } | null = null
let lastMentionAt = 0

/** 城市名 → 经纬度（Open-Meteo 的地理编码接口，同样无需 Key） */
export async function lookupCity(name: string): Promise<WeatherPlace | null> {
  const q = String(name || '').trim()
  if (!q) return null
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=zh&format=json`
  try {
    const res = await net.fetch(url, { method: 'GET' })
    if (!res.ok) return null
    const json = (await res.json()) as { results?: Array<Record<string, unknown>> }
    const first = json.results?.[0]
    if (!first) return null
    const candidate: WeatherPlace = {
      city: q,
      label: [first.name, first.admin1, first.country].filter(Boolean).join('，'),
      latitude: Number(first.latitude),
      longitude: Number(first.longitude),
    }
    return isValidPlace(candidate) ? candidate : null
  } catch (e) {
    logger.warn('weather.lookup', `failed: ${(e as Error).message}`)
    return null
  }
}

/** 拉取当前天气（带 30 分钟缓存） */
export async function fetchWeather(force = false): Promise<WeatherSnapshot | null> {
  const { enabled, place } = weatherSettings()
  if (!enabled || !place) return null
  const now = Date.now()
  if (!force && cache && now - cache.at < WEATHER_TTL_MS) return cache.snapshot

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&current=weather_code,is_day&timezone=auto`
  try {
    const res = await net.fetch(url, { method: 'GET' })
    if (!res.ok) return null
    const json = (await res.json()) as {
      current?: { weather_code?: number; is_day?: number; time?: string }
    }
    const cur = json.current
    if (!cur || typeof cur.weather_code !== 'number') return null
    const snapshot: WeatherSnapshot = {
      kind: kindOfCode(cur.weather_code),
      isDay: cur.is_day === 1,
      observedAt: cur.time || new Date(now).toISOString(),
    }
    cache = { at: now, snapshot }
    logger.info('weather.fetch', `${snapshot.kind} day=${snapshot.isDay}`)
    return snapshot
  } catch (e) {
    logger.warn('weather.fetch', `failed: ${(e as Error).message}`)
    return null
  }
}

/**
 * 天气变化时让角色说一句。
 * 只在「下雨 / 下雪 / 雷暴」且 3 小时没说过时说——纯氛围，不播报数据。
 */
export async function maybeMentionWeather(): Promise<void> {
  if (!weatherSettings().enabled) return
  const prev = cache?.snapshot?.kind ?? null
  const next = await fetchWeather()
  if (!next) return
  const now = Date.now()
  if (!shouldMentionWeather(prev, next.kind, now, lastMentionAt)) return
  lastMentionAt = now
  const line = pickWeatherLine(next.kind, next.isDay)
  if (!line) return
  if (windows.ball && !windows.ball.isDestroyed()) {
    windows.ball.webContents.send('weather-changed', { kind: next.kind, isDay: next.isDay, text: line })
  }
  logger.info('weather.mention', next.kind)
}

/** 启动轮询：开启后才跑，每 30 分钟看一次 */
let timer: NodeJS.Timeout | null = null
export function startWeatherWatcher(): void {
  if (timer) return
  if (!weatherSettings().enabled) return
  logger.info('weather.watcher', 'started')
  void maybeMentionWeather()
  timer = setInterval(() => void maybeMentionWeather(), WEATHER_TTL_MS)
}

export function stopWeatherWatcher(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** 设置变更后需要重启轮询 */
export function restartWeatherWatcher(): void {
  stopWeatherWatcher()
  cache = null
  startWeatherWatcher()
}

export function currentWeatherSnapshot(): WeatherSnapshot | null {
  return cache?.snapshot ?? null
}

export function weatherKind(): WeatherKind | null {
  return cache?.snapshot.kind ?? null
}
