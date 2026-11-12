import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Hand, ShieldCheck, Timer, X } from 'lucide-react'
import type { PermissionRequest, Task } from '../types'
import { decidePermission } from '../store/store'
import { duration } from '../lib/format'
import { permissionDisplay, permissionTimeLeft } from '../lib/notify'
import { Button, inputCls, useNow } from './ui'

type Choice = 'allow' | 'deny' | 'always'

/** Gợi ý nhanh cho lý do từ chối (FR-46). */
export const DENY_REASON_HINTS = ['Dùng pnpm thay npm', 'Không cài thêm thư viện', 'Không chạm vào file này']
const MAX_REASON = 500

/**
 * Ô nhập lý do từ chối (không bắt buộc) + gợi ý nhanh. Enter gửi, Esc huỷ.
 * Dùng chung cho thẻ từng yêu cầu và nút "Từ chối tất cả" ở Inbox.
 */
export function DenyReasonBox({
  busy,
  submitLabel = 'Từ chối',
  onSubmit,
  onCancel,
}: {
  busy?: boolean
  submitLabel?: string
  onSubmit: (reason: string) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const submit = () => !busy && onSubmit(reason.trim())
  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
      <label className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
        Lý do từ chối (không bắt buộc), Claude sẽ dùng để đổi cách làm
      </label>
      <input
        ref={ref}
        className={inputCls}
        value={reason}
        maxLength={MAX_REASON}
        placeholder="Ví dụ: Dùng pnpm thay npm"
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }
        }}
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {DENY_REASON_HINTS.map((h) => (
          <button
            key={h}
            type="button"
            onClick={() => {
              setReason(h)
              ref.current?.focus()
            }}
            className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            {h}
          </button>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Huỷ
        </Button>
        <Button variant="danger" size="sm" disabled={busy} onClick={submit}>
          <X size={14} /> {submitLabel}
        </Button>
      </div>
    </div>
  )
}

export function PermissionCard({ req, task, showTask }: { req: PermissionRequest; task?: Task; showTask?: boolean }) {
  const now = useNow(1000)
  // Mốc timeoutAt do server tính lúc tạo yêu cầu; quá hạn thì server tự từ chối và broadcast, thẻ tự biến mất.
  const left = permissionTimeLeft(req.timeoutAt, now)
  const [busy, setBusy] = useState<Choice | null>(null)
  const [denying, setDenying] = useState(false)

  async function decide(d: Choice, reason?: string) {
    if (busy) return
    setBusy(d)
    try {
      await decidePermission(req.id, d, reason)
    } finally {
      setBusy(null)
    }
  }

  // Rủi ro cao (FR-45): viền đỏ, nêu lý do, không có "Luôn cho phép" (server cũng chặn)
  const high = req.risk === 'high'

  return (
    <div
      className={
        high
          ? 'rounded-lg border-2 border-red-400 bg-red-50 p-4 dark:border-red-700 dark:bg-red-950/30'
          : 'rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30'
      }
    >
      <div className="flex flex-wrap items-start gap-3">
        <Hand className={`mt-0.5 shrink-0 ${high ? 'text-red-600' : 'text-amber-600'}`} size={20} />
        <div className="min-w-0 flex-1">
          {high && (
            <div className="mb-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">
                ⚠ Rủi ro cao
              </span>
              {!!req.riskReasons?.length && (
                <ul className="mt-1.5 list-disc pl-5 text-sm text-red-800 dark:text-red-300">
                  {req.riskReasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className={`font-medium ${high ? 'text-red-900 dark:text-red-200' : 'text-amber-900 dark:text-amber-200'}`}>
            Claude xin quyền dùng <span className="font-mono">{req.tool}</span>
            {showTask && task && (
              <>
                {' '}
                trong{' '}
                <Link to={`/tasks/${task.id}`} className="underline">
                  #{task.id} {task.title}
                </Link>
              </>
            )}
          </p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-slate-900 px-3 py-2 font-mono text-[13px] text-slate-100">{permissionDisplay(req)}</pre>
          <p className="mt-2 inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
            <Timer size={13} /> {left > 0 ? `Tự động từ chối sau ${duration(left)}` : 'Hết thời gian chờ, đang tự động từ chối…'}
          </p>
        </div>
      </div>
      {denying && (
        <DenyReasonBox busy={!!busy} onSubmit={(r) => decide('deny', r)} onCancel={() => setDenying(false)} />
      )}
      <div className={`mt-3 flex flex-wrap justify-end gap-2 ${denying ? 'hidden' : ''}`}>
        <Button variant="secondary" disabled={!!busy} onClick={() => setDenying(true)}>
          <X size={16} /> Từ chối
        </Button>
        {!high && (
          <Button
            variant="secondary"
            disabled={!!busy}
            onClick={() => decide('always')}
            title={`Cho phép và thêm quy tắc vào project${req.rules?.length ? `: ${req.rules.join(', ')}` : ''}`}
          >
            <ShieldCheck size={16} /> Luôn cho phép
          </Button>
        )}
        <Button variant="success" disabled={!!busy} onClick={() => decide('allow')}>
          <Check size={16} /> Cho phép
        </Button>
      </div>
    </div>
  )
}
