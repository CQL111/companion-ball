// auth/loginLimit.ts - 登录尝试限流
//
// ⚠️ 必须用 D1 原子自增，不能用 KV。
// KV 的 incr 是「读 → 加一 → 写回」三步；攻击者并发请求时多个请求读到同一个旧值，
// 计数会被大幅低估，锁定形同虚设（BUILD-PLATFORM 第五节）。

import { LOGIN_MAX_PER_ACCOUNT, LOGIN_MAX_PER_IP, LOGIN_WINDOW_SECONDS } from '@companion/contracts'
import type { Db } from '../db'
import * as repo from '../repo/admins'

export function windowOf(now: number): number {
  return Math.floor(now / 1000 / LOGIN_WINDOW_SECONDS)
}

export type LimitKey =
  | { kind: 'account'; username: string }
  | { kind: 'ip'; ipHash: string }

function keyString(k: LimitKey): string {
  return k.kind === 'account' ? `u:${k.username}` : `ip:${k.ipHash}`
}

function limitFor(k: LimitKey): number {
  return k.kind === 'account' ? LOGIN_MAX_PER_ACCOUNT : LOGIN_MAX_PER_IP
}

/**
 * 记录一次尝试，并返回「这个窗口内是否已超限」。
 * 先计数再判断——宁可多锁一次，也不要允许第 N+1 次尝试。
 */
export async function registerAttempt(db: Db, k: LimitKey, now: number): Promise<{ attempts: number; locked: boolean }> {
  const win = windowOf(now)
  const attempts = await repo.bumpLoginAttempt(db, keyString(k), win)
  return { attempts, locked: attempts > limitFor(k) }
}

/** 不计数，只查当前是否已锁（用于在验证凭据前先快速拒绝） */
export async function isLocked(db: Db, k: LimitKey, now: number): Promise<boolean> {
  const n = await repo.getLoginAttempts(db, keyString(k), windowOf(now))
  return n >= limitFor(k)
}

export async function clearAfterSuccess(db: Db, k: LimitKey, now: number): Promise<void> {
  await repo.clearLoginAttempts(db, keyString(k), windowOf(now))
}
