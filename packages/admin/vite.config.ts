import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// 产物直接进 server 的静态资源目录（同源部署，见 docs/PLATFORM.md 第三节）
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: {
    outDir: resolve(__dirname, '../server/public/admin'),
    emptyOutDir: true,
    sourcemap: false,
  },
  resolve: {
    alias: { '@companion/contracts': resolve(__dirname, '../contracts/src/index.ts') },
  },
  server: {
    proxy: { '/admin/api': 'http://127.0.0.1:8787' },
  },
})
