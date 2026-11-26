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

/** 后台 API Key / 会话令牌的哈希（与设备令牌用不同盐，避免撞域） */
export async function hashSecret(secret: string, domain: 'admin-key' | 'admin-session'): Promise<string> {
  const data = new TextEncoder().encode(`companion-ball:${domain}:` + secret)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 32 字节随机，给 API Key / 会话令牌用 */
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------- AES-GCM：保护 TOTP 密钥（主密钥来自 secret，不进仓库）----------

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

async function aesKey(masterKeyB64: string): Promise<CryptoKey> {
  // 主密钥应当是 32 字节的 base64；不足时用 SHA-256 派生，避免长度不对直接崩
  const raw = b64ToBytes(masterKeyB64)
  const material = raw.length === 32 ? raw : new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** 加密：返回 base64(iv + ciphertext + tag) */
export async function sealSecret(plaintext: string, masterKeyB64: string): Promise<string> {
  if (!masterKeyB64) throw new Error('TOTP_MASTER_KEY 未配置')
  const key = await aesKey(masterKeyB64)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  )
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv, 0)
  out.set(ct, iv.length)
  return bytesToB64(out)
}

/** 解密；密钥不对或数据被改会抛错（GCM 自带认证） */
export async function openSecret(sealed: string, masterKeyB64: string): Promise<string> {
  if (!masterKeyB64) throw new Error('TOTP_MASTER_KEY 未配置')
  const key = await aesKey(masterKeyB64)
  const all = b64ToBytes(sealed)
  const iv = all.slice(0, 12)
  const ct = all.slice(12)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  return new TextDecoder().decode(pt)
}

