import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const root = __dirname
const alias = {
  '@shared': resolve(root, 'src/shared'),
  '@core': resolve(root, 'src/core'),
  '@legal-data': resolve(root, 'src/legal-data.js'),
}

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
    build: {
      outDir: resolve(root, 'out/renderer'),
      rollupOptions: {
        input: {
          pet: resolve(root, 'src/renderer/pet/index.html'),
          chat: resolve(root, 'src/renderer/chat/index.html'),
          settings: resolve(root, 'src/renderer/settings/index.html'),
          consent: resolve(root, 'src/renderer/consent/index.html'),
          legal: resolve(root, 'src/renderer/legal/index.html'),
          notebook: resolve(root, 'src/renderer/notebook/index.html'),
        },
      },
    },
  },
})
