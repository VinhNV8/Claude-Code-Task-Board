import { useEffect, useState, type FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
import { Button, Field, inputCls } from '../components/ui'
import { login } from '../lib/auth'

/** Màn hình đăng nhập bằng token khi truy cập từ xa (PLAN 4.7). */
export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  // Giữ giao diện sáng/tối giống Layout
  useEffect(() => {
    let dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    try {
      const v = localStorage.getItem('theme')
      if (v) dark = v === 'dark'
    } catch {
      /* bỏ qua */
    }
    document.documentElement.classList.toggle('dark', dark)
    document.title = 'Đăng nhập · Claude Task Board'
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!token.trim()) return setError('Nhập token đăng nhập')
    setBusy(true)
    const err = await login(token.trim())
    setBusy(false)
    if (err) setError(err)
    else onSuccess()
  }

  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 px-4 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex items-center gap-2 font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-indigo-600 text-sm text-white">CT</span>
          Claude Task Board
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Truy cập từ xa cần đăng nhập. Nhập token đã đặt trong biến <span className="font-mono">TASKBOARD_AUTH_TOKEN</span> trên máy chạy backend.
        </p>
        <Field label="Token" error={error}>
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            className={inputCls}
            value={token}
            onChange={(e) => {
              setToken(e.target.value)
              setError(undefined)
            }}
          />
        </Field>
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          <KeyRound size={16} /> {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </Button>
      </form>
    </div>
  )
}
