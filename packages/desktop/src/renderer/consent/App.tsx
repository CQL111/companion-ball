import { useState } from 'react'

const DOCS = [
  { key: 'privacy', label: '隐私政策' },
  { key: 'terms', label: '用户协议' },
  { key: 'disclaimer', label: '免责声明' },
  { key: 'thirdparty', label: '第三方许可' },
] as const

export default function App(): React.ReactElement {
  const [agreed, setAgreed] = useState(false)

  const accept = (): void => {
    if (!agreed) return
    window.logger.info('consent', 'accepted')
    void window.api.acceptConsent()
  }

  return (
    <div className="wrap">
      <div className="badge">COMPANION</div>
      <h1>
        欢迎使用<span>桌面陪伴</span>
      </h1>
      <p className="lead">一只常驻桌角的团子猫。开始前，请花一分钟了解以下内容：</p>

      <ul className="points">
        <li>
          <b>核心功能完全离线</b>
          <span>角色、拖拽、位置记忆与聊天记录都保存在本机。</span>
        </li>
        <li>
          <b>AI 是可选增强</b>
          <span>只有你主动聊天时，问题与最近几轮对话才会发送给你配置的模型服务。不配置 Key 也能正常使用。</span>
        </li>
        <li>
          <b>许愿瓶默认关闭</b>
          <span>开启后，你写给陌生人的纸条会发送到服务器（最多保留 7 天）。不开启则不产生任何请求。</span>
        </li>
        <li>
          <b>AI 内容仅供参考</b>
          <span>模型回答可能不准确，不构成医疗、法律或投资建议。</span>
        </li>
      </ul>

      <div className="docs">
        {DOCS.map((d) => (
          <button key={d.key} className="link" onClick={() => void window.api.openLegal(d.key)}>
            {d.label}
          </button>
        ))}
      </div>

      <label className="agree">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>我已阅读并同意《用户协议》《隐私政策》与《免责声明》</span>
      </label>

      <div className="actions">
        <button
          className="btn ghost"
          onClick={() => {
            window.logger.info('consent', 'quit')
            void window.api.quitApp()
          }}
        >
          退出
        </button>
        <button className="btn primary" disabled={!agreed} onClick={accept}>
          同意并开始
        </button>
      </div>
      <p className="note">你可以随时在「设置 → 关于」中重新查看这些文档。</p>
    </div>
  )
}
