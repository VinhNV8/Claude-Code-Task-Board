import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { STATUS_META } from '../lib/format'
import type { TaskStatus } from '../types'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-300 dark:disabled:bg-indigo-900',
  secondary:
    'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-700',
  ghost: 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
  danger: 'bg-rose-600 text-white hover:bg-rose-500',
  success: 'bg-emerald-600 text-white hover:bg-emerald-500',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm'
      } ${VARIANTS[variant]} ${className}`}
    />
  )
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  const m = STATUS_META[status]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${m.badge}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot} ${status === 'running' ? 'animate-pulse' : ''}`} />
      {m.label}
    </span>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 pt-[8vh]" onMouseDown={onClose}>
      <div
        className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-xl bg-white shadow-xl dark:bg-slate-900 dark:ring-1 dark:ring-slate-800`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Đóng">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800">{footer}</div>}
      </div>
    </div>
  )
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Xác nhận',
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  message: ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => {
              onConfirm()
              onClose()
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-slate-600 dark:text-slate-300">{message}</div>
    </Modal>
  )
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="text-slate-300 dark:text-slate-600">{icon}</div>
      <p className="font-medium text-slate-700 dark:text-slate-200">{title}</p>
      {body && <p className="max-w-sm text-sm text-slate-500 dark:text-slate-400">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export const inputCls =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-950'

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{label}</span>
      {children}
      {error ? (
        <span className="block text-xs text-rose-600">{error}</span>
      ) : (
        hint && <span className="block text-xs text-slate-500 dark:text-slate-400">{hint}</span>
      )}
    </label>
  )
}

/** Re-render định kỳ để cập nhật thời gian chạy, đếm ngược... */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
