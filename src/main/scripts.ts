// scripts.ts - 运行时路径
// dev：electron-vite 输出在 out/{main,preload,renderer}，__dirname 为 out/main
// packaged：resources/app.asar/out/{main,preload,renderer}，相对关系不变
//
// 关键：判断「是否打包」只能看 app.isPackaged。
// electron-vite 不会把 .env 里的 NODE_ENV 注入主进程，用 process.env.NODE_ENV
// 判断会导致 dev 模式下把 resources 路径指到 electron 自身的 dist/resources（那里没有我们的图标），
// 图标静默变成空图——托盘图标「消失」的根因就在这里。
import path from 'node:path'
import { app } from 'electron'

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

/** 图标/托盘等静态资源：dev 用仓库 resources/，打包后由 extraResources 放在 resourcesPath */
export function resourceFile(name: string): string {
  if (app.isPackaged && process.resourcesPath) {
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
