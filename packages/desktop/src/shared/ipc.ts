// IPC 入参校验（zod）。仅主进程使用——preload 不要 import 本文件，
// 否则 zod 会被打进 preload bundle。通道名请从 shared/channels.ts 取。

import { z } from 'zod'

export { CH, EV, type Channel, type EventName } from './channels'

export const numPair = z.tuple([z.number().finite(), z.number().finite()])

export const rectSchema = z
  .object({ x: z.number().finite(), y: z.number().finite(), w: z.number().positive(), h: z.number().positive() })
  .nullable()

export const askSchema = z.object({ query: z.string().min(1).max(4000) })

export const aiSaveSchema = z.object({
  baseUrl: z.string().max(300).default(''),
  model: z.string().max(200).default(''),
  token: z.string().max(400).default(''),
})

export const localModelSchema = z.string().max(200)

export const petNameSchema = z.string().trim().max(16)
export const memoryIdSchema = z.string().max(80)

export const legalKeySchema = z.enum(['privacy', 'terms', 'disclaimer', 'thirdparty'])

/** 测试用：模拟缺席时长（毫秒），夹在 1 小时–30 天之间 */
export const debugAwayMsSchema = z
  .number()
  .finite()
  .min(3600_000)
  .max(30 * 24 * 3600_000)

// ---------- 事件记忆（P1.5）----------
export const occasionsIdSchema = z.string().max(80)
export const occasionConsumeSchema = z.object({
  beat: z.enum(['approach', 'today', 'followup']),
  id: z.string().max(80),
})

export const configKeySchema = z.enum([
  'position', 'autoStart', 'aiConfig', 'localModel', 'installId',
  'persona', 'agentChat', 'consentVersion', 'animations', 'pet', 'sound', 'sitReminder', 'weather', 'memories', 'notebook', 'memoryEnabled',
])
