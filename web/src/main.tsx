import React, { Suspense, lazy, useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { fetchAuthStatus } from './lib/auth'
import { Login } from './pages/Login'
import './index.css'

// App (và store/WebSocket) chỉ được nạp sau khi qua bước đăng nhập (PLAN 4.7).
const App = lazy(() => import('./App').then((m) => ({ default: m.App })))

function AuthGate() {
  const [state, setState] = useState<'checking' | 'login' | 'ok'>('checking')
  useEffect(() => {
    fetchAuthStatus()
      .then((s) => setState(s.required && !s.authenticated ? 'login' : 'ok'))
      // Backend chưa chạy: vào app, store tự hiện "mất kết nối" và thử lại
      .catch(() => setState('ok'))
  }, [])
  if (state === 'checking') return null
  if (state === 'login') return <Login onSuccess={() => setState('ok')} />
  return (
    <Suspense fallback={null}>
      <App />
    </Suspense>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate />
  </React.StrictMode>,
)
