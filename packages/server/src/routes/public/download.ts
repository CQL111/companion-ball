// routes/public/download.ts - 安装包清单与跳转
//
// 逻辑自 0.9.x 的 handler.ts 原样迁移。
// 安全点：只 302 到与 downloadBaseUrl 同源的地址（前缀匹配挡不住 https://good.example.evil.com）。

import type { ServerConfig } from '../../handler'
import { err, json } from '../../http/respond'

async function readManifest(cfg: ServerConfig): Promise<Record<string, unknown> | null> {
  const base = String(cfg.downloadBaseUrl || '').replace(/\/+$/, '')
  if (base) {
    try {
      // 下游不可达时不把请求挂死
      const res = await fetch(`${base}/latest.json`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) return (await res.json()) as Record<string, unknown>
    } catch {
      /* 落到存储分支 */
    }
  }
  if (cfg.readManifestFromStore) {
    try {
      return await cfg.readManifestFromStore()
    } catch {
      return null
    }
  }
  return null
}

export async function manifest(cfg: ServerConfig): Promise<Response> {
  const m = await readManifest(cfg)
  if (!m) return json({ ok: false, error: 'NO_RELEASE' }, 503)
  return json({ ok: true, ...m }, 200, { 'Cache-Control': 'public, s-maxage=300' })
}

export async function latest(cfg: ServerConfig, url: URL): Promise<Response> {
  const os = (url.searchParams.get('os') || 'win').toLowerCase()
  if (os !== 'win' && os !== 'mac') return err('BAD_OS', 400)

  const m = await readManifest(cfg)
  const assets = (m?.assets || {}) as Record<string, { url?: string } | undefined>
  const target = assets[os]?.url
  if (!target) return json({ ok: false, error: 'NO_RELEASE' }, 503)

  const base = String(cfg.downloadBaseUrl || '').replace(/\/+$/, '')
  if (base) {
    try {
      if (new URL(target).origin !== new URL(base).origin) {
        return json({ ok: false, error: 'BAD_TARGET' }, 500)
      }
    } catch {
      return json({ ok: false, error: 'BAD_TARGET' }, 500)
    }
  }

  return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store' } })
}
