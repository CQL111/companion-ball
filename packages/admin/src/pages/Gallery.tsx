import { useCallback, useEffect, useState } from 'react'
import { api, explain, type GalleryItem } from '../api'

const POOLS = [
  { k: 'night', l: '深夜' },
  { k: 'morning', l: '清晨' },
  { k: 'day', l: '白天' },
  { k: 'evening', l: '傍晚' },
]

/** 橱窗：已批准 / 已下架的管理 + 写官方种子 */
export function Gallery(): React.ReactElement {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [status, setStatus] = useState('approved')
  const [msg, setMsg] = useState('')
  const [seedText, setSeedText] = useState('')
  const [seedPool, setSeedPool] = useState('night')

  const load = useCallback(async () => {
    try {
      setItems((await api.gallery(`?status=${status}`)).items)
    } catch (e) {
      setMsg(explain(e))
    }
  }, [status])

  useEffect(() => {
    void load()
  }, [load])

  const unpublish = async (id: string): Promise<void> => {
    try {
      await api.unpublish(id, '运营下架')
      await load()
    } catch (e) {
      setMsg(explain(e))
    }
  }

  const addSeed = async (): Promise<void> => {
    if (!seedText.trim()) return
    try {
      await api.addSeed(seedText.trim(), seedPool)
      setSeedText('')
      setMsg('已加入待审（种子不显示在前台标记）')
      setStatus('pending')
    } catch (e) {
      setMsg(explain(e))
    }
  }

  return (
    <>
      <h1>橱窗</h1>
      <p className="sub">网页上别人能看到的东西。种子内容前台不标记，但这里会亮出来。</p>

      {msg && <div className="status ok">{msg}</div>}

      <div className="card">
        <h3>写一条官方种子</h3>
        <p className="hint" style={{ marginBottom: 8 }}>
          以普通人的口吻写。种子永不进入私池，用户捡不到；占比超过 30% 概览会告警。
        </p>
        <div className="row">
          <select style={{ width: 110 }} value={seedPool} onChange={(e) => setSeedPool(e.target.value)}>
            {POOLS.map((p) => (
              <option key={p.k} value={p.k}>
                {p.l}
              </option>
            ))}
          </select>
          <input
            className="grow"
            value={seedText}
            maxLength={60}
            placeholder="比如：今天风很大，我想起小时候的窗台。"
            onChange={(e) => setSeedText(e.target.value)}
          />
          <button className="btn primary" onClick={() => void addSeed()}>
            加入待审
          </button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        {['approved', 'pending', 'withdrawn', 'rejected'].map((s) => (
          <button key={s} className={`btn ${status === s ? 'primary' : ''}`} onClick={() => setStatus(s)}>
            {s === 'approved' ? '已上架' : s === 'pending' ? '待审' : s === 'withdrawn' ? '已下架' : '已驳回'}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="empty">这一栏是空的。</div>
      ) : (
        items.map((it) => (
          <div key={it.id} className="item">
            <div className="body">{it.body}</div>
            <div className="meta">
              <span>—— {it.alias}</span>
              <span className="tag">{POOLS.find((p) => p.k === it.pool)?.l ?? it.pool}</span>
              {it.seed && <span className="tag seed">种子</span>}
              {it.expiresAt && <span>到期 {new Date(it.expiresAt).toLocaleDateString()}</span>}
              <span className="grow" />
              {it.status === 'approved' && (
                <button className="btn danger sm" onClick={() => void unpublish(it.id)}>
                  下架
                </button>
              )}
            </div>
          </div>
        ))
      )}
    </>
  )
}
