// http/respond.ts - 统一的响应构造

export const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

export function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...(extraHeaders ?? {}) },
  })
}

/** 错误响应：{ ok: false, error } —— 与现有客户端解析方式一致 */
export function err(code: string, status = 400): Response {
  return json({ ok: false, error: code }, status)
}

export function html(body: string, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...(extraHeaders ?? {}) },
  })
}

/** 公开只读接口的缓存头：s-maxage 让边缘/CDN 吃掉大部分请求 */
export function cacheHeaders(seconds: number, staleWhileRevalidate = seconds * 2): Record<string, string> {
  return {
    'Cache-Control': `public, max-age=${Math.min(seconds, 60)}, s-maxage=${seconds}, stale-while-revalidate=${staleWhileRevalidate}`,
  }
}

export function noStore(): Record<string, string> {
  return { 'Cache-Control': 'no-store' }
}
