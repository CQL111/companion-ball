import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../renderer-logger'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
