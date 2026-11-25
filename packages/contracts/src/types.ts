// types.ts - 两端共享的数据形状与错误码

export type Pool = 'night' | 'morning' | 'day' | 'evening'

/** 内容校验结果：ok=false 时 reason 给客户端展示 */
export interface TextCheck {
  ok: boolean
  reason?: 'EMPTY' | 'TOO_LONG' | 'CONTACT' | 'LINK'
  cleaned: string
}

export interface BottleDTO {
  id: string
  body: string
  alias: string
}

export interface ReplyDTO {
  bottleId: string
  bottleBody: string
  replyBody: string
  replyAlias: string
  createdAt: number
}

export type BottleErrorCode =
  | 'BAD_TOKEN'
  | 'DAILY_LIMIT'
  | 'RATE_LIMITED'
  | 'SERVICE_PAUSED'
  | 'REVOKED'
  | 'NOT_FOUND'
  | 'ALREADY_REPLIED'
  | 'SELF_REPLY'
  | 'NO_BOTTLE'
  | 'EMPTY'
  | 'TOO_LONG'
  | 'CONTACT'
  | 'LINK'
  | 'NETWORK'
  | 'INTERNAL'

export type BottleStatus = 'floating' | 'picked' | 'replied' | 'sunk'

export interface BottleState {
  createdAt: number
  expiresAt: number
  picks: number
  replyId?: string
}
