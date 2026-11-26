import { useCallback, useEffect, useState } from 'react'
import { api, explain, type LeadItem } from '../api'

/**
 * 线索：由外部爬虫推送，等待编辑消化。
 * **没有任何自动发布路径**——爬虫只「发现」，人负责判断与成文（WINDOW 第五节）。
 */
export function Leads(): React.ReactElement {
  const [items, setItems] = useState<LeadItem[]>([])
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try {
      setItems((await api.leads('new')).items)
    } catch (e) {
      setMsg(explain(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const ignore = async (id: string): Promise<void> => {
    try {
      await api.ignoreLead(id)
      await load()
    } catch (e) {
      setMsg(explain(e))
    }
  }

  return (
    <>
      <h1>线索</h1>
      <p className="sub">
        爬虫只负责发现，不负责成文。用它写一条时会跳到编辑器并预填来源——正文必须重写，不能全文转载。
      </p>

      {msg && <div className="status err">{msg}</div>}

      {items.length === 0 ? (
        <div className="empty">没有新线索。没有也可以——不是每天都必须发。</div>
      ) : (
        items.map((l) => (
          <div key={l.id} className="item">
            <div className="body">{l.rawTitle}</div>
            <div className="meta">
              <span>{l.sourceName}</span>
              <span className="tag">{l.suggestedCategory}</span>
              <span>{new Date(l.fetchedAt).toLocaleString()}</span>
              <span className="grow" />
              <a
                className="btn sm"
                href={`#/news`}
                onClick={() => sessionStorage.setItem('lead-prefill', JSON.stringify(l))}
              >
                用它写一条
              </a>
              <button className="btn sm" onClick={() => void ignore(l.id)}>
                忽略
              </button>
            </div>
            <p className="hint" style={{ marginTop: 6 }}>
              {l.rawSummary}
            </p>
          </div>
        ))
      )}
    </>
  )
}
