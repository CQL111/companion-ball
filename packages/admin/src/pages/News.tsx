import { useCallback, useEffect, useState } from 'react'
import { api, explain, type NewsItem } from '../api'

const CATEGORIES = [
  { k: 'rain', l: '雨' },
  { k: 'night', l: '夜' },
  { k: 'city', l: '城市' },
  { k: 'cat', l: '猫' },
  { k: 'other', l: '其他' },
] as const

const empty = { title: '', summary: '', body: '', sourceName: '', sourceUrl: '', category: 'other' }

/** 海的记录：新闻编排。每天最多一条；发布前要预览两次。 */
export function News(): React.ReactElement {
  const [items, setItems] = useState<NewsItem[]>([])
  const [draft, setDraft] = useState<{ id?: string } & typeof empty>(empty)
  const [status, setStatus] = useState('')
  const [msg, setMsg] = useState('')
  const [confirm, setConfirm] = useState(false)

  const load = useCallback(async () => {
    try {
      setItems((await api.news(status)).items)
    } catch (e) {
      setMsg(explain(e))
    }
  }, [status])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (): Promise<string | null> => {
    if (!draft.title || !draft.summary || !draft.body) {
      setMsg('标题、摘要、正文都要填')
      return null
    }
    try {
      if (draft.id) {
        await api.updateNews(draft.id, draft)
        setMsg('已保存')
        return draft.id
      }
      const r = await api.createNews(draft)
      setDraft({ ...draft, id: r.id })
      setMsg('草稿已建立')
      await load()
      return r.id
    } catch (e) {
      setMsg(explain(e))
      return null
    }
  }

  const publish = async (): Promise<void> => {
    if (!confirm) {
      setConfirm(true)
      setMsg('这条会进入用户的笔记本，发出后不能收回。再点一次确认。')
      return
    }
    const id = draft.id ?? (await save())
    if (!id) return
    try {
      await api.publishNews(id)
      setConfirm(false)
      setMsg('已发布')
      setDraft(empty)
      await load()
    } catch (e) {
      setMsg(explain(e))
    }
  }

  const archive = async (id: string): Promise<void> => {
    try {
      await api.archiveNews(id)
      await load()
    } catch (e) {
      setMsg(explain(e))
    }
  }

  const f = (k: keyof typeof empty) => ({
    value: draft[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      setConfirm(false)
      setDraft((d) => ({ ...d, [k]: e.target.value }))
    },
  })

  return (
    <>
      <h1>海的记录</h1>
      <p className="sub">官方编辑，猫的口吻，每天最多一条。会进用户的笔记本。</p>

      {msg && <div className="status ok">{msg}</div>}

      <div className="card">
        <h3>写一条</h3>
        <div className="field">
          <label>
            标题 <span className="count">{draft.title.length}/30</span>
          </label>
          <input {...f('title')} maxLength={30} placeholder="今天的海说了什么" />
        </div>
        <div className="field">
          <label>
            摘要 <span className="count">{draft.summary.length}/60</span>
          </label>
          <input {...f('summary')} maxLength={60} placeholder="一句话，会显示在列表里" />
        </div>
        <div className="field">
          <label>
            正文 <span className="count">{draft.body.length}/200</span>
          </label>
          <textarea {...f('body')} maxLength={200} placeholder="第一人称，说感受不说数据，不制造焦虑" />
        </div>
        <div className="row">
          <div className="field grow" style={{ marginBottom: 0 }}>
            <label>分类</label>
            <select {...f('category')}>
              {CATEGORIES.map((c) => (
                <option key={c.k} value={c.k}>
                  {c.l}
                </option>
              ))}
            </select>
          </div>
          <div className="field grow" style={{ marginBottom: 0 }}>
            <label>来源名</label>
            <input {...f('sourceName')} maxLength={80} placeholder="只展示名字，不给链接" />
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void save()}>
            存草稿
          </button>
          <button className={`btn ${confirm ? 'danger' : 'primary'}`} onClick={() => void publish()}>
            {confirm ? '确认发布' : '发布'}
          </button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        {[
          { k: '', l: '全部' },
          { k: 'draft', l: '草稿' },
          { k: 'published', l: '已发布' },
          { k: 'archived', l: '已下架' },
        ].map((s) => (
          <button key={s.k} className={`btn ${status === s.k ? 'primary' : ''}`} onClick={() => setStatus(s.k)}>
            {s.l}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="empty">还没有这里的记录。</div>
      ) : (
        items.map((n) => (
          <div key={n.id} className="item">
            <div className="body">{n.title}</div>
            <div className="meta">
              <span className="tag">{n.status}</span>
              <span className="tag">{CATEGORIES.find((c) => c.k === n.category)?.l ?? n.category}</span>
              <span>{n.summary}</span>
              <span className="grow" />
              {n.status === 'draft' && (
                <button
                  className="btn sm"
                  onClick={() =>
                    setDraft({
                      id: n.id,
                      title: n.title,
                      summary: n.summary,
                      body: n.body,
                      sourceName: n.sourceName ?? '',
                      sourceUrl: n.sourceUrl ?? '',
                      category: n.category,
                    })
                  }
                >
                  编辑
                </button>
              )}
              {n.status === 'published' && (
                <button className="btn danger sm" onClick={() => void archive(n.id)}>
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
