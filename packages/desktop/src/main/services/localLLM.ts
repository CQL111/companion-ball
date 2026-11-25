// localLLM.ts - 本地模型支持（Ollama）
// 用户本机装 Ollama + `ollama pull qwen2.5:7b`，App 通过 localhost:11434 调用
// 探测 + 缓存：本地可用 → 本地优先，不可用 → 线上 fallback（用户无感知）

import { net } from 'electron'
import { logger } from './logger'
import type { LocalModelsResult, PullResult } from '../../shared/types'

export const LOCAL_BASE_URL = 'http://localhost:11434/v1'
export const LOCAL_MODEL = 'qwen2.5:7b'
export const LOCAL_TOKEN = 'ollama' // 占位，Ollama 的 OpenAI 兼容端点忽略 Authorization

async function isLocalAvailable(timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await net.fetch('http://localhost:11434/api/tags', { signal: controller.signal })
    clearTimeout(timer)
    return resp.ok
  } catch {
    clearTimeout(timer)
    return false
  }
}

let cachedAvailable: boolean | null = null
let cachedAt = 0
const TTL = 60000

export async function checkLocal(force = false): Promise<boolean> {
  if (!force && cachedAvailable !== null && Date.now() - cachedAt < TTL) return cachedAvailable
  const ok = await isLocalAvailable()
  cachedAvailable = ok
  cachedAt = Date.now()
  logger.info('localLLM', `available=${ok}`)
  return ok
}

export async function listModels(): Promise<LocalModelsResult> {
  try {
    const resp = await net.fetch('http://localhost:11434/api/tags')
    if (!resp.ok) return { available: false, models: [] }
    const json: any = await resp.json()
    const models = (json.models || []).map((m: any) => ({
      name: m.name || '',
      size: m.size || 0,
      sizeLabel: formatSize(m.size),
    }))
    return { available: true, models }
  } catch {
    return { available: false, models: [] }
  }
}

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return gb.toFixed(1) + ' GB'
  const mb = bytes / (1024 * 1024)
  return mb.toFixed(0) + ' MB'
}

// 下载模型（Ollama pull 是流式 NDJSON，响应结束才代表下载完成）
export async function pullModel(name: string): Promise<PullResult> {
  if (!name || !name.trim()) return { ok: false, error: 'EMPTY_NAME' }
  try {
    const resp = await net.fetch('http://localhost:11434/api/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    })
    if (!resp.ok) return { ok: false, error: `HTTP_${resp.status}` }
    if (!resp.body) return { ok: true, error: null }
    const reader = resp.body.getReader()
    try {
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* ignore */
      }
    }
    return { ok: true, error: null }
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) }
  }
}
