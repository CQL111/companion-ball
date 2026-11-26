import { useCallback, useEffect, useState } from 'react'
import { api, explain, type GalleryItem, type ReportItem } from '../api'

type Tab = 'pending' | 'reports'

const poolLabel: Record<string, string> = { night: '深夜', morning: '清晨', day: '白天', evening: '傍晚' }

/** 值班：两栏——橱窗待审 / 被举报。2 小时 SLA 由概览告警推动。 */
export function Moderation(): React.ReactElement {
  const [tab, setTab] = useState<Tab>('pending')
  const [items, setItems] = useState<GalleryItem[]>([])
  const [reports, setReports] = useState<ReportItem[]>([])
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState<string>('')

  const load = useCallback(async () => {
    setMsg('')
    try {
      if (tab === 'pending') setItems((await api.moderation('pending')).items)
      else setReports((await api.reports()).items)
    } catch (e) {
      setMsg(explain(e))
    }
  }, [tab])

  useEffect(() => {
    void load()
  }, [load])

  const review = async (id: string, action: 'approve' | 'reject'): Promise<void> => {
    setBusy(id)
    try {
      await api.review(id, action, action === 'approve' ? '批准公开' : '不适合公开')
      await load()
    } catch (e) {
      setMsg(explain(e))
    } finally {
      setBusy('')
    }
  }

  const handleReport = async (id: string, action: 'hide' | 'keep'): Promise<void> => {
    setBusy(id)
    try {
      await api.handleReport(id, action)
      await load()
    } catch (e) {
      setMsg(explain(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <h1>值班</h1>
      <p className="sub">用户主动公开的、以及被别人举报的内容。私池永远不在这里。</p>

      <div className="row" style={{ marginBottom: 14 }}>
        <button className={`btn ${tab === 'pending' ? 'primary' : ''}`} onClick={() => setTab('pending')}>
          橱窗待审 {tab === 'pending' && items.length ? `(${items.length})` : ''}
        </button>
        <button className={`btn ${tab === 'reports' ? 'primary' : ''}`} onClick={() => setTab('reports')}>
          被举报 {tab === 'reports' && reports.length ? `(${reports.length})` : ''}
        </button>
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
      </div>

      {msg && <div className="status err">{msg}</div>}

      {tab === 'pending' &&
        (items.length === 0 ? (
          <div className="empty">没有待审的内容。海面很平静。</div>
        ) : (
          items.map((it) => (
            <div key={it.id} className="item">
              <div className="body">{it.body}</div>
              <div className="meta">
                <span>—— {it.alias}</span>
                <span className="tag">{poolLabel[it.pool] ?? it.pool}</span>
                {it.seed && <span className="tag seed">种子</span>}
                {it.sourceBottle && <span className="mono">来源 {it.sourceBottle.slice(0, 8)}</span>}
                <span className="grow" />
                <button className="btn ok sm" disabled={busy === it.id} onClick={() => void review(it.id, 'approve')}>
                  批准
                </button>
                <button className="btn danger sm" disabled={busy === it.id} onClick={() => void review(it.id, 'reject')}>
                  驳回
                </button>
              </div>
            </div>
          ))
        ))}

      {tab === 'reports' &&
        (reports.length === 0 ? (
          <div className="empty">没有待处理的举报。</div>
        ) : (
          reports.map((r) => (
            <div key={r.id} className="item">
              <div className="body">{r.target?.body ?? '（内容已被删除）'}</div>
              <div className="meta">
                <span>—— {r.target?.alias ?? '—'}</span>
                <span className="tag danger">{r.reason}</span>
                {r.target?.kind === 'reply' && <span className="tag">回信</span>}
                {r.target?.hidden && <span className="tag">已隐藏</span>}
                <span className="grow" />
                <button className="btn danger sm" disabled={busy === r.id} onClick={() => void handleReport(r.id, 'hide')}>
                  下架
                </button>
                <button className="btn sm" disabled={busy === r.id} onClick={() => void handleReport(r.id, 'keep')}>
                  保留
                </button>
              </div>
            </div>
          ))
        ))}
    </>
  )
}
