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

export const legalKeySchema = z.enum(['privacy', 'terms', 'disclaimer', 'thirdparty'])

export const configKeySchema = z.enum([
  'position', 'autoStart', 'aiConfig', 'localModel', 'installId',
  'persona', 'agentChat', 'consentVersion', 'animations',
])
