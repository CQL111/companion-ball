// sound.ts - 极轻的合成音效（WebAudio，不引入音频文件）
// 原则：默认开、可关、音量很低；只在有意义的时刻响（落地、被摸、倒挂）。
// 用户没交互过之前 AudioContext 处于 suspended，首次交互后自动恢复。

let ctx: AudioContext | null = null
let enabled = true

export function setSoundEnabled(next: boolean): void {
  enabled = next
}

function context(): AudioContext | null {
  if (!enabled) return null
  if (!ctx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

function blip(freq: number, durationMs: number, gain: number, type: OscillatorType = 'sine'): void {
  const ac = context()
  if (!ac) return
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, ac.currentTime)
  // 快速衰减，避免长音显得吵
  g.gain.setValueAtTime(0.0001, ac.currentTime)
  g.gain.exponentialRampToValueAtTime(gain, ac.currentTime + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + durationMs / 1000)
  osc.connect(g).connect(ac.destination)
  osc.start()
  osc.stop(ac.currentTime + durationMs / 1000 + 0.02)
}

export type SoundName = 'land' | 'soft' | 'pat' | 'meow'

/** 播放一个短音；所有音都很轻，且只在用户设置允许时播放 */
export function playSound(name: SoundName): void {
  if (!enabled) return
  switch (name) {
    case 'land':
      // 落地：低频短促
      blip(180, 90, 0.05, 'triangle')
      break
    case 'soft':
      // 轻响（比如爬上顶部）：更轻更高
      blip(520, 60, 0.02)
      break
    case 'pat':
      // 摸头：两个快速上行音
      blip(660, 70, 0.03)
      setTimeout(() => blip(880, 70, 0.025), 70)
      break
    case 'meow':
      // 叫一声：滑音
      blip(520, 160, 0.035, 'sine')
      setTimeout(() => blip(700, 120, 0.02, 'sine'), 80)
      break
  }
}
