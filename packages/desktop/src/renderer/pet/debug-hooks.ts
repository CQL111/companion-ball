// debug-hooks.ts - 调试入口（仅供开发与 e2e）
//
// 为什么单独一个文件：
//   在正式构建里**完全不 import 它**（见 pet.ts 里由 __COMPANION_DEBUG__ 控制的分支），
//   这样调试代码一行都不会进最终产物——不依赖 tree-shaking 的脾气。
//
// 两种构建：
//   开发（npm run dev）           → 调试入口存在
//   e2e（npm run build:e2e）      → 调试入口存在
//   正式（npm run build / release）→ 本文件不被引用，产物里没有 debugSpeak

export interface DebugHost {
  /** 触发一次带原因的开口 */
  speak(kind: 'need' | 'sit' | 'back' | 'idle'): void
  /** 强制睡眠（验证「睡觉时不表达需求」） */
  sleep(on: boolean): string
  /** 走真实的「用户回来」路径：等于收到 presence-back */
  returnBack(awayMs: number): void
}

export function installDebugHooks(host: DebugHost): void {
  ;(window as unknown as { debugSpeak?: DebugHost['speak'] }).debugSpeak = (kind) => host.speak(kind)
  ;(window as unknown as { debugSleep?: DebugHost['sleep'] }).debugSleep = (on) => host.sleep(on)
  ;(window as unknown as { debugReturn?: DebugHost['returnBack'] }).debugReturn = (ms) => host.returnBack(ms)
}
