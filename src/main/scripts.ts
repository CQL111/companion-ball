// scripts.ts - 运行时路径
// dev：electron-vite 输出在 out/{main,preload,renderer}，__dirname 为 out/main
// packaged：resources/app.asar/out/{main,preload,renderer}，相对关系不变
import path from 'node:path'

const OUT = path.join(__dirname, '..')

export const preloadPath = path.join(OUT, 'preload', 'index.js')
export const rendererDir = path.join(OUT, 'renderer')

export function rendererFile(name: string): string {
  return path.join(rendererDir, name, 'index.html')
}

export function appRoot(): string {
  // out/main/index.js → 仓库根 / asar 根
  return path.join(__dirname, '..', '..')
}

// 图标/托盘等静态资源：dev 用仓库 resources/，packaged 用 resources/
export function resourceFile(name: string): string {
  if (process.resourcesPath && process.env.NODE_ENV !== 'development') {
    return path.join(process.resourcesPath, name)
  }
  return path.join(appRoot(), 'resources', name)
}

/** 加载渲染端页面，可选 query（法律文档用） */
export function loadRenderer(win: Electron.BrowserWindow, name: string, search?: string): void {
  const file = rendererFile(name)
  if (search) win.loadFile(file, { search })
  else win.loadFile(file)
}
