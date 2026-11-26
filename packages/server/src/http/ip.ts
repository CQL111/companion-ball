// http/ip.ts - IP 规范化
//
// 取逗号前第一个、去掉端口、小写。
// IPv4:port / [IPv6]:port / 裸 IPv6 都处理。

export function normalizeIp(raw: string | null): string | null {
  if (!raw) return null
  const first = raw.split(',')[0]?.trim() || ''
  if (!first) return null
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(first)
  if (v4) return v4[1] ?? null
  const v6 = /^\[([0-9a-f:]+)\](?::\d+)?$/i.exec(first)
  if (v6) return (v6[1] ?? '').toLowerCase()
  return first.toLowerCase()
}

/** 用于限流与统计的短哈希（不存 IP 原文） */
export async function ipHash(raw: string | null): Promise<string | null> {
  if (!raw) return null
  const data = new TextEncoder().encode('companion-ball:ip:' + raw)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
