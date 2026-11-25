// functions/v1/download/manifest.ts - Pages Function
// 代理 R2 上的 latest.json，让下载页与 API 同源（避免 CORS，也便于以后换下载域）。
// 环境变量在 Pages 项目设置里配置：R2_PUBLIC_BASE_URL
//
// 响应与 Worker 的 GET /v1/download/manifest 保持一致。

interface Env {
  R2_PUBLIC_BASE_URL?: string
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const base = String(env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  if (!base) {
    return Response.json({ ok: false, error: 'NO_RELEASE' }, { status: 503 })
  }

  try {
    const res = await fetch(`${base}/latest.json`, { cf: { cacheTtl: 60 } as never })
    if (!res.ok) {
      return Response.json({ ok: false, error: 'NO_RELEASE' }, { status: 503 })
    }
    const data = await res.json()
    return Response.json({ ok: true, ...(data as object) }, {
      // 与 R2 上的缓存节奏一致，别让边缘缓存把新版本挡住太久
      headers: { 'cache-control': 'public, max-age=60' },
    })
  } catch {
    return Response.json({ ok: false, error: 'UPSTREAM' }, { status: 502 })
  }
}
