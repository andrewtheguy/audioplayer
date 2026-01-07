import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'

// Register service worker with auto-update
registerSW({
  onRegistered(registration) {
    if (registration) {
      console.log('Service worker registered')
    }
  },
  onRegisterError(error) {
    console.error('Service worker registration error:', error)
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
