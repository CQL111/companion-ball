import { useCallback, useEffect, useState } from 'react'
import type { LlmStatus, LocalModelsResult, OnlineAiConfigView } from '../../shared/types'

type StatusType = '' | 'ok' | 'err' | 'info'
interface StatusMsg {
  type: StatusType
  text: string
}

const LEGAL_DOCS = [
  { key: 'privacy', label: '隐私政策' },
  { key: 'terms', label: '用户协议' },
  { key: 'disclaimer', label: '免责声明' },
  { key: 'thirdparty', label: '第三方许可' },
] as const

export default function App(): React.ReactElement {
  const [llm, setLlm] = useState<LlmStatus | null>(null)
  const [online, setOnline] = useState<OnlineAiConfigView | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [token, setToken] = useState('')
  const [local, setLocal] = useState<LocalModelsResult | null>(null)
  const [localModel, setLocalModel] = useState('')
  const [pullName, setPullName] = useState('')
  const [pulling, setPulling] = useState(false)
  const [testing, setTesting] = useState(false)
  const [onlineStatus, setOnlineStatus] = useState<StatusMsg>({ type: '', text: '' })
  const [pullStatus, setPullStatus] = useState<StatusMsg>({ type: '', text: '' })
  const [animations, setAnimations] = useState(true)
  const [animHint, setAnimHint] = useState('')
  const [previewing, setPreviewing] = useState(false)

  // ---------- 载入 ----------
  const refreshLlmStatus = useCallback(async () => {
    try {
      const status = await window.api.getLlmStatus()
      setLlm(status)
    } catch {
      setLlm(null)
    }
  }, [])

  const loadOnline = useCallback(async () => {
    try {
      const cfg = await window.api.getOnlineAiConfig()
      setOnline(cfg)
      setBaseUrl(cfg.baseUrl || '')
      setModel(cfg.model || '')
      setToken('')
    } catch (e) {
      window.logger.warn('settings.online', `load failed: ${(e as Error).message}`)
    }
  }, [])

  const refreshLocalModels = useCallback(async () => {
    try {
      const result = await window.api.getLocalModels()
      setLocal(result)
    } catch (e) {
      setLocal(null)
      window.logger.warn('settings.local', `load failed: ${(e as Error).message}`)
    }
  }, [])

  useEffect(() => {
    window.logger.info('settings.load', 'start')
    // 动画开关只读本地配置，先加载，避免被 Ollama 探测拖慢
    void (async () => {
      try {
        const v = await window.api.getConfig('animations')
        setAnimations(v !== false)
      } catch {
        setAnimations(true)
      }
      await refreshLlmStatus()
      await loadOnline()
      await refreshLocalModels()
    })()
    // 当前本地模型不通过 get-config 暴露，改用 llm-status 的 source 判断
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!animations) setAnimHint('已关闭：不播放过渡与预览动画')
    else if (reduced) setAnimHint('系统已开启「减少动态效果」，将自动跳过动画')
    else setAnimHint('点击球时播放短暂的动作反馈')
  }, [animations])

  // ---------- 线上模型 ----------
  const saveOnline = async (): Promise<void> => {
    try {
      const result = await window.api.saveOnlineAiConfig({ baseUrl: baseUrl.trim(), model: model.trim(), token: token.trim() })
      setToken('')
      await loadOnline()
      await refreshLlmStatus()
      setOnlineStatus({ type: 'ok', text: result.tokenHint ? `✅ 已保存（${result.tokenHint}）` : '✅ 已保存' })
    } catch (e) {
      setOnlineStatus({ type: 'err', text: '保存失败：' + ((e as Error).message || e) })
    }
  }

  const testOnline = async (): Promise<void> => {
    setTesting(true)
    setOnlineStatus({ type: 'info', text: '正在测试连接…' })
    try {
      const result = await window.api.testOnlineAi()
      setOnlineStatus(
        result.ok
          ? { type: 'ok', text: `✅ 连接成功${result.model ? ' · ' + result.model : ''}` }
          : { type: 'err', text: '连接失败：' + (result.error || '未知错误') },
      )
    } catch (e) {
      setOnlineStatus({ type: 'err', text: '测试失败：' + ((e as Error).message || e) })
    } finally {
      setTesting(false)
    }
  }

  const clearToken = async (): Promise<void> => {
    try {
      const result = await window.api.clearOnlineAiToken()
      await loadOnline()
      await refreshLlmStatus()
      setOnlineStatus({
        type: result.ok ? 'ok' : 'err',
        text: result.hasToken ? '✅ 已清除本机保存的 Key，当前使用 .env' : '✅ 已清除，当前没有可用 Key',
      })
    } catch (e) {
      setOnlineStatus({ type: 'err', text: '清除失败：' + ((e as Error).message || e) })
    }
  }

  // ---------- 本地模型 ----------
  const selectLocal = async (name: string): Promise<void> => {
    setLocalModel(name)
    await window.api.setLocalModel(name)
    await refreshLlmStatus()
    setPullStatus({ type: 'info', text: name ? `已切换到本地模型 ${name}` : '已切换回线上模型' })
  }

  const useOnline = async (): Promise<void> => {
    setLocalModel('')
    await window.api.setLocalModel('')
    await refreshLlmStatus()
    setPullStatus({ type: 'info', text: '已切换回线上模型' })
  }

  const pull = async (): Promise<void> => {
    const name = pullName.trim()
    if (!name) {
      setPullStatus({ type: 'err', text: '请输入模型名' })
      return
    }
    setPulling(true)
    setPullStatus({ type: 'info', text: `正在下载 ${name}（大模型可能需要几分钟，请耐心等待）...` })
    try {
      const result = await window.api.pullLocalModel(name)
      if (result.ok) {
        setPullStatus({ type: 'ok', text: `✅ ${name} 下载完成` })
        setPullName('')
        await refreshLocalModels()
      } else {
        setPullStatus({ type: 'err', text: `下载失败：${result.error || '未知错误'}` })
      }
    } catch (e) {
      setPullStatus({ type: 'err', text: '下载失败：' + ((e as Error).message || e) })
    } finally {
      setPulling(false)
    }
  }

  // ---------- 动画 ----------
  const toggleAnimations = async (enabled: boolean): Promise<void> => {
    setAnimations(enabled)
    try {
      await window.api.saveConfig('animations', enabled)
    } catch {
      setAnimations(!enabled)
    }
  }

  const previewAnim = async (): Promise<void> => {
    setPreviewing(true)
    try {
      await window.api.previewBallAnim()
    } catch (e) {
      window.logger.warn('settings.anim', `preview failed: ${(e as Error).message}`)
    } finally {
      setTimeout(() => setPreviewing(false), 2600)
    }
  }

  // ---------- 渲染 ----------
  const llmText = !llm
    ? '模型状态检测失败'
    : llm.source === 'local'
      ? `🟢 当前：本地模型 ${llm.model}`
      : llm.source === 'online'
        ? `🌐 当前：线上模型 ${llm.model}`
        : '⚠️ 未配置 AI'
  const llmClass = !llm ? '' : llm.source === 'local' ? 'local' : llm.source === 'online' ? 'online' : 'none'

  const tokenHint = online
    ? online.fromBundled
      ? `当前使用应用内置 Key（${online.tokenHint}），留空则不修改`
      : online.fromEnv
        ? `当前使用 .env 中的 Key（${online.tokenHint}）`
        : online.hasToken
          ? `已保存 Key（${online.tokenHint}），留空则不修改`
          : '尚未配置 API Key，填入后点保存'
    : ''

  const localHint = !local
    ? '获取本地模型失败'
    : !local.available
      ? '未检测到 Ollama（本地推理服务）。请先安装并启动 Ollama，再点「刷新列表」。'
      : local.models.length === 0
        ? 'Ollama 已运行，但还没有模型。用下方「下载模型」拉取一个。'
        : `检测到 ${local.models.length} 个本地模型。选中即启用本地。`

  return (
    <div className="settings">
      <h1>设置</h1>

      <div className={`llm-status ${llmClass}`}>{llmText}</div>

      <section className="section">
        <h2>线上模型</h2>
        <p className="hint">
          填写后优先生效（优先级：设置面板 &gt; 本机 <code>.env</code> &gt; 应用内置 Key）。Key 只存在这台电脑，
          不会进 git，已保存的不必重填。
        </p>

        <label>
          <span>Base URL</span>
          <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" autoComplete="off" />
        </label>
        <label>
          <span>模型名</span>
          <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" autoComplete="off" />
        </label>
        <label>
          <span>API Key</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="留空表示不修改已保存的 Key" autoComplete="off" />
          <small>{tokenHint}</small>
        </label>
        <div className="row">
          <button className="btn primary" onClick={() => void saveOnline()}>保存线上配置</button>
          <button className="btn" onClick={() => void testOnline()} disabled={testing}>测试连接</button>
          <button className="btn ghost" onClick={() => void clearToken()}>清除已存 Key</button>
        </div>
        {onlineStatus.text && <div className={`status ${onlineStatus.type}`}>{onlineStatus.text}</div>}
      </section>

      <section className="section">
        <h2>本地模型</h2>
        <p className="hint">本机已装 Ollama 时可改用本地模型；选空则继续用上面的线上配置。</p>
        <label>
          <span>当前本地模型</span>
          <select value={localModel} onChange={(e) => void selectLocal(e.target.value)}>
            <option value="">（使用线上 DeepSeek）</option>
            {(local?.models || []).map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
                {m.sizeLabel ? `（${m.sizeLabel}）` : ''}
              </option>
            ))}
          </select>
          <small>{localHint}</small>
        </label>
        <div className="row">
          <button className="btn" onClick={() => void refreshLocalModels()}>刷新列表</button>
          <button className="btn ghost" onClick={() => void useOnline()}>使用线上</button>
        </div>
      </section>

      <section className="section">
        <h2>下载本地模型</h2>
        <p className="hint">
          输入模型名（如 <code>qwen2.5:7b</code>、<code>llama3</code>），从 Ollama 下载到本机。
        </p>
        <div className="row">
          <input
            type="text"
            value={pullName}
            onChange={(e) => setPullName(e.target.value)}
            placeholder="qwen2.5:7b"
            autoComplete="off"
          />
          <button className="btn primary" onClick={() => void pull()} disabled={pulling}>下载</button>
        </div>
        {pullStatus.text && <div className={`status ${pullStatus.type}`}>{pullStatus.text}</div>}
      </section>

      <section className="section">
        <h2>桌面形象</h2>
        <p className="hint">S0 仅团子猫一种形象；S7 会以「角色包 / 皮肤」扩展，届时在此切换。</p>
        <label>
          <span>形象</span>
          <select value="cat" disabled>
            <option value="cat">团子猫</option>
          </select>
          <small>当前版本只有一种形象</small>
        </label>
      </section>

      <section className="section">
        <h2>动画</h2>
        <p className="hint">角色互动时播放轻量动画。系统开启「减少动态效果」时会自动跳过。</p>
        <label className="switch-row">
          <input type="checkbox" checked={animations} onChange={(e) => void toggleAnimations(e.target.checked)} />
          <span className="switch-track"><i /></span>
          <span className="switch-label">播放角色动画</span>
        </label>
        <p className="hint">S0 骨架：动画细节随 S1「它有自己的生活」扩展。</p>
        <div className="row">
          <button className="btn" onClick={() => void previewAnim()} disabled={previewing}>▶ 预览动画</button>
          <small className={`inline-hint${animHint.includes('系统') ? ' warn' : ''}`}>{animHint}</small>
        </div>
      </section>

      <section className="section">
        <h2>关于</h2>
        <p className="hint">桌面陪伴 · 团子猫 · 本应用核心功能离线可用，AI 为可选增强。</p>
        <div className="row legal-row">
          {LEGAL_DOCS.map((d) => (
            <button key={d.key} className="btn legal-btn" onClick={() => void window.api.openLegal(d.key)}>
              {d.label}
            </button>
          ))}
        </div>
        <p className="hint legal-note">AI 回复由用户自行配置的模型生成，仅供参考，不构成医疗、法律或投资建议。</p>
      </section>
    </div>
  )
}
