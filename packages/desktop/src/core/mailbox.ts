// mailbox.ts - 许愿瓶的领域规则（零平台依赖）
//
// 2026-11-25 起，规则本体唯一来源是 packages/contracts（桌面端与服务端共用同一份），
// 本文件只做两件事：
//   1. 兼容层：把 @contracts 的导出原样转出去，现有 `@core/mailbox` import 不用改
//   2. 本地设置类型：BottleSettings 只属于客户端（存 store.bottle），不属于契约
//
// 产品原则（docs/ROADMAP.md 第四节）：
//   - 结构上不可私聊：没有会话、不能追问
//   - 不显示任何数字：无已读、无点赞、无被捡次数
//   - 回信不保证送达：7 天没人捡就沉海

export * from '@contracts'

// ---------- 本地状态（store.bottle）----------

export interface BottleSettings {
  /** 用户是否开启（默认 false，必须 opt-in） */
  enabled: boolean
  /** 服务端地址；留空表示用默认（公测地址在发布时填） */
  endpoint: string
  /** 上次出门巡游的时间（用于「猫出门」节奏） */
  lastOutAt: number
  /** 本地保存的最近一张收到的纸条，用于笔记本展示 */
  lastPickedAt: number
}

export const DEFAULT_BOTTLE_SETTINGS: BottleSettings = {
  enabled: false,
  endpoint: '',
  lastOutAt: 0,
  lastPickedAt: 0,
}
