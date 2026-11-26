// backup.ts - 全量数据导出 / 导入（领域层，零平台依赖）
// 用途：
//  - 用户在设置里导出一份 JSON 备份（换电脑、重装）
//  - 手机端「恢复码」同步的第一步：先把数据变成可迁移的包
// 约束：
//  - 只包含用户数据，不含 API Key（Key 属于设备凭据，换个设备应当重新填）
//  - 导入要做版本与结构校验，坏数据不能覆盖好数据

import type { AgentMessage, PetSettings } from './types'
import type { Memory } from './memory'
import type { Notebook } from './notebook'

export const BACKUP_VERSION = 1

export interface BackupFile {
  format: 'companion-ball-backup'
  version: number
  exportedAt: string
  pet: Pick<PetSettings, 'name'>
  memories: Memory[]
  notebook: Notebook
  agentChat?: { messages: AgentMessage[]; updatedAt: number }
}

export interface ExportInput {
  petName: string
  memories: Memory[]
  notebook: Notebook
  agentChat?: BackupFile['agentChat']
  now?: number
}

export function exportBackup({ petName, memories, notebook, agentChat, now = Date.now() }: ExportInput): BackupFile {
  return {
    format: 'companion-ball-backup',
    version: BACKUP_VERSION,
    exportedAt: new Date(now).toISOString(),
    pet: { name: petName || '' },
    memories: memories.map((m) => ({ ...m })),
    notebook: { version: 1, entries: notebook.entries.map((e) => ({ ...e, lines: [...e.lines] })) },
    ...(agentChat ? { agentChat } : {}),
  }
}

export interface ParsedBackup {
  petName: string
  memories: Memory[]
  notebook: Notebook
  agentChat?: BackupFile['agentChat']
}

export interface ParseResult {
  ok: boolean
  error?: string
  data?: ParsedBackup
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 解析并校验备份文件。永不抛错——坏数据返回 { ok:false }。 */
export function parseBackup(raw: string): ParseResult {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return { ok: false, error: '不是合法的 JSON 文件' }
  }
  if (!isObject(obj)) return { ok: false, error: '备份文件结构不对' }
  if (obj.format !== 'companion-ball-backup') return { ok: false, error: '不是本应用的备份文件' }
  if (typeof obj.version !== 'number' || obj.version > BACKUP_VERSION) {
    return { ok: false, error: `备份版本 ${String(obj.version)} 比当前应用新，请先升级` }
  }

  const pet = isObject(obj.pet) ? obj.pet : {}
  const petName = typeof pet.name === 'string' ? pet.name.slice(0, 16) : ''

  const memories: Memory[] = []
  if (Array.isArray(obj.memories)) {
    for (const m of obj.memories) {
      if (!isObject(m)) continue
      const text = typeof m.text === 'string' ? m.text.trim() : ''
      if (!text) continue
      memories.push({
        id: typeof m.id === 'string' && m.id ? m.id : `m_${memories.length}`,
        createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date(0).toISOString(),
        text: text.slice(0, 200),
      })
    }
  }

  const notebook: Notebook = { version: 1, entries: [] }
  if (isObject(obj.notebook) && Array.isArray(obj.notebook.entries)) {
    for (const e of obj.notebook.entries) {
      if (!isObject(e) || typeof e.date !== 'string') continue // 有页边话的一页可能没有 lines
      const date = e.date.slice(0, 10)
      const lines = Array.isArray(e.lines) ? e.lines.filter((l): l is string => typeof l === 'string').slice(0, 4) : []

      // 页边一句话：用户自己写的，导入必须保住（否则「换电脑」= 话没了）
      let margin: Notebook['entries'][number]['margin']
      if (isObject(e.margin) && typeof e.margin.text === 'string' && e.margin.text.trim()) {
        margin = {
          date: typeof e.margin.date === 'string' ? e.margin.date.slice(0, 10) : date,
          text: e.margin.text.slice(0, 60),
          createdAt: typeof e.margin.createdAt === 'string' ? e.margin.createdAt : new Date(0).toISOString(),
        }
      }

      // 只有真正的内容才是一页；两边都空就跳过（保持「允许空白」）
      if (!lines.length && !margin) continue
      notebook.entries.push({
        date,
        createdAt: typeof e.createdAt === 'string' ? e.createdAt : new Date(0).toISOString(),
        lines,
        // 保留缺席标记：丢成 template 后，导入的缺席日记会被当天模板覆盖掉
        source: e.source === 'absence' ? 'absence' : 'template',
        ...(margin ? { margin } : {}),
      })
    }
    notebook.entries.sort((a, b) => (a.date < b.date ? 1 : -1))
    notebook.entries = notebook.entries.slice(0, 365)
  }

  let agentChat: ParsedBackup['agentChat']
  if (isObject(obj.agentChat) && Array.isArray(obj.agentChat.messages)) {
    const messages: AgentMessage[] = obj.agentChat.messages
      .filter(
        (m): m is { role: 'user' | 'assistant'; content: string } =>
          isObject(m) && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
      )
      .slice(-40)
    agentChat = { messages, updatedAt: typeof obj.agentChat.updatedAt === 'number' ? obj.agentChat.updatedAt : 0 }
  }

  return { ok: true, data: { petName, memories, notebook, agentChat } }
}
