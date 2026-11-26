// auth/session.ts - 后台会话（__Host- Cookie，仅同源部署可用）
//
// 同源部署（boringtime.cn 单 Worker）让这里简单得多：
//   SameSite=Strict 直接可用，不需要 CORS / CSRF token。
// __Host- 前缀强制 Secure + Path=/ + 无 Domain，浏览器层面防止子域注入。

import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_DAYS } from '@companion/contracts'
import { hashSecret, randomSecret } from '../crypto'
import type { Db } from '../db'
import * as repo from '../repo/admins'

export interface SessionIssue {
  token: string
  cookie: string
  expiresAt: number
}

export async function issueSession(db: Db, adminId: string, now: number): Promise<SessionIssue> {
  const token = randomSecret()
  const tokenHash = await hashSecret(token, 'admin-session')
  const expiresAt = now + ADMIN_SESSION_DAYS * 86400000
  await repo.createSession(db, { tokenHash, adminId, expiresAt, now })
  const maxAge = Math.floor((expiresAt - now) / 1000)
  const cookie = `${ADMIN_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
  return { token, cookie, expiresAt }
}

export function clearCookie(): string {
  return `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

/** 从请求头里取会话令牌（只认 __Host-sid） */
export function readSessionToken(req: Request): string | null {
  const raw = req.headers.get('Cookie')
  if (!raw) return null
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() === ADMIN_SESSION_COOKIE) {
      const v = part.slice(idx + 1).trim()
      return v || null
    }
  }
  return null
}

export interface AuthContext {
  adminId: string
  role: 'viewer' | 'operator' | 'admin'
}

/** 校验会话：返回身份 + 令牌哈希（登出时要删） */
export async function authenticate(
  db: Db,
  req: Request,
  now: number,
): Promise<{ auth: AuthContext; tokenHash: string } | null> {
  const token = readSessionToken(req)
  if (!token) return null
  const tokenHash = await hashSecret(token, 'admin-session')
  const s = await repo.findSession(db, tokenHash, now)
  if (!s) return null
  const admin = await repo.findById(db, s.admin_id)
  if (!admin || admin.disabled) return null
  return { auth: { adminId: admin.id, role: admin.role }, tokenHash }
}

export type Role = 'viewer' | 'operator' | 'admin'

const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 }

/** 权限三档：viewer 只看 / operator 审核与新闻 / admin 开关与账号 */
export function hasRole(role: Role, need: Role): boolean {
  return RANK[role] >= RANK[need]
}
