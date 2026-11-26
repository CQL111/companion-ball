// api.ts - 后台唯一的网络出口
//
// 同源部署（boringtime.cn 单 Worker）让这里很简单：
//   - credentials: 'include' 带上 __Host-sid
//   - 不需要 CORS、不需要 CSRF token
//   - 401 统一跳登录

export interface ApiError {
  ok: false
  error: string
}

export class Unauthorized extends Error {
  constructor() {
    super('unauthorized')
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  })
  if (res.status === 401) throw new Unauthorized()
  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${res.status}）`)
  }
  if (!res.ok) {
    const e = data as ApiError
    throw new Error(e?.error || `HTTP ${res.status}`)
  }
  return data as T
}

const get = <T>(p: string): Promise<T> => call<T>(p)
const post = <T>(p: string, body: unknown = {}): Promise<T> => call<T>(p, { method: 'POST', body: JSON.stringify(body) })
const patch = <T>(p: string, body: unknown = {}): Promise<T> => call<T>(p, { method: 'PATCH', body: JSON.stringify(body) })

export type Role = 'viewer' | 'operator' | 'admin'

export interface Me {
  ok: true
  id: string
  username: string
  role: Role
}

export interface Overview {
  ok: true
  todo: { galleryPending: number; reportsOpen: number; oldestReportHours: number; newsPublishedToday: number }
  ratios: { pickRate: number; replyRate: number; reportRate: number; seedShare: number }
  flags: Record<string, boolean>
  alerts: string[]
}

export interface GalleryItem {
  id: string
  body: string
  alias: string
  pool: string
  status: string
  seed: boolean
  sourceBottle: string | null
  createdAt: number
  reviewedAt: number | null
  reviewNote: string | null
  expiresAt: number | null
}

export interface ReportItem {
  id: string
  reason: string
  createdAt: number
  target: { kind: 'bottle' | 'reply'; body: string; alias: string; hidden: boolean } | null
}

export interface NewsItem {
  id: string
  title: string
  summary: string
  body: string
  sourceName: string | null
  sourceUrl: string | null
  category: string
  status: string
  publishAt: number | null
  createdAt: number
  updatedAt: number | null
}

export interface LeadItem {
  id: string
  rawTitle: string
  rawSummary: string
  sourceName: string
  sourceUrl: string
  suggestedCategory: string
  fetchedAt: number
  status: string
  createdAt: number
}

export interface FlagItem {
  key: string
  value: boolean
  reason: string
  updatedAt: number
}

export interface AuditItem {
  id: string
  actor: string
  action: string
  target: string | null
  detail: string | null
  createdAt: number
}

export interface AdminItem {
  id: string
  username: string
  role: Role
  disabled: boolean
  createdAt: number
  lastLoginAt: number | null
}

export const api = {
  login: (username: string, apiKey: string, totp: string) =>
    call<{ ok: true; me: { id: string; username: string; role: Role } }>('/admin/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, apiKey, totp }),
    }),
  logout: () => post<{ ok: true }>('/admin/api/logout'),
  me: () => get<Me>('/admin/api/me'),

  overview: () => get<Overview>('/admin/api/overview'),

  moderation: (status = 'pending') => get<{ ok: true; items: GalleryItem[] }>(`/admin/api/moderation?status=${status}`),
  review: (id: string, action: 'approve' | 'reject', note: string) =>
    post<{ ok: true }>(`/admin/api/moderation/${id}`, { action, note }),

  reports: () => get<{ ok: true; items: ReportItem[] }>('/admin/api/reports'),
  handleReport: (id: string, action: 'hide' | 'keep') => post<{ ok: true }>(`/admin/api/reports/${id}`, { action }),

  gallery: (q = '') => get<{ ok: true; items: GalleryItem[] }>(`/admin/api/gallery${q}`),
  unpublish: (id: string, note: string) => post<{ ok: true }>(`/admin/api/gallery/${id}/unpublish`, { note }),
  addSeed: (body: string, pool: string) => post<{ ok: true }>('/admin/api/gallery/seed', { body, pool }),

  news: (status = '') => get<{ ok: true; items: NewsItem[] }>(`/admin/api/news${status ? '?status=' + status : ''}`),
  createNews: (d: Record<string, unknown>) => post<{ ok: true; id: string }>('/admin/api/news', d),
  updateNews: (id: string, d: Record<string, unknown>) => patch<{ ok: true }>(`/admin/api/news/${id}`, d),
  publishNews: (id: string, publishAt?: number) => post<{ ok: true }>(`/admin/api/news/${id}/publish`, { publishAt }),
  archiveNews: (id: string) => post<{ ok: true }>(`/admin/api/news/${id}/archive`),

  leads: (status = 'new') => get<{ ok: true; items: LeadItem[] }>(`/admin/api/leads?status=${status}`),
  ignoreLead: (id: string) => post<{ ok: true }>(`/admin/api/leads/${id}/ignore`),

  flags: () => get<{ ok: true; items: FlagItem[] }>('/admin/api/flags'),
  setFlag: (key: string, value: boolean, reason: string) => post<{ ok: true }>('/admin/api/flags', { key, value, reason }),

  audit: () => get<{ ok: true; items: AuditItem[] }>('/admin/api/audit'),

  admins: () => get<{ ok: true; items: AdminItem[] }>('/admin/api/admins'),
  createAdmin: (username: string, role: Role) =>
    post<{ ok: true; apiKey: string; totpSecret: string }>('/admin/api/admins', { username, role }),
  updateAdmin: (id: string, d: { role?: Role; disabled?: boolean }) => patch<{ ok: true }>(`/admin/api/admins/${id}`, d),
  resetKey: (id: string) => post<{ ok: true; apiKey: string }>(`/admin/api/admins/${id}/reset-key`),
}

/** 把后端错误码翻成人话；未知码原样显示，便于排查 */
const TEXTS: Record<string, string> = {
  ADMIN_UNAUTHORIZED: '请先登录',
  FORBIDDEN: '这个账号没有权限',
  BAD_TOTP: '验证码不对',
  LOGIN_LOCKED: '试了太多次，过一会儿再来',
  NOT_PENDING: '这条已经处理过了',
  NOT_FOUND: '找不到这条',
  VALIDATION: '内容不符合要求',
  RATE_LIMITED: '慢一点',
  NETWORK: '网络不太好',
}

export function explain(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return TEXTS[raw] ?? raw
}
