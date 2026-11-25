// constants.ts - 许愿瓶规则的唯一常量源
// 桌面端与 packages/server 都从这里引用；**不要再在两处各写一份**。
// 本包必须零平台依赖、零运行时依赖（见 docs/REPO-LAYOUT.md 第二节）。

export const BOTTLE_MAX_LENGTH = 60
export const REPLY_MAX_LENGTH = 60
export const BOTTLE_TTL_DAYS = 7
export const MAX_PICKS = 3
export const DAILY_BOTTLE_LIMIT = 3
export const DAILY_REPLY_LIMIT = 10

/**
 * 内容审核策略。
 *   'open'     = 只做技术校验（非空、长度），不拦截任何内容
 *   'filtered' = 额外拦截联系方式与链接
 * 客户端与服务端必须一致——现在它们读的是同一个常量，不存在漂移。
 */
export const CONTENT_POLICY: 'open' | 'filtered' = 'open'
