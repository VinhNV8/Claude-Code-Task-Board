import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  Check,
  FileText,
  GitBranch,
  GitMerge,
  History,
  Hourglass,
  ListTree,
  Loader2,
  MessageSquareReply,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Square,
  StepForward,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
  XCircle,
} from 'lucide-react'
import { Markdown, stripMarkdown } from '../components/Markdown'
import {
  approveTask,
  deleteTask,
  ensureDiff,
  ensureEvents,
  queueTask,
  rejectTask,
  requestChanges,
  resumeTask,
  retryTask,
  stopTask,
  unqueueTask,
  useStore,
} from '../store/store'
import { Button, ConfirmDialog, EmptyState, StatusBadge, inputCls, useNow } from '../components/ui'
import { LogView } from '../components/LogView'
import { DiffView } from '../components/DiffView'
import { TestPanel } from '../components/TestPanel'
import { PermissionCard } from '../components/PermissionCard'
import { TaskFormModal } from '../components/TaskFormModal'
import { PRIORITY_META, clock, duration, hhmm, timeAgo, usd } from '../lib/format'
import { MIN_FEEDBACK, buildHistory, needsDiffFetch } from '../lib/review'
import { STOP_REASON, canResume, isWaitingRateLimit } from '../lib/resume'
import type { Run } from '../types'

type Tab = 'log' | 'review' | 'result' | 'history' | 'prompt'

const RUN_KIND: Record<Run['kind'], string> = {
  initial: 'Lần đầu',
  resume: 'Sửa theo feedback',
  retry: 'Chạy lại',
  continue: 'Tiếp tục',
}

