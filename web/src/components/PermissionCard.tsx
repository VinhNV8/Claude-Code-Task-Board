import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Hand, Loader2, MessageCircleQuestion, Send, ShieldCheck, SkipForward, Timer, X } from 'lucide-react'
import type { PermissionRequest, Question, Task } from '../types'
import { answerQuestion, decidePermission } from '../store/store'
import { MAX_ANSWER, joinSelected } from '../lib/question'
import { duration } from '../lib/format'
import { permissionDisplay, permissionTimeLeft } from '../lib/notify'
import { Button, inputCls, useNow } from './ui'
import { tr } from '../lib/i18n'

type Choice = 'allow' | 'deny' | 'always'

/** Gợi ý nhanh cho lý do từ chối (FR-46). */
export const DENY_REASON_HINTS = [tr('Dùng pnpm thay npm'), tr('Không cài thêm thư viện'), tr('Không chạm vào file này')]
const MAX_REASON = 500

/**
 * Ô nhập lý do từ chối (không bắt buộc) + gợi ý nhanh. Enter gửi, Esc huỷ.
 * Dùng chung cho thẻ từng yêu cầu và nút "Từ chối tất cả" ở Inbox.
 */
export function DenyReasonBox({
  busy,
  submitLabel = tr('Từ chối'),
  label = tr('Lý do từ chối (không bắt buộc), Claude sẽ dùng để đổi cách làm'),
  placeholder = tr('Ví dụ: Dùng pnpm thay npm'),
  hints = DENY_REASON_HINTS,
  onSubmit,
  onCancel,
}: {
  busy?: boolean
  submitLabel?: string
  label?: string
  placeholder?: string
  hints?: string[]
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
        {label}
      </label>
      <input
        ref={ref}
        className={inputCls}
        value={reason}
        maxLength={MAX_REASON}
        placeholder={placeholder}
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
      <div className={`mt-2 flex flex-wrap gap-1.5 ${hints.length ? '' : 'hidden'}`}>
        {hints.map((h) => (
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
          {tr('Huỷ')}
        </Button>
        <Button variant="danger" size="sm" disabled={busy} onClick={submit}>
          <X size={14} /> {submitLabel}
        </Button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------ câu hỏi của Claude (FR-40)

/** Lựa chọn của một câu hỏi: các nhãn đã chọn + ô "Khác" tự nhập. */
interface Pick1 {
  selected: string[]
  otherOn: boolean
  other: string
}

/** Câu trả lời ghép từ lựa chọn: một đáp án → nhãn hoặc câu tự nhập; nhiều đáp án → nối bằng ", ". */
export function answerOf(q: Question, p: Pick1): string {
  const other = p.otherOn ? p.other.trim() : ''
  if (q.multiSelect) return joinSelected([...p.selected, other])
  return other || p.selected[0] || ''
}

/**
 * Form trả lời AskUserQuestion: radio (một đáp án) hoặc checkbox (nhiều đáp án), luôn có ô "Khác".
 * Gửi thì Claude chạy tiếp ngay với đáp án; Bỏ qua thì Claude tự quyết (có thể kèm ghi chú).
 */
export function QuestionForm({ req, compact }: { req: PermissionRequest; compact?: boolean }) {
  const questions = req.questions ?? []
  const [picks, setPicks] = useState<Pick1[]>(() => questions.map(() => ({ selected: [], otherOn: false, other: '' })))
  const [busy, setBusy] = useState(false)
  const [skipping, setSkipping] = useState(false)
  const answers = questions.map((q, i) => answerOf(q, picks[i] ?? { selected: [], otherOn: false, other: '' }))
  const ready = answers.every((a) => a.length > 0)
  const update = (i: number, f: (p: Pick1) => Pick1) => setPicks((ps) => ps.map((p, j) => (j === i ? f(p) : p)))

  async function run(fn: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  const submit = () => ready && run(() => answerQuestion(req.id, Object.fromEntries(questions.map((q, i) => [q.question, answers[i]]))))

  return (
    <div className={compact ? 'space-y-3' : 'mt-3 space-y-4'}>
      {questions.map((q, i) => {
        const p = picks[i]
        const name = `q-${req.id}-${i}`
        const toggle = (label: string) =>
          update(i, (x) =>
            q.multiSelect
              ? { ...x, selected: x.selected.includes(label) ? x.selected.filter((l) => l !== label) : [...x.selected, label] }
              : { ...x, selected: [label], otherOn: false },
          )
        return (
          <fieldset key={q.question} className="space-y-1.5">
            <legend className="mb-1 text-sm font-medium text-slate-800 dark:text-slate-100">
              {q.header && <span className="mr-1.5 rounded bg-sky-100 px-1.5 py-0.5 text-xs font-semibold text-sky-800 dark:bg-sky-900/60 dark:text-sky-200">{q.header}</span>}
              {q.question}
              {q.multiSelect && <span className="ml-1 text-xs font-normal text-slate-500">{tr('(chọn nhiều)')}</span>}
            </legend>
            {q.options.map((o) => (
              <label key={o.label} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 text-sm hover:bg-sky-100/60 dark:hover:bg-sky-900/30">
                <input
                  type={q.multiSelect ? 'checkbox' : 'radio'}
                  name={name}
                  className="mt-1"
                  disabled={busy}
                  checked={p.selected.includes(o.label) && (q.multiSelect || !p.otherOn)}
                  onChange={() => toggle(o.label)}
                />
                <span>
                  {o.label}
                  {o.description && !compact && <span className="block text-xs text-slate-500 dark:text-slate-400">{o.description}</span>}
                </span>
              </label>
            ))}
            <label className="flex items-center gap-2 rounded-md px-2 py-1 text-sm">
              <input
                type={q.multiSelect ? 'checkbox' : 'radio'}
                name={name}
                disabled={busy}
                checked={p.otherOn}
                onChange={() => update(i, (x) => ({ ...x, otherOn: q.multiSelect ? !x.otherOn : true }))}
              />
              <input
                className={inputCls}
                placeholder={tr('Khác: tự nhập câu trả lời')}
                value={p.other}
                maxLength={MAX_ANSWER}
                disabled={busy}
                onFocus={() => !p.otherOn && update(i, (x) => ({ ...x, otherOn: true }))}
                onChange={(e) => update(i, (x) => ({ ...x, other: e.target.value, otherOn: true }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submit()
                  }
                }}
              />
            </label>
          </fieldset>
        )
      })}
      {skipping ? (
        <DenyReasonBox
          busy={busy}
          submitLabel={tr('Bỏ qua')}
          label={tr('Ghi chú cho Claude (không bắt buộc). Claude sẽ tự quyết theo hướng an toàn')}
          placeholder={tr('Ví dụ: Chọn cách đơn giản nhất')}
          hints={[tr('Chọn cách đơn giản nhất'), tr('Giữ nguyên hành vi hiện tại')]}
          onSubmit={(r) => run(() => decidePermission(req.id, 'deny', r))}
          onCancel={() => setSkipping(false)}
        />
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size={compact ? 'sm' : undefined} disabled={busy} onClick={() => setSkipping(true)} title={tr('Claude sẽ tự quyết và ghi rõ giả định')}>
            <SkipForward size={compact ? 13 : 16} /> {tr('Bỏ qua')}
          </Button>
          <Button variant="primary" size={compact ? 'sm' : undefined} disabled={busy || !ready} onClick={submit}>
            {busy ? <Loader2 size={compact ? 13 : 16} className="animate-spin" /> : <Send size={compact ? 13 : 16} />} {tr('Gửi câu trả lời')}
          </Button>
        </div>
      )}
    </div>
  )
}

function QuestionCard({ req, task, showTask }: { req: PermissionRequest; task?: Task; showTask?: boolean }) {
  const now = useNow(1000)
  const left = permissionTimeLeft(req.timeoutAt, now)
  return (
    <div className="rounded-lg border border-sky-300 bg-sky-50 p-4 dark:border-sky-800 dark:bg-sky-950/30">
      <div className="flex flex-wrap items-start gap-3">
        <MessageCircleQuestion className="mt-0.5 shrink-0 text-sky-600" size={20} />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sky-900 dark:text-sky-200">
            {tr('Claude hỏi bạn')}
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
          <p className="mt-1 inline-flex items-center gap-1 text-xs text-sky-700 dark:text-sky-400">
            <Timer size={13} /> {left > 0 ? tr('Claude sẽ tự quyết sau {time} nếu chưa có câu trả lời', { time: duration(left) }) : tr('Hết thời gian chờ, Claude đang tự quyết…')}
          </p>
          <QuestionForm req={req} />
        </div>
      </div>
    </div>
  )
}

export function PermissionCard({ req, task, showTask }: { req: PermissionRequest; task?: Task; showTask?: boolean }) {
  if (req.questions?.length) return <QuestionCard req={req} task={task} showTask={showTask} />
  return <ToolPermissionCard req={req} task={task} showTask={showTask} />
}

function ToolPermissionCard({ req, task, showTask }: { req: PermissionRequest; task?: Task; showTask?: boolean }) {
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
                {tr('⚠ Rủi ro cao')}
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
            {tr('Claude xin quyền dùng')} <span className="font-mono">{req.tool}</span>
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
            <Timer size={13} /> {left > 0 ? tr('Tự động từ chối sau {time}', { time: duration(left) }) : tr('Hết thời gian chờ, đang tự động từ chối…')}
          </p>
        </div>
      </div>
      {denying && (
        <DenyReasonBox busy={!!busy} onSubmit={(r) => decide('deny', r)} onCancel={() => setDenying(false)} />
      )}
      <div className={`mt-3 flex flex-wrap justify-end gap-2 ${denying ? 'hidden' : ''}`}>
        <Button variant="secondary" disabled={!!busy} onClick={() => setDenying(true)}>
          <X size={16} /> {tr('Từ chối')}
        </Button>
        {!high && (
          <Button
            variant="secondary"
            disabled={!!busy}
            onClick={() => decide('always')}
            title={req.rules?.length ? tr('Cho phép và thêm quy tắc vào project: {rules}', { rules: req.rules.join(', ') }) : tr('Cho phép và thêm quy tắc vào project')}
          >
            <ShieldCheck size={16} /> {tr('Luôn cho phép')}
          </Button>
        )}
        <Button variant="success" disabled={!!busy} onClick={() => decide('allow')}>
          <Check size={16} /> {tr('Cho phép')}
        </Button>
      </div>
    </div>
  )
}
