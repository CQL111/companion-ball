// vite-env.d.ts - Vite 资源导入的 TypeScript 声明
/// <reference types="vite/client" />

declare module '*?url' {
  const src: string
  export default src
}
