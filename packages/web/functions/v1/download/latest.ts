// functions/v1/download/latest.ts - Pages Function
// 302 到最新安装包。只允许跳到配置好的下载域，避免开放重定向。

interface Env {
  R2_PUBLIC_BASE_URL?: string
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const base = String(env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  if (!base) {
    return Response.json({ ok: false, error: 'NO_RELEASE' }, { status: 503 })
  }

  const os = (new URL(request.url).searchParams.get('os') || 'win').toLowerCase()
  if (os !== 'win' && os !== 'mac') {
    return Response.json({ ok: false, error: 'BAD_OS' }, { status: 400 })
  }

  try {
    const res = await fetch(`${base}/latest.json`, { cf: { cacheTtl: 60 } as never })
    if (!res.ok) {
      return Response.json({ ok: false, error: 'NO_RELEASE' }, { status: 503 })
    }
    const manifest = (await res.json()) as { assets?: Record<string, { url?: string }> }
    const target = manifest.assets?.[os]?.url
    if (!target) {
      return Response.json({ ok: false, error: 'NO_RELEASE' }, { status: 503 })
    }
    if (!target.startsWith(`${base}/`)) {
      return Response.json({ ok: false, error: 'BAD_TARGET' }, { status: 500 })
    }
    return new Response(null, {
      status: 302,
      headers: { Location: target, 'cache-control': 'no-store' },
    })
  } catch {
    return Response.json({ ok: false, error: 'UPSTREAM' }, { status: 502 })
  }
}
