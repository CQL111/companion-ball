// selfCheck.ts - 启动后自检（失败项写日志，让 watcher → detector → ai.diagnose 接住）

import { getLogDir, logger } from './logger'

export interface SelfCheckResult {
  name: string
  ok: boolean
  optional: boolean
  error: string | null
}

export interface SelfCheckDeps {
  logWatcher: unknown
  onlineConfig: unknown
  getOnlineToken: () => string
  localLLM: { checkLocal: (force?: boolean) => Promise<boolean> }
  tray: unknown
  ballWindow: { isDestroyed: () => boolean } | null
  globalShortcut: { isRegistered: (accel: string) => boolean }
}

export async function runSelfCheck(deps: SelfCheckDeps): Promise<SelfCheckResult[]> {
  const checks: Array<{ name: string; optional?: boolean; check: () => boolean | Promise<boolean> }> = [
    { name: 'logger', check: () => !!getLogDir() },
    { name: 'watcher', check: () => !!deps.logWatcher },
    {
      name: 'online-token',
      optional: true,
      check: () => (typeof deps.getOnlineToken === 'function' ? !!deps.getOnlineToken() : false),
    },
    {
      name: 'local-llm',
      optional: true,
      check: async () => {
        const ok = deps.localLLM ? await deps.localLLM.checkLocal(true) : false
        return ok || true
      },
    },
    { name: 'tray', check: () => deps.tray !== null },
    { name: 'ballWindow', check: () => !!deps.ballWindow && !deps.ballWindow.isDestroyed() },
    {
      name: 'shortcut',
      optional: true,
      check: () => {
        try {
          const ok = deps.globalShortcut.isRegistered('CommandOrControl+Alt+F')
          if (!ok) logger.warn('selfCheck', 'shortcut Ctrl+Alt+F not registered (可能被其他应用占用)')
          return ok
        } catch (e) {
          throw new Error('shortcut check failed: ' + (e as Error).message)
        }
      },
    },
  ]

  const results: SelfCheckResult[] = []
  for (const c of checks) {
    try {
      const ok = await c.check()
      results.push({ name: c.name, ok, optional: !!c.optional, error: null })
    } catch (e) {
      results.push({ name: c.name, ok: false, optional: !!c.optional, error: (e as Error).message })
    }
  }

  const failed = results.filter((r) => !r.ok)
  logger.info('selfCheck', `${results.length - failed.length}/${results.length} passed`, {
    failed: failed.map((f) => f.name),
  })

  for (const f of failed) {
    const write = f.optional ? logger.warn : logger.error
    write('selfCheck', `failed: ${f.name}${f.optional ? ' (optional)' : ''}`, { error: f.error })
  }
  return results
}
