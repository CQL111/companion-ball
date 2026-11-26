import { useCallback, useEffect, useState } from 'react'
import { api, explain, type FlagItem } from '../api'

const DESCRIPTIONS: Record<string, { title: string; when: string }> = {
  EMERGENCY_OFF: { title: '封海', when: '被刷、被攻击、发现严重漏洞。关掉所有写接口。' },
  GALLERY_OFF: { title: '关橱窗', when: '出现待处理的有害内容、合规要求。' },
  NEWS_OFF: { title: '关新闻', when: '发错内容、来源版权问题。' },
  REPLY_OFF: { title: '关回信', when: '回信被滥用（扔瓶仍开着）。' },
}

/** 封海：紧急开关。每个开关必须写理由，审计里要能看出「为什么关」。 */
export function Flags({ role }: { role: string }): React.ReactElement {
  const [items, setItems] = useState<FlagItem[]>([])
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try {
      setItems((await api.flags()).items)
    } catch (e) {
      setMsg(explain(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (f: FlagItem): Promise<void> => {
    if (!reason.trim()) {
      setMsg('开关必须写理由——审计里要能看出为什么')
      return
    }
    try {
      await api.setFlag(f.key, !f.value, reason.trim())
      setReason('')
      setMsg(f.value ? `已恢复 ${f.key}` : `已关闭 ${f.key}`)
      await load()
    } catch (e) {
      setMsg(explain(e))
    }
  }

  const readOnly = role !== 'admin'

  return (
    <>
      <h1>封海</h1>
      <p className="sub">紧急开关。改动会写进审计，且必须带理由。</p>

      {msg && <div className="status ok">{msg}</div>}

      <div className="card">
        <h3>理由</h3>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="比如：举报量异常，先关橱窗排查" />
      </div>

      {items.map((f) => {
        const d = DESCRIPTIONS[f.key] ?? { title: f.key, when: '' }
        return (
          <div key={f.key} className="item">
            <div className="row">
              <div className="grow">
                <strong>{d.title}</strong>
                <div className="hint">{d.when}</div>
                {f.reason && (
                  <div className="hint" style={{ marginTop: 4 }}>
                    上次理由：{f.reason}
                  </div>
                )}
              </div>
              <span className={`tag ${f.value ? 'danger' : 'ok'}`}>{f.value ? '已关闭' : '正常'}</span>
              <button
                className={`btn sm ${f.value ? 'ok' : 'danger'}`}
                disabled={readOnly}
                onClick={() => void toggle(f)}
              >
                {f.value ? '恢复' : '关闭'}
              </button>
            </div>
          </div>
        )
      })}
      {readOnly && <p className="hint">只有 admin 能改开关。</p>}
    </>
  )
}
