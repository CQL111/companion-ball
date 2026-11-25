// diagnostics.ts - 日志监控 → AI 诊断 → 系统通知

import { Notification, shell } from 'electron'
import * as ai from './services/ai'
import { getLogDir, logger } from './services/logger'
import { LogWatcher, type DiagnoseContext } from './services/watcher'
import { resolveAiConfig } from './store'

let logWatcher: LogWatcher | null = null

export function getLogWatcher(): LogWatcher | null {
  return logWatcher
}

async function runAiDiagnose(ctx: DiagnoseContext): Promise<ai.Diagnosis | null> {
  const cfg = await resolveAiConfig()
  if (!cfg.token) {
    logger.warn('watcher.diagnose', 'NO_TOKEN, skip AI', { category: ctx.category })
    return null
  }
  try {
    const result = await ai.diagnose({
      line: ctx.line,
      recentLines: ctx.recentLines,
      meta: ctx.meta,
      ctx: { level: ctx.level, pattern: ctx.pattern, hint: ctx.hint },
      aiConfig: cfg,
    })
    logger.info('watcher.diagnose', `${result.rootCause} | 建议: ${result.fix}`, {
      confidence: result.confidence,
      model: result.model,
      category: ctx.category,
    })
    return result
  } catch (e) {
    logger.warn('watcher.diagnose', `失败: ${(e as Error).message}`, { category: ctx.category })
    return null
  }
}

function notifyCritical(diagnosis: ai.Diagnosis | null | undefined, ctx: DiagnoseContext): void {
  if (!Notification.isSupported()) return
  const body = diagnosis
    ? `${diagnosis.rootCause}\n建议: ${diagnosis.fix}`
    : `${ctx.hint || ctx.pattern || '检测到异常'}\n请查看日志了解详情`
  try {
    const n = new Notification({
      title: '桌面陪伴 · 检测到异常',
      body: body.slice(0, 240),
      urgency: 'critical',
    })
    n.on('click', () => {
      try {
        void shell.openPath(getLogDir())
      } catch {
        /* ignore */
      }
    })
    n.show()
  } catch (e) {
    logger.warn('notify', 'show failed', { error: (e as Error).message })
  }
}

export function startWatcher(): void {
  if (logWatcher) return
  logWatcher = new LogWatcher()
  logWatcher.start({
    onDiagnose: async (ctx) => {
      ctx._diagnosis = await runAiDiagnose(ctx)
    },
    onNotify: (ctx) => {
      // 等 100ms 让 onDiagnose 先跑（Promise 微任务）
      setTimeout(() => notifyCritical(ctx._diagnosis as ai.Diagnosis | null, ctx), 100)
    },
  })
}
