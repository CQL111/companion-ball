// renderer-logger.ts - 渲染端统一日志
// 通过 IPC 发到主进程，统一写入 logs 目录；同时捕获未处理异常。

import type { RendererLogger } from '../shared/types'

// 限速：同一 scope 5 秒内最多 5 条，防止死循环刷爆日志
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
function shouldRateLimit(scope: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(scope) || { count: 0, resetAt: now + 5000 }
  if (now > entry.resetAt) {
    entry.count = 0
    entry.resetAt = now + 5000
  }
  entry.count++
  rateLimitMap.set(scope, entry)
  return entry.count > 5
}

type Level = 'info' | 'warn' | 'error' | 'critical'

function send(level: Level, scope: string, msg: string, meta?: Record<string, unknown>): void {
  try {
    if (!window.api) return
    if (shouldRateLimit(scope)) return
    const safeMeta: Record<string, unknown> = {}
    if (meta && typeof meta === 'object') {
      for (const k of Object.keys(meta)) {
        const v = meta[k]
        if (v == null) continue
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') safeMeta[k] = v
        else if (Array.isArray(v)) safeMeta[k] = v.slice(0, 10)
      }
    }
    if (level === 'info') window.api.logInfo(scope, String(msg), safeMeta)
    else if (level === 'warn') window.api.logWarn(scope, String(msg), safeMeta)
    else if (level === 'error') window.api.logError(scope, String(msg), safeMeta)
    else window.api.logCritical(scope, String(msg), safeMeta)
  } catch (e) {
    try {
      console.error('[rendererLogger] send failed:', e)
    } catch {
      /* ignore */
    }
  }
}

export const logger: RendererLogger = {
  info: (scope, msg, meta) => send('info', scope, msg, meta),
  warn: (scope, msg, meta) => send('warn', scope, msg, meta),
  error: (scope, msg, meta) => send('error', scope, msg, meta),
  critical: (scope, msg, meta) => send('critical', scope, msg, meta),
}

window.logger = logger

window.addEventListener('error', (e) => {
  send('error', 'renderer.unhandled', e.message || 'unknown', {
    stack: e.error && (e.error as Error).stack ? String((e.error as Error).stack).slice(0, 1000) : '',
    filename: e.filename || '',
    lineno: e.lineno || 0,
  })
})
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason as { message?: string; stack?: string } | string | undefined
  const msg = typeof reason === 'string' ? reason : reason?.message || 'unknown'
  send('error', 'renderer.unhandledrejection', msg, {
    stack: typeof reason === 'object' && reason?.stack ? String(reason.stack).slice(0, 1000) : '',
  })
})

// 只在 error/warn 时转发 console，避免噪音
;(['error', 'warn'] as const).forEach((m) => {
  const orig = console[m].bind(console)
  console[m] = (...args: unknown[]): void => {
    orig(...args)
    try {
      const scope = (window.location.pathname || 'renderer').split('/').filter(Boolean).pop() || 'renderer'
      const msg = args.map((a) => (typeof a === 'string' ? a : (a as Error)?.message || String(a))).join(' ').slice(0, 500)
      send(m, scope, msg)
    } catch {
      /* ignore */
    }
  }
})

logger.info('renderer', 'logger ready', { url: window.location.href })
