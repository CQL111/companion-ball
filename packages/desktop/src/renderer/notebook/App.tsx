import { useCallback, useEffect, useState } from 'react'
import type { NotebookView, OccasionsView } from '../../shared/types'

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

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 页边一句话（P2）。
 *
 * 设计：它不是输入框改的对话框——没有发送按钮、没有对方正在输入、没有回复。
 * 只有一条窄窄的页边：写完就属于这一页。再点一下可以改或抹掉。
 */
function MarginNote({ date, text, onSave, onErase }: {
  date: string
  text?: string
  onSave: (date: string, text: string) => Promise<void>
  onErase: (date: string) => Promise<void>
}): React.ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text || '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDraft(text || '')
  }, [text])

  const commit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await onSave(date, draft)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <div className="nb-margin nb-margin-edit">
        <input
          className="nb-margin-input"
          value={draft}
          maxLength={60}
          autoFocus
          placeholder="在页边留一句…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit()
            if (e.key === 'Escape') {
              setDraft(text || '')
              setEditing(false)
            }
          }}
          onBlur={() => void commit()}
        />
      </div>
    )
  }

  if (text) {
    return (
      <div className="nb-margin nb-margin-written">
        <span className="nb-margin-text" onClick={() => setEditing(true)} title="点一下可改">
          {text}
        </span>
        <button
          className="nb-margin-del"
          title="抹掉这句"
          onClick={() => {
            if (busy) return
            setBusy(true)
            void onErase(date).finally(() => setBusy(false))
          }}
        >
          ×
        </button>
      </div>
    )
  }

  return (
    <button className="nb-margin nb-margin-empty" onClick={() => setEditing(true)}>
      留一句
    </button>
  )
}

export default function App(): React.ReactElement {
  const [view, setView] = useState<NotebookView>({ entries: [] })
  // 它记得的事：不是日记，但属于同一本本的「索引页」。
  // 日常记事**不放这里**——日记的规矩是「说感受，不说数据」，
  // 「今天花了10块」这类原文只在设置里管理，不污染日记本。
  const [occ, setOcc] = useState<OccasionsView | null>(null)
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
    // 这块失败不应该让整个笔记本打不开
    try {
      setOcc(await window.api.occasionsList())
    } catch {
      setOcc(null)
    }
  }, [])

  useEffect(() => {
    window.logger.info('notebook.load', 'start')
    void load()
  }, [load])

  // P2：页边一句话。写 / 抹都走真实的 IPC，成功后用返回的那一页就地更新，
  // 不整页刷新——用户正在页边上写字，不能让界面跳。
  const saveMargin = async (date: string, text: string): Promise<void> => {
    try {
      const entry = await window.api.writeNotebookMargin({ date, text })
      if (!entry) {
        // 空内容：等同于没写，保持原样
        return
      }
      setView((prev) => {
        const has = prev.entries.some((e) => e.date === date)
        const entries = has
          ? prev.entries.map((e) => (e.date === date ? { ...e, margin: entry.margin } : e))
          : [{ date: entry.date, lines: entry.lines, margin: entry.margin }, ...prev.entries]
        return { entries }
      })
    } catch (e) {
      setStatus({ kind: 'err', text: '没能写进页边：' + ((e as Error).message || e) })
    }
  }

  const eraseMargin = async (date: string): Promise<void> => {
    try {
      if (!(await window.api.eraseNotebookMargin(date))) return
      setView((prev) => ({ entries: prev.entries.map((e) => (e.date === date ? { ...e, margin: undefined } : e)) }))
    } catch (e) {
      setStatus({ kind: 'err', text: '没能抹掉：' + ((e as Error).message || e) })
    }
  }

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

      {occ && occ.occasions.length > 0 && (
        <section className="nb-index">
          <h2>它记得的事</h2>
          <ul>
            {occ.occasions.map((o) => (
              <li key={o.id}>
                <time>{formatDate(o.date)}</time>
                <span>{o.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {loading ? (
        <p className="nb-empty">正在翻页…</p>
      ) : (
        <>
          {view.entries.length === 0 && (
            <p className="nb-empty-hint nb-empty">
              笔记本还是空的。它会先记住一些关于你的事，等有素材了再写。
              <br />
              不过页边一直给你留着。
            </p>
          )}
          <ol className="nb-list">
            {/*
              今天这一页总要出现——哪怕猫今天没话说。
              页边是用户的，不该因为「今天没有日记」就没有地方落笔。
            */}
            {!view.entries.some((e) => e.date === todayKey()) && (
              <li key="__today" className="nb-entry nb-entry-today">
                <time className="nb-date">
                  {formatDate(todayKey())}
                  <span className="nb-weekday">{weekday(todayKey())}</span>
                </time>
                <div className="nb-lines">
                  <p className="nb-today-quiet">今天还没写。</p>
                  <MarginNote date={todayKey()} onSave={saveMargin} onErase={eraseMargin} />
                </div>
              </li>
            )}
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
                  <MarginNote date={e.date} text={e.margin?.text} onSave={saveMargin} onErase={eraseMargin} />
                </div>
              </li>
            ))}
          </ol>
        </>
      )}

      <footer className="nb-footer">
        只存在这台电脑上 · 不会同步、不会分享 · 页边的话只有你和它看得到
      </footer>
    </div>
  )
}
