import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const root = __dirname
const alias = {
  '@shared': resolve(root, 'src/shared'),
  '@core': resolve(root, 'src/core'),
  '@contracts': resolve(root, '../contracts/src/index.ts'),
  '@legal-data': resolve(root, 'src/legal-data.js'),
}

/**
 * 调试入口（window.debugSpeak / debugSleep 等）的开关。
 *   - 开发模式（npm run dev）：始终开启
 *   - 生产构建：默认**关闭**（正式版不该有后门）
 *   - 但 e2e 需要它：用 COMPANION_E2E=1 构建即可，产物只用于测试
 * 这是**编译期**常量，打包后无法在运行时打开。
 */
const debugHooks = process.env.COMPANION_E2E === '1'

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(root, 'src/main/index.ts') },
        // 运行时依赖不打进 bundle：electron-store 走 CJS 的 require
        external: ['electron', 'electron-store'],
      },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: 'index.js' },
        external: ['electron'],
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    resolve: { alias },
    plugins: [react()],
    // 调试入口的编译期开关必须也在 renderer 生效（pet.ts 在渲染进程里）
    define: {
      __COMPANION_DEBUG__: JSON.stringify(debugHooks),
    },
    build: {
      outDir: resolve(root, 'out/renderer'),
      // 正式版压缩：既减小体积，也让 `if (false) { ... }` 的死代码被真正消除。
      // e2e 构建（debugHooks=true）同样压缩，行为一致。
      minify: 'esbuild',
      rollupOptions: {
        output: {
          // 调试钩子用独立 chunk：正式构建里这段代码不可达，esbuild 会摇掉；
          // 同时保证它不会混进宠物主 chunk 影响首帧。
          manualChunks: undefined,
        },
        input: {
          pet: resolve(root, 'src/renderer/pet/index.html'),
          chat: resolve(root, 'src/renderer/chat/index.html'),
          settings: resolve(root, 'src/renderer/settings/index.html'),
          consent: resolve(root, 'src/renderer/consent/index.html'),
          legal: resolve(root, 'src/renderer/legal/index.html'),
          notebook: resolve(root, 'src/renderer/notebook/index.html'),
          mail: resolve(root, 'src/renderer/mail/index.html'),
        },
      },
    },
  },
})
