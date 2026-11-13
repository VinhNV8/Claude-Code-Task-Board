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
      <StatusGlyph status={status} size={12} />
      {m.label}
    </span>
  )
}

/**
 * Glyph trạng thái: hình dạng nói trạng thái, màu chỉ để nhấn (phân biệt được cả khi mù màu).
 * Chờ chạy: vòng nét đứt · Hàng đợi: vòng có chấm · Đang chạy: nửa vòng (xoay) · Cần bạn: chấm than ·
 * Chờ duyệt: ba phần tư · Xong: dấu tích · Lỗi: dấu nhân.
 */
export function StatusGlyph({ status, size = 14, className = '' }: { status: TaskStatus; size?: number; className?: string }) {
  const cls = `inline-block shrink-0 ${STATUS_META[status].text} ${status === 'running' ? 'animate-spin [animation-duration:2.4s] motion-reduce:animate-none' : ''} ${className}`
  const ring = <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
  let body: ReactNode
  switch (status) {
    case 'backlog':
      body = <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.2 2" />
      break
    case 'queued':
      body = (
        <>
          {ring}
          <circle cx="7" cy="7" r="1.8" fill="currentColor" />
        </>
      )
      break
    case 'running':
      body = (
        <>
          {ring}
          <path d="M7 3.2A3.8 3.8 0 0 1 7 10.8Z" fill="currentColor" />
        </>
      )
      break
    case 'needs_input':
      body = (
        <>
          <circle cx="7" cy="7" r="6.3" fill="currentColor" />
          <rect x="6.2" y="3.4" width="1.6" height="4.6" rx=".8" fill="#fff" />
          <circle cx="7" cy="10" r=".95" fill="#fff" />
        </>
      )
      break
    case 'review':
      body = (
        <>
          {ring}
          <path d="M7 3.2A3.8 3.8 0 1 1 3.2 7L7 7Z" fill="currentColor" />
        </>
      )
      break
    case 'done':
      body = (
        <>
          <circle cx="7" cy="7" r="6.3" fill="currentColor" />
          <path d="M4.3 7.2l1.8 1.8 3.6-3.8" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )
      break
    default:
      body = (
        <>
          <circle cx="7" cy="7" r="6.3" fill="currentColor" />
          <path d="M4.9 4.9l4.2 4.2M9.1 4.9l-4.2 4.2" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className={cls} aria-hidden="true">
      {body}
    </svg>
  )
}

/** Theo dõi media query (vd. màn hình ≥ md) để đổi bố cục giữa desktop và điện thoại. */
export function useMediaQuery(query: string) {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false)
  const [match, setMatch] = useState(get)
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia(query)
    const h = () => setMatch(mq.matches)
    h()
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [query])
  return match
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