export function TaskDetail() {
  const { id } = useParams()
  const s = useStore()
  const navigate = useNavigate()
  const now = useNow(1000)
  const [params, setParams] = useSearchParams()
  const task = s.tasks.find((t) => t.id === Number(id))
  const project = s.projects.find((p) => p.id === task?.projectId)
  const runs = useMemo(() => s.runs.filter((r) => r.taskId === task?.id), [s.runs, task?.id])
  const loadedDiff = task ? s.diffs[task.id] : undefined
  const diffs = loadedDiff ?? []
  const pending = s.permissions.filter((p) => p.taskId === task?.id && p.status === 'pending')
  const reviews = useMemo(() => s.reviews.filter((r) => r.taskId === task?.id), [s.reviews, task?.id])
  const history = useMemo(() => buildHistory(runs, reviews), [runs, reviews])

  const [runId, setRunId] = useState<string | undefined>()
  const [edit, setEdit] = useState(false)
  const [confirm, setConfirm] = useState<null | 'delete' | 'reject' | 'stop' | 'retry'>(null)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  // Đang gửi approve/request changes/reject: khoá cả thanh hành động để không bấm hai lần
  const [busy, setBusy] = useState<null | 'approve' | 'request_changes' | 'reject'>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)

  // Diff có sẵn trong state (task Review hoặc broadcast); chưa có thì tải khi mở task (PLAN 2.9)
  const wantDiff = !!task && needsDiffFetch(task, s.diffs)
  const loadDiff = (force = false) => {
    if (!task) return
    let alive = true
    setDiffLoading(true)
    setDiffError(null)
    ensureDiff(task.id, force).then((err) => {
      if (!alive) return
      setDiffLoading(false)
      setDiffError(err)
    })
    return () => {
      alive = false
    }
  }
  useEffect(() => {
    setDiffError(null)
    setDiffLoading(false)
    if (wantDiff) return loadDiff()
  }, [task?.id, wantDiff])

  const submitReview = async (action: 'approve' | 'request_changes' | 'reject') => {
    if (!task || busy) return
    setBusy(action)
    try {
      if (action === 'approve') await approveTask(task.id)
      else if (action === 'reject') await rejectTask(task.id)
      else if (await requestChanges(task.id, feedback.trim())) {
        setFeedback('')
        setFeedbackOpen(false)
        setTab('log')
      }
    } finally {
      setBusy(null)
    }
  }

  const latestRun = runs[runs.length - 1]
  const shownRun = runs.find((r) => r.id === runId) ?? latestRun
  const events = s.events.filter((e) => e.runId === shownRun?.id)

  const tab = (params.get('tab') as Tab) || (task?.status === 'review' ? 'review' : 'log')
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true })

  // khi có run mới, chuyển sang xem run mới nhất
  useEffect(() => setRunId(undefined), [runs.length])
  // tải log của lần chạy đang xem (bản thật tải theo yêu cầu)
  useEffect(() => {
    if (shownRun) ensureEvents(shownRun.id)
  }, [shownRun?.id])

  if (!task)
    return (
      <EmptyState
        icon={<XCircle size={48} />}
        title="Không tìm thấy task"
        body="Task có thể đã bị xoá."
        action={
          <Link to="/" className="text-sm text-indigo-600 underline">
            Về bảng công việc
          </Link>
        }
      />
    )

  const live = task.status === 'running' && shownRun?.id === latestRun?.id
  const editable = task.status === 'backlog' || task.status === 'queued'
  const totalCost = runs.reduce((a, r) => a + (r.costUsd ?? 0), 0)
  const waiting = isWaitingRateLimit(task, now)
  const resumable = canResume(task, now)
  const paused = task.status === 'failed' && task.failReason === STOP_REASON

  const tabs: { id: Tab; label: string; icon: JSX.Element; count?: number; hidden?: boolean }[] = [
    { id: 'log', label: 'Log', icon: <ListTree size={15} /> },
    {
      id: 'review',
      label: 'Thay đổi / Review',
      icon: <GitBranch size={15} />,
      count: diffs.length,
      hidden: diffs.length === 0 && task.status !== 'review' && !diffLoading,
    },
    { id: 'result', label: 'Kết quả', icon: <Check size={15} /> },
    { id: 'history', label: 'Lịch sử', icon: <History size={15} />, count: runs.length },
    { id: 'prompt', label: 'Yêu cầu', icon: <FileText size={15} /> },
  ]

  return (
    <div className="mx-auto max-w-6xl">
      <button onClick={() => navigate(-1)} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
        <ArrowLeft size={15} /> Quay lại
      </button>

      {/* Header */}
      <div className="mb-4 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <span className="font-mono">#{task.id}</span>
            <StatusBadge status={task.status} />
            <span>{project?.name}</span>
            <span className={PRIORITY_META[task.priority].cls}>· {PRIORITY_META[task.priority].label}</span>
            {task.branch && (
              <span className="inline-flex items-center gap-1 font-mono text-xs">
                <GitBranch size={12} /> {task.branch}
              </span>
            )}
          </div>
          <h1 className="text-xl font-semibold">{task.title}</h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Tạo {timeAgo(task.createdAt, now)} · Cập nhật {timeAgo(task.updatedAt, now)}
            {task.status === 'running' && task.startedAt && <> · Đang chạy {duration(now - task.startedAt)}</>}
            {totalCost > 0 && <> · Tổng chi phí {usd(totalCost)}</>}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {task.status === 'backlog' && (
            <Button variant="primary" onClick={() => queueTask(task.id)}>
              <Play size={16} /> Chạy
            </Button>
          )}
          {task.status === 'queued' && (
            <Button onClick={() => unqueueTask(task.id)}>
              <Undo2 size={16} /> Bỏ khỏi hàng đợi
            </Button>
          )}
          {editable && (
            <>
              <Button onClick={() => setEdit(true)}>
                <Pencil size={16} /> Sửa
              </Button>
              <Button variant="ghost" onClick={() => setConfirm('delete')} className="text-rose-600">
                <Trash2 size={16} /> Xoá
              </Button>
            </>
          )}
          {(task.status === 'running' || task.status === 'needs_input') && (
            <Button variant="danger" onClick={() => setConfirm('stop')}>
              <Square size={14} /> Tạm dừng
            </Button>
          )}
          {waiting && (
            <Button variant="primary" onClick={() => resumeTask(task.id)} title="Không chờ tới giờ reset giới hạn sử dụng">
              <StepForward size={16} /> Tiếp tục ngay
            </Button>
          )}
          {task.status === 'failed' && resumable && (
            <Button variant="primary" onClick={() => resumeTask(task.id)} title="Giữ thay đổi đang dở, chạy tiếp phiên Claude cũ">
              <StepForward size={16} /> Tiếp tục
            </Button>
          )}
          {task.status === 'failed' && (
            <Button
              variant={resumable ? 'secondary' : 'primary'}
              onClick={() => (resumable ? setConfirm('retry') : retryTask(task.id))}
              title="Bỏ thay đổi đang dở, chạy lại từ đầu trên nhánh chính"
            >
              <RotateCcw size={16} /> Chạy lại
            </Button>
          )}
        </div>
      </div>

      {/* Banner trạng thái */}
      {pending.map((p) => (
        <div key={p.id} className="mb-4">
          <PermissionCard req={p} />
        </div>
      ))}
      {task.status === 'failed' && paused && (
        <div className="mb-4 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <Pause size={18} className="shrink-0" />
          <div>
            <p className="font-medium">Task đã tạm dừng</p>
            <p>
              {resumable
                ? 'Bấm Tiếp tục để Claude chạy tiếp phiên cũ trên các thay đổi đang dở, hoặc Chạy lại để làm lại từ đầu.'
                : 'Không còn worktree của lần chạy trước, chỉ có thể Chạy lại từ đầu.'}
            </p>
          </div>
        </div>
      )}
      {task.status === 'failed' && !paused && task.failReason && (
        <div className="mb-4 flex gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <XCircle size={18} className="shrink-0" />
          <div>
            <p className="font-medium">Task thất bại</p>
            <p>{task.failReason}</p>
            {resumable && (
              <p className="mt-1 text-xs opacity-80">Có thể bấm Tiếp tục để chạy tiếp phiên cũ mà không mất thay đổi đang dở.</p>
            )}
          </div>
        </div>
      )}
      {task.status === 'queued' && waiting && (
        <div className="mb-4 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <Hourglass size={18} className="shrink-0" />
          <p>
            Đã gặp giới hạn sử dụng của gói Claude. Task sẽ tự chạy tiếp lúc {hhmm(task.notBefore!)}
            {task.rateLimitRetries ? ` (lần tự thử lại ${task.rateLimitRetries})` : ''}. Bấm Tiếp tục ngay nếu gói đã có lượt
            dùng trở lại.
          </p>
        </div>
      )}
      {task.status === 'queued' && !waiting && (
        <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300">
          Đang chờ tới lượt. Task sẽ tự {task.resumeNext ? 'chạy tiếp phiên cũ' : 'chạy'} khi có slot trống (tối đa{' '}
          {s.settings.maxParallel} task cùng lúc).
        </div>
      )}

      {/* Tabs */}
      <div className="mb-3 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800">
        {tabs
          .filter((t) => !t.hidden)
          .map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
                tab === t.id
                  ? 'border-indigo-600 font-medium text-indigo-700 dark:text-indigo-300'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              {t.icon} {t.label}
              {!!t.count && <span className="rounded-full bg-slate-100 px-1.5 text-xs dark:bg-slate-800">{t.count}</span>}
            </button>
          ))}
      </div>

      {tab === 'log' && (
        <div>
          {runs.length > 1 && (
            <div className="mb-2 flex items-center gap-2 text-sm">
              <span className="text-slate-500">Lần chạy:</span>
              <select className={`${inputCls} w-auto py-1`} value={shownRun?.id} onChange={(e) => setRunId(e.target.value)}>
                {runs.map((r, i) => (
                  <option key={r.id} value={r.id}>
                    #{i + 1} · {RUN_KIND[r.kind]} · {clock(r.startedAt)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <LogView events={events} live={live} />
        </div>
      )}

      {tab === 'review' && (
        <div className="space-y-3">
          {task.reviewWarning && (
            <div className="flex gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
              <TriangleAlert size={18} className="shrink-0" />
              <span>{task.reviewWarning}</span>
            </div>
          )}
          {task.status === 'review' && latestRun?.summary && (
            <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm dark:border-slate-800 dark:bg-slate-900">
              <span className="mb-2 block text-xs font-medium uppercase tracking-wide text-slate-400">Claude tóm tắt</span>
              <div className="max-h-72 overflow-y-auto pr-1">
                <Markdown text={latestRun.summary} />
              </div>
            </div>
          )}
          <TestPanel task={task} project={project} now={now} />
          {loadedDiff === undefined && diffLoading ? (
            <p className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
              <Loader2 size={16} className="animate-spin" /> Đang tải thay đổi…
            </p>
          ) : loadedDiff === undefined && diffError ? (
            <div className="flex flex-wrap items-center justify-center gap-2 py-8 text-sm text-rose-600 dark:text-rose-400">
              <span>{diffError}</span>
              <Button size="sm" onClick={() => loadDiff(true)}>
                <RotateCcw size={14} /> Thử lại
              </Button>
            </div>
          ) : (
            <DiffView key={diffs.map((d) => d.path + d.additions).join()} files={diffs} />
          )}

          {task.status === 'review' && (
            <div className="sticky bottom-0 -mx-1 rounded-lg border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
              {feedbackOpen ? (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Feedback cho Claude (Claude sẽ tiếp tục trong cùng phiên)</label>
                  <textarea
                    autoFocus
                    className={`${inputCls} min-h-[90px]`}
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="VD: Thông báo lỗi cần có role=&quot;alert&quot;; đổi tên biến cho rõ nghĩa…"
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" disabled={!!busy} onClick={() => setFeedbackOpen(false)}>
                      Huỷ
                    </Button>
                    <Button
                      variant="primary"
                      disabled={!!busy || feedback.trim().length < MIN_FEEDBACK}
                      title={feedback.trim().length < MIN_FEEDBACK ? `Nhập ít nhất ${MIN_FEEDBACK} ký tự` : undefined}
                      onClick={() => submitReview('request_changes')}
                    >
                      {busy === 'request_changes' ? <Loader2 size={16} className="animate-spin" /> : <MessageSquareReply size={16} />} Gửi feedback
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mr-auto text-sm text-slate-500 dark:text-slate-400">
                    Merge <span className="font-mono">{task.branch}</span> → <span className="font-mono">{project?.mainBranch}</span>
                  </span>
                  <Button variant="ghost" className="text-rose-600" disabled={!!busy} onClick={() => setConfirm('reject')}>
                    {busy === 'reject' ? <Loader2 size={16} className="animate-spin" /> : <X size={16} />} Reject
                  </Button>
                  <Button disabled={!!busy} onClick={() => setFeedbackOpen(true)}>
                    <MessageSquareReply size={16} /> Request changes
                  </Button>
                  <Button variant="success" disabled={!!busy} onClick={() => submitReview('approve')}>
                    {busy === 'approve' ? <Loader2 size={16} className="animate-spin" /> : <GitMerge size={16} />} Approve &amp; Merge
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'result' && (
        <div className="space-y-3">
          {latestRun ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ['Thời gian chạy', latestRun.endedAt ? duration(latestRun.endedAt - latestRun.startedAt) : duration(now - latestRun.startedAt)],
                  ['Số lượt (turns)', latestRun.numTurns ?? '—'],
                  ['Chi phí ước tính (quy đổi)', usd(latestRun.costUsd)],
                  ['Exit code', latestRun.exitCode ?? '—'],
                ].map(([k, v]) => (
                  <div key={k as string} className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
                    <p className="text-xs text-slate-500">{k}</p>
                    <p className="mt-1 text-lg font-semibold">{v}</p>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                <p className="flex items-center gap-1.5 border-b border-slate-100 px-5 py-2.5 text-xs font-medium uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <FileText size={14} /> Tóm tắt của Claude
                </p>
                <div className="px-5 py-4">
                  {latestRun.summary ? (
                    <Markdown text={latestRun.summary} className="max-w-3xl" />
                  ) : (
                    <span className="text-sm text-slate-400">Chưa có, Claude vẫn đang làm việc.</span>
                  )}
                </div>
              </div>
              {task.sessionId && <p className="font-mono text-xs text-slate-400">session: {task.sessionId}</p>}
            </>
          ) : (
            <p className="py-8 text-center text-sm text-slate-400">Task chưa chạy.</p>
          )}
        </div>
      )}

      {tab === 'history' && (
        <ol className="relative space-y-4 border-l border-slate-200 pl-6 dark:border-slate-800">
          {runs.length === 0 && <p className="text-sm text-slate-400">Chưa có lần chạy nào.</p>}
          {history.map((item) => {
            if (item.kind === 'review') {
              const rv = item.review
              if (rv.action === 'request_changes')
                return (
                  <li key={rv.id} className="relative">
                    <span className="absolute -left-[31px] top-1 h-3 w-3 rounded-full bg-violet-400 ring-4 ring-slate-50 dark:ring-slate-950" />
                    <p className="rounded-md bg-violet-50 p-2 text-sm text-violet-900 dark:bg-violet-950/40 dark:text-violet-200">
                      <MessageSquareReply size={13} className="mr-1 inline" />
                      Feedback ({timeAgo(rv.createdAt, now)}){task.pendingFeedback && task.status === 'queued' ? ', đang chờ slot chạy' : ''}: {rv.feedback}
                    </p>
                  </li>
                )
              return (
                <li key={rv.id} className="relative">
                  <span className={`absolute -left-[31px] top-1 h-3 w-3 rounded-full ring-4 ring-slate-50 dark:ring-slate-950 ${rv.action === 'approve' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                  <p className="text-sm">
                    {rv.action === 'approve' ? 'Bạn đã Approve & Merge' : 'Bạn đã Reject'} · <span className="text-xs text-slate-500">{timeAgo(rv.createdAt, now)}</span>
                  </p>
                  {rv.feedback && <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{rv.feedback}</p>}
                </li>
              )
            }
            const { run: r, index: i, review: rv } = item
            return (
              <li key={r.id} className="relative">
                <span
                  className={`absolute -left-[31px] top-1 h-3 w-3 rounded-full ring-4 ring-slate-50 dark:ring-slate-950 ${
                    r.exitCode === undefined ? 'animate-pulse bg-indigo-500' : r.exitCode === 0 ? 'bg-emerald-500' : 'bg-rose-500'
                  }`}
                />
                <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">
                      Lần {i + 1}: {RUN_KIND[r.kind]}
                    </span>
                    <span className="text-xs text-slate-500">{new Date(r.startedAt).toLocaleString('vi-VN')}</span>
                    <span className="ml-auto text-xs text-slate-500">
                      {r.endedAt ? duration(r.endedAt - r.startedAt) : 'đang chạy'} · {usd(r.costUsd)}
                    </span>
                  </div>
                  {r.feedback && (
                    <p className="mt-2 rounded-md bg-violet-50 p-2 text-sm text-violet-900 dark:bg-violet-950/40 dark:text-violet-200">
                      <MessageSquareReply size={13} className="mr-1 inline" />
                      Feedback{rv ? ` (${timeAgo(rv.createdAt, now)})` : ''}: {r.feedback}
                    </p>
                  )}
                  {r.summary && (
                    <details className="group mt-2">
                      <summary className="cursor-pointer list-none text-sm text-slate-600 dark:text-slate-300">
                        <span className="line-clamp-2 group-open:hidden">{stripMarkdown(r.summary)}</span>
                        <span className="text-xs text-indigo-600 dark:text-indigo-400">
                          <span className="group-open:hidden">Xem đầy đủ</span>
                          <span className="hidden group-open:inline">Thu gọn</span>
                        </span>
                      </summary>
                      <Markdown text={r.summary} className="mt-2" />
                    </details>
                  )}
                  <button
                    onClick={() => {
                      setRunId(r.id)
                      setTab('log')
                    }}
                    className="mt-2 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    Xem log lần chạy này →
                  </button>
                </div>
              </li>
            )
          })}
        </ol>
      )}

      {tab === 'prompt' && (
        <div className="space-y-3">
          <pre className="whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-4 font-sans text-sm dark:border-slate-800 dark:bg-slate-900">{task.prompt}</pre>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <p>
              <span className="text-slate-500">Mức quyền:</span> <span className="font-mono">{task.permissionMode}</span>
            </p>
            <p>
              <span className="text-slate-500">Repo:</span> <span className="font-mono text-xs">{project?.repoPath}</span>
            </p>
            <p>
              <span className="text-slate-500">Tag:</span> {task.tags.join(', ') || '—'}
            </p>
          </div>
        </div>
      )}

      <TaskFormModal open={edit} onClose={() => setEdit(false)} editing={task} />
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        title={`Xoá task #${task.id}?`}
        message="Task sẽ bị xoá vĩnh viễn."
        confirmLabel="Xoá"
        danger
        onConfirm={() => {
          deleteTask(task.id)
          navigate('/')
        }}
      />
      <ConfirmDialog
        open={confirm === 'reject'}
        onClose={() => setConfirm(null)}
        title={`Reject task #${task.id}?`}
        message={
          <>
            Toàn bộ thay đổi sẽ bị huỷ, worktree và nhánh <span className="font-mono">{task.branch}</span> sẽ bị xoá. Không thể hoàn tác.
          </>
        }
        confirmLabel="Reject"
        danger
        onConfirm={() => void submitReview('reject')}
      />
      <ConfirmDialog
        open={confirm === 'stop'}
        onClose={() => setConfirm(null)}
        title={`Tạm dừng task #${task.id}?`}
        message="Claude sẽ bị dừng ngay. Các thay đổi đang làm dở vẫn còn trong worktree, bạn có thể bấm Tiếp tục để chạy tiếp phiên cũ hoặc Chạy lại từ đầu."
        confirmLabel="Tạm dừng"
        danger
        onConfirm={() => stopTask(task.id)}
      />
      <ConfirmDialog
        open={confirm === 'retry'}
        onClose={() => setConfirm(null)}
        title={`Chạy lại task #${task.id} từ đầu?`}
        message="Toàn bộ thay đổi đang dở trong worktree sẽ bị bỏ và Claude bắt đầu phiên mới trên nhánh chính. Muốn giữ thay đổi và làm tiếp, hãy chọn Tiếp tục."
        confirmLabel="Chạy lại từ đầu"
        danger
        onConfirm={() => retryTask(task.id)}
      />
    </div>
  )
}
