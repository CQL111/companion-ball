// tests/backup.test.ts - 全量导出 / 导入单测
import { describe, expect, it } from 'vitest'
import { BACKUP_VERSION, exportBackup, parseBackup } from '@core/backup'
import type { Memory } from '@core/memory'
import type { Notebook } from '@core/notebook'

const memories: Memory[] = [{ id: 'm1', createdAt: '2026-11-01T00:00:00.000Z', text: '用户住在杭州' }]
const notebook: Notebook = {
  version: 1,
  entries: [{ date: '2026-11-19', createdAt: '2026-11-19T12:00:00.000Z', lines: ['今天很安静。'], source: 'template' }],
}

describe('exportBackup', () => {
  it('包含格式标识、版本与导出时间，且不含 API Key', () => {
    const b = exportBackup({ petName: '团子', memories, notebook, now: Date.UTC(2026, 10, 20) })
    expect(b.format).toBe('companion-ball-backup')
    expect(b.version).toBe(BACKUP_VERSION)
    expect(b.pet.name).toBe('团子')
    expect(b.exportedAt).toBe('2026-11-20T00:00:00.000Z')
    expect(JSON.stringify(b)).not.toMatch(/token|apiKey|sk-/)
  })

  it('深拷贝：修改导出结果不影响原数据', () => {
    const b = exportBackup({ petName: '', memories, notebook })
    b.memories[0]!.text = '改过'
    b.notebook.entries[0]!.lines[0] = '改过'
    expect(memories[0]!.text).toBe('用户住在杭州')
    expect(notebook.entries[0]!.lines[0]).toBe('今天很安静。')
  })
})

describe('parseBackup', () => {
  it('导出的备份能原样导入', () => {
    const raw = JSON.stringify(exportBackup({ petName: '团子', memories, notebook }))
    const r = parseBackup(raw)
    expect(r.ok).toBe(true)
    expect(r.data!.petName).toBe('团子')
    expect(r.data!.memories).toHaveLength(1)
    expect(r.data!.notebook.entries).toHaveLength(1)
  })

  it('坏 JSON / 非本应用文件 / 更高版本都返回错误而不是抛错', () => {
    expect(parseBackup('not json')).toEqual({ ok: false, error: '不是合法的 JSON 文件' })
    expect(parseBackup('{"format":"x"}')).toEqual({ ok: false, error: '不是本应用的备份文件' })
    const future = JSON.stringify({ format: 'companion-ball-backup', version: BACKUP_VERSION + 1 })
    expect(parseBackup(future).ok).toBe(false)
    expect(parseBackup(future).error).toContain('请先升级')
  })

  it('过滤坏条目，不因一条脏数据整体失败', () => {
    const raw = JSON.stringify({
      format: 'companion-ball-backup',
      version: 1,
      pet: { name: 'x'.repeat(50) },
      memories: [{ text: '好的' }, { text: '' }, null, 42],
      notebook: { entries: [{ date: '2026-11-20', lines: ['ok', 1] }, { date: 5 }] },
    })
    const r = parseBackup(raw)
    expect(r.ok).toBe(true)
    expect(r.data!.petName.length).toBe(16)
    expect(r.data!.memories).toHaveLength(1)
    expect(r.data!.notebook.entries).toHaveLength(1)
    expect(r.data!.notebook.entries[0]!.lines).toEqual(['ok'])
  })
})
