// Duyệt kế hoạch (SPEC-PLAN-HANDOFF FR-102, FR-103): hiện kế hoạch của lượt Kế hoạch, cho sửa trước khi duyệt.
//   Kế hoạch trước: Duyệt và thực hiện / Góp ý / Từ chối
//   Chỉ kế hoạch:   Chấp nhận kết quả (Done) / Góp ý / Từ chối
import { useEffect, useState } from 'react'
import { Check, ClipboardList, Loader2, MessageSquareReply, Pencil, Play, X } from 'lucide-react'
import { approvePlan, approveTask, rejectTask, requestChanges } from '../store/store'
import { Markdown } from './Markdown'
import { Button, ConfirmDialog, inputCls } from './ui'
import { MAX_PLAN_LENGTH } from '../lib/planMode'
import { MIN_FEEDBACK } from '../lib/review'
import { duration, usd } from '../lib/format'
import { tr } from '../lib/i18n'
import type { Run, Task } from '../types'

export function PlanReview({ task, planRun, onSent }: { task: Task; planRun?: Run; onSent: () => void }) {
  const original = planRun?.summary ?? ''
  const [editing, setEditing] = useState(false)
  const [plan, setPlan] = useState(original)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState<null | 'approve' | 'feedback' | 'reject'>(null)
  const [confirmReject, setConfirmReject] = useState(false)
  // Lượt Kế hoạch mới (sau Góp ý): bỏ bản đang sửa, hiện kế hoạch mới.
  useEffect(() => {
    setPlan(original)
    setEditing(false)
  }, [planRun?.id])

  const only = task.planMode === 'only'
  const edited = plan.trim() !== original.trim()
  const tooLong = plan.length > MAX_PLAN_LENGTH

  const run = async (kind: 'approve' | 'feedback' | 'reject', fn: () => Promise<boolean> | boolean) => {
    if (busy) return
    setBusy(kind)
    try {
      if (await fn()) onSent()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-indigo-200 bg-white p-3 text-sm dark:border-indigo-900 dark:bg-slate-900">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <ClipboardList size={16} className="text-indigo-600 dark:text-indigo-400" />
          <span className="font-medium">{only ? tr('Kết quả phân tích (task chỉ phân tích, không sửa code)') : tr('Kế hoạch chờ duyệt')}</span>
          {planRun && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {planRun.endedAt ? duration(planRun.endedAt - planRun.startedAt) : ''}
              {planRun.costUsd !== undefined && ` · ${usd(planRun.costUsd)}`}
            </span>
          )}
          {!only && (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditing((v) => !v)} disabled={!!busy}>
              <Pencil size={13} /> {editing ? tr('Xem') : tr('Sửa kế hoạch')}
            </Button>
          )}
        </div>
        {editing ? (
          <>
            <textarea className={`${inputCls} min-h-[320px] font-mono text-xs`} value={plan} onChange={(e) => setPlan(e.target.value)} />
            {tooLong && <p className="mt-1 text-xs text-rose-600">{tr('Kế hoạch tối đa {n} ký tự', { n: MAX_PLAN_LENGTH.toLocaleString() })}</p>}
          </>
        ) : plan.trim() ? (
          <div className="max-h-[32rem] overflow-y-auto pr-1">
            <Markdown text={plan} />
          </div>
        ) : (
          <p className="text-slate-500 dark:text-slate-400">{tr('Agent không trả về nội dung. Hãy Góp ý để agent làm lại.')}</p>
        )}
        {!only && edited && !editing && <p className="mt-2 text-xs text-indigo-700 dark:text-indigo-300">{tr('Bạn đã sửa kế hoạch. Agent sẽ làm theo bản đã sửa.')}</p>}
      </div>

      <div className="sticky bottom-0 -mx-1 rounded-lg border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
        {feedbackOpen ? (
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {only ? tr('Góp ý cho kết quả (agent làm lại, vẫn không sửa code)') : tr('Góp ý cho kế hoạch (agent lập lại kế hoạch, vẫn chưa sửa code)')}
            </label>
            <textarea
              autoFocus
              className={`${inputCls} min-h-[90px]`}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder={tr('VD: Không đổi schema DB; tách bước 3 thành task riêng…')}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={!!busy} onClick={() => setFeedbackOpen(false)}>
                {tr('Huỷ')}
              </Button>
              <Button
                variant="primary"
                disabled={!!busy || feedback.trim().length < MIN_FEEDBACK}
                onClick={() =>
                  run('feedback', async () => {
                    const ok = await requestChanges(task.id, feedback.trim())
                    if (ok) {
                      setFeedback('')
                      setFeedbackOpen(false)
                    }
                    return ok
                  })
                }
              >
                {busy === 'feedback' ? <Loader2 size={16} className="animate-spin" /> : <MessageSquareReply size={16} />} {tr('Gửi góp ý')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto text-sm text-slate-500 dark:text-slate-400">
              {only ? tr('Task chỉ phân tích: chấp nhận sẽ chuyển task sang Done.') : tr('Agent chưa sửa code. Duyệt thì agent bắt đầu làm theo kế hoạch.')}
            </span>
            <Button variant="ghost" className="text-rose-600" disabled={!!busy} onClick={() => setConfirmReject(true)}>
              {busy === 'reject' ? <Loader2 size={16} className="animate-spin" /> : <X size={16} />} {tr('Từ chối')}
            </Button>
            <Button disabled={!!busy} onClick={() => setFeedbackOpen(true)}>
              <MessageSquareReply size={16} /> {tr('Góp ý')}
            </Button>
            {only ? (
              <Button variant="success" disabled={!!busy} onClick={() => run('approve', () => approveTask(task.id))}>
                {busy === 'approve' ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} {tr('Chấp nhận kết quả')}
              </Button>
            ) : (
              <Button
                variant="success"
                disabled={!!busy || !plan.trim() || tooLong}
                onClick={() => run('approve', () => approvePlan(task.id, edited ? plan : undefined))}
              >
                {busy === 'approve' ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />} {tr('Duyệt và thực hiện')}
              </Button>
            )}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmReject}
        title={tr('Từ chối kế hoạch?')}
        message={tr('Task chuyển sang Failed. Bạn vẫn có thể Chạy lại để agent lập kế hoạch mới.')}
        confirmLabel={tr('Từ chối')}
        danger
        onConfirm={() => void run('reject', () => rejectTask(task.id))}
        onClose={() => setConfirmReject(false)}
      />
    </div>
  )
}
