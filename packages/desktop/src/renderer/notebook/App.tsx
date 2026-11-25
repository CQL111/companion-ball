import { useCallback, useEffect, useState } from 'react'
import type { NotebookView } from '../../shared/types'

type Status = { kind: '' | 'ok' | 'err'; text: string }

function formatDate(date: string): string {
  // 2026-11-20 → 11 月 20 日
  const [, m, d] = date.split('-')
  if (!m || !d) return date
  return `${Number(m)} 月 ${Number(d)} 日`
}

function weekday(date: string): string {
  const dt = new Date(`${date}T12:00:00`)
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dt.getDay()] || ''
}

export default function App(): React.ReactElement {
  const [view, setView] = useState<NotebookView>({ entries: [] })
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<Status>({ kind: '', text: '' })

  const load = useCallback(async () => {
    try {
      setView(await window.api.getNotebookView())
    } catch (e) {
      setStatus({ kind: 'err', text: '读取失败：' + ((e as Error).message || e) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    window.logger.info('notebook.load', 'start')
    void load()
  }, [load])

  const exportMarkdown = async (): Promise<void> => {
    try {
      const r = await window.api.exportNotebookMarkdown()
      if (r.ok) setStatus({ kind: 'ok', text: '已导出' })
      else if (!r.canceled) setStatus({ kind: 'err', text: r.error || '导出失败' })
    } catch (e) {
      setStatus({ kind: 'err', text: '导出失败：' + ((e as Error).message || e) })
    }
  }

  return (
    <div className="notebook">
      <header className="nb-header">
        <div>
          <h1>猫的笔记本</h1>
          <p className="nb-sub">它每天最多写一句。没有话说的时候，就空着。</p>
        </div>
        <div className="nb-actions">
          <button className="btn" onClick={() => void exportMarkdown()}>
            导出 Markdown
          </button>
          <button className="btn ghost" onClick={() => void load()}>
            刷新
          </button>
        </div>
      </header>

      {status.text && <div className={`status ${status.kind}`}>{status.text}</div>}

      {loading ? (
        <p className="nb-empty">正在翻页…</p>
      ) : view.entries.length === 0 ? (
        <div className="nb-empty">
          <p>笔记本还是空的。</p>
          <p className="nb-empty-hint">它会先记住一些关于你的事，等有素材了再写。</p>
        </div>
      ) : (
        <ol className="nb-list">
          {view.entries.map((e) => (
            <li key={e.date} className="nb-entry">
              <time className="nb-date">
                {formatDate(e.date)}
                <span className="nb-weekday">{weekday(e.date)}</span>
              </time>
              <div className="nb-lines">
                {e.lines.map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}

      <footer className="nb-footer">只存在这台电脑上 · 不会同步、不会分享</footer>
    </div>
  )
}
