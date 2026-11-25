// crypto.ts - 服务端专用的加密工具（不进 contracts：契约包必须零平台依赖）
// hashToken：只存哈希，不存令牌原文
// randomId：不可枚举的随机 id
// 两者都只用标准 Web Crypto，Workers 与 Node 22 都能跑。

/** 设备令牌哈希：只存哈希，不存原文 */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode('companion-ball:' + token)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}
