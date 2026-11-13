import type { Priority, TaskStatus } from '../types.ts'

export const STATUS_META: Record<TaskStatus, { label: string; dot: string; badge: string; col: string; text: string }> = {
  backlog: { label: 'Chờ chạy', dot: 'bg-slate-400', badge: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300', col: 'border-t-slate-400', text: 'text-slate-400 dark:text-slate-500' },
  queued: { label: 'Hàng đợi', dot: 'bg-sky-500', badge: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300', col: 'border-t-sky-500', text: 'text-sky-500' },
  running: { label: 'Đang chạy', dot: 'bg-indigo-500', badge: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300', col: 'border-t-indigo-500', text: 'text-indigo-500 dark:text-indigo-400' },
  needs_input: { label: 'Cần bạn', dot: 'bg-amber-500', badge: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300', col: 'border-t-amber-500', text: 'text-amber-500' },
  review: { label: 'Chờ duyệt', dot: 'bg-violet-500', badge: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300', col: 'border-t-violet-500', text: 'text-violet-500 dark:text-violet-400' },
  done: { label: 'Xong', dot: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300', col: 'border-t-emerald-500', text: 'text-emerald-500' },
  failed: { label: 'Lỗi', dot: 'bg-rose-500', badge: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300', col: 'border-t-rose-500', text: 'text-rose-500' },
}

export const STATUS_ORDER: TaskStatus[] = ['backlog', 'queued', 'running', 'needs_input', 'review', 'done', 'failed']

export const PRIORITY_META: Record<Priority, { label: string; cls: string }> = {
  urgent: { label: 'Khẩn cấp', cls: 'text-rose-600 dark:text-rose-400' },
  high: { label: 'Cao', cls: 'text-orange-600 dark:text-orange-400' },
  normal: { label: 'Bình thường', cls: 'text-slate-500 dark:text-slate-400' },
  low: { label: 'Thấp', cls: 'text-slate-400 dark:text-slate-500' },
}

export function timeAgo(ts: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s} giây trước`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} phút trước`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} giờ trước`
  return `${Math.round(h / 24)} ngày trước`
}

export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return m > 0 ? `${m}p ${r.toString().padStart(2, '0')}s` : `${r}s`
}

export function clock(ts: number) {
  return new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Giờ:phút theo giờ máy, ví dụ "15:30". */
export function hhmm(ts: number) {
  return new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
}

export function usd(v?: number) {
  return v === undefined ? '—' : `$${v.toFixed(2)}`
}

export type ModelTier = 'haiku' | 'sonnet' | 'opus' | 'other'

const FAMILIES = ['haiku', 'sonnet', 'opus'] as const
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

/**
 * Tên model dễ đọc: "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-5" → "Sonnet 5", alias "opus" → "Opus".
 * Bỏ hậu tố ngày ("-20250929") và "[1m]". Không khớp mẫu thì trả nguyên chuỗi, rỗng/undefined thì "—".
 */
export function modelLabel(id?: string): string {
  if (!id) return '—'
  const s = id.trim().toLowerCase()
  if ((FAMILIES as readonly string[]).includes(s)) return cap(s)
  const m = /^claude-(haiku|sonnet|opus)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/.exec(s)
  if (!m) return id
  return `${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

/** Bậc model theo họ (haiku/sonnet/opus), dùng cho màu hiển thị và nâng bậc. */
export function modelTier(id?: string): ModelTier {
  if (!id) return 'other'
  const s = id.trim().toLowerCase()
  if ((FAMILIES as readonly string[]).includes(s)) return s as ModelTier
  const m = /^claude-(haiku|sonnet|opus)(?:-|$)/.exec(s)
  return m ? (m[1] as ModelTier) : 'other'
}
