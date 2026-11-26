// admin.ts - 管理后台（灯塔）契约
//
// 设计见 docs/WINDOW.md 第六节、docs/PLATFORM.md 第六节。
// 权限三档 + 审计 + 封海开关。**后台永远看不到私池**（WINDOW 6.5），
// 这条约束由 scripts/check-admin-privacy.js 机器守护。

export type AdminRole = 'viewer' | 'operator' | 'admin'

export interface AdminMe {
  ok: true
  id: string
  username: string
  role: AdminRole
}

export interface AdminLoginPayload {
  apiKey: string
  totp: string
}

/** 登录成功时只返回身份；Key / TOTP 密钥仅在创建账号时展示一次 */
export interface AdminLoginResult {
  ok: true
  me: Omit<AdminMe, 'ok'>
}

// ---------- 概览（今天的海面：先待办，后数字）----------

export interface AdminOverview {
  ok: true
  todo: {
    galleryPending: number
    reportsOpen: number
    oldestReportHours: number
    newsPublishedToday: number
  }
  /** 只有三个比率 + 种子占比。**不含 DAU / 停留时长 / PV** */
  ratios: {
    pickRate: number
    replyRate: number
    reportRate: number
    seedShare: number
  }
  flags: Record<FlagKey, boolean>
  /** 需要红色横幅的异常 */
  alerts: string[]
}

// ---------- 封海开关 ----------

export const FLAG_KEYS = ['EMERGENCY_OFF', 'GALLERY_OFF', 'NEWS_OFF', 'REPLY_OFF'] as const
export type FlagKey = (typeof FLAG_KEYS)[number]

export interface FlagState {
  key: FlagKey
  value: boolean
  updatedAt: number
  reason: string
}

// ---------- 值班队列 ----------

export type ModerationAction = 'approve' | 'reject'
export type ReportAction = 'hide' | 'keep'

export interface AuditEntry {
  id: string
  actor: string
  action: string
  target: string | null
  detail: string | null
  createdAt: number
}

// ---------- 管理员会话常量 ----------

/** 会话 7 天；写操作同时校验 Origin */
export const ADMIN_SESSION_DAYS = 7
export const ADMIN_SESSION_COOKIE = '__Host-sid'
/** 登录限流：每账号 5 次 / 15 分钟，每 IP 20 次 / 15 分钟 */
export const LOGIN_WINDOW_SECONDS = 15 * 60
export const LOGIN_MAX_PER_ACCOUNT = 5
export const LOGIN_MAX_PER_IP = 20

/** 错误码（与 bottleErrorCode 同一个函数处理） */
export type AdminErrorCode =
  | 'ADMIN_UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'BAD_TOTP'
  | 'LOGIN_LOCKED'
  | 'NOT_PENDING'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'RATE_LIMITED'
