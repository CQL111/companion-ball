// watcher.ts - 日志 tailer
// 监控 logger 输出的文件，新行触发 detector → AI 诊断 + 系统通知
// 节流：5 分钟内同一 category 只诊断一次

import { getLogDir, logger, readTodayLog, tailSince } from './logger'
import { classify, parseLevel } from './detector'

export interface DiagnoseContext {
  line: string
  level: string
  category: string
  pattern: string
  hint: string
  meta: Record<string, unknown>
  recentLines: string[]
  _diagnosis?: unknown
}

export class LogWatcher {
  private offset = 0
  private pollTimer: NodeJS.Timeout | null = null
  private cooldownByCategory = new Map<string, number>()
  private onDiagnose: ((ctx: DiagnoseContext) => Promise<void>) | null = null
  private onNotify: ((ctx: DiagnoseContext) => void) | null = null
  private readonly COOLDOWN_MS = 5 * 60 * 1000

  start(handlers: {
    onDiagnose?: (ctx: DiagnoseContext) => Promise<void>
    onNotify?: (ctx: DiagnoseContext) => void
  } = {}): void {
    if (handlers.onDiagnose) this.onDiagnose = handlers.onDiagnose
    if (handlers.onNotify) this.onNotify = handlers.onNotify
    this.bootstrap()
    // 1 秒轮询一次（避免 fs.watch 在 Windows 上不稳）
    this.pollTimer = setInterval(() => this.poll(), 1000)
    logger.info('watcher', 'started')
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    logger.info('watcher', 'stopped')
  }

  private bootstrap(): void {
    const content = readTodayLog()
    this.offset = content.split('\n').length - 1
    void getLogDir()
  }

  private poll(): void {
    try {
      const content = readTodayLog()
      const lines = content.split('\n')
      if (lines.length <= this.offset) {
        this.offset = Math.max(0, lines.length - 1)
        return
      }
      const newLines = lines.slice(this.offset, lines.length - 1)
      this.offset = lines.length - 1
      for (const line of newLines) {
        if (!line.trim()) continue
        this.processLine(line)
      }
    } catch (e) {
      console.error('[watcher] poll failed:', (e as Error).message)
    }
  }

  private processLine(line: string): void {
    const level = parseLevel(line)
    if (!level) return
    if (level !== 'error' && level !== 'critical' && level !== 'warn') return

    const metaMatch = line.match(/\s(\{.*\})\s*$/)
    let meta: Record<string, unknown> = {}
    if (metaMatch) {
      try {
        meta = JSON.parse(metaMatch[1]!)
      } catch {
        /* ignore */
      }
    }

    const cls = classify(line, meta)
    if (!cls.matched) return

    const category = cls.category!
    const lastTs = this.cooldownByCategory.get(category) || 0
    if (Date.now() - lastTs < this.COOLDOWN_MS) {
      logger.info('watcher.cooldown', `category=${category} skipped (${Math.round((Date.now() - lastTs) / 1000)}s ago)`)
      return
    }
    this.cooldownByCategory.set(category, Date.now())

    const ctx: DiagnoseContext = {
      line,
      level,
      category,
      pattern: cls.pattern!,
      hint: cls.hint!,
      meta,
      recentLines: tailSince(Math.max(0, this.offset - 50)).filter((l) => l.trim()),
    }

    logger.info('watcher', `detected ${cls.pattern} level=${level}`, { category })

    Promise.resolve()
      .then(() => this.onDiagnose && this.onDiagnose(ctx))
      .catch((e) => logger.warn('watcher', 'onDiagnose failed', { error: (e as Error).message }))

    if (level === 'critical' && this.onNotify) {
      setTimeout(() => {
        try {
          this.onNotify?.(ctx)
        } catch (e) {
          logger.warn('watcher', 'onNotify failed', { error: (e as Error).message })
        }
      }, 100)
    }
  }
}
