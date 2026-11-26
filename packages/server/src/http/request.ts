// http/request.ts - 请求侧工具（IP / Origin / body 上限）

/** 后台写请求的 Origin 校验：同源部署下这一条就挡住了绝大多数 CSRF */
export function originAllowed(req: Request, expectedOrigin: string): boolean {
  const origin = req.headers.get('Origin')
  // 同源 POST 在部分场景不带 Origin（比如某些表单）；带了就必须一致
  if (!origin) return true
  try {
    return new URL(origin).origin === new URL(expectedOrigin).origin
  } catch {
    return false
  }
}

export function clientIp(req: Request, trustProxy: boolean, socketIp?: string): string | null {
  if (trustProxy) {
    const cf = req.headers.get('cf-connecting-ip')
    if (cf) return cf.trim()
    const xff = req.headers.get('x-forwarded-for')
    if (xff) {
      const first = xff.split(',')[0]?.trim()
      if (first) return first
    }
  }
  return socketIp ?? null
}

/**
 * 读取 JSON body 并限制大小。
 * 先把文本读出来再 parse——`req.json()` 没有大小上限，
 * 一个恶意的大 body 会先把内存吃掉再报错。
 */
export async function readJson(req: Request, maxBytes = 16 * 1024): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  let text: string
  try {
    text = await req.text()
  } catch {
    return { ok: false }
  }
  if (text.length > maxBytes) return { ok: false }
  if (!text) return { ok: true, value: {} }
  try {
    const v = JSON.parse(text)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false }
    return { ok: true, value: v as Record<string, unknown> }
  } catch {
    return { ok: false }
  }
}

export function str(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
