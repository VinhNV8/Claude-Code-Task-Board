import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronUp, Eye, Layers, Loader2, MessageCircleQuestion, Pause, RotateCcw, StepForward, Timer, X } from 'lucide-react'
import { approveTask, decidePermission, decidePermissionsBatch, ensureDiff, resumeTask, retryTask, useStore } from '../store/store'
import { DenyReasonBox, PermissionCard, QuestionForm } from './PermissionCard'
import { stripMarkdown } from './Markdown'
import { Button, ConfirmDialog, StatusGlyph, useNow } from './ui'
import { duration } from '../lib/format'
import { permissionDisplay, permissionTimeLeft } from '../lib/notify'
import { STOP_REASON, canResume } from '../lib/resume'
import { hasDraftComments } from '../lib/reviewDraft'
import { loadCollapsed, saveCollapsed } from '../lib/sidebar'
import type { AttentionItem } from '../lib/workView'
import type { PermissionRequest, Project, Task } from '../types'
import { tr } from '../lib/i18n'

// ------------------------------------------------------------ duyệt quyền hàng loạt (FR-46)

/** Nhóm yêu cầu "giống hệt" (cùng tool, cùng chuỗi input sau khi trim), giữ thứ tự xuất hiện. */
export function groupSame(reqs: PermissionRequest[]): PermissionRequest[][] {
  const groups = new Map<string, PermissionRequest[]>()
  for (const r of reqs) {
    // Câu hỏi của Claude (FR-40) phải trả lời riêng từng câu: không bao giờ gộp nhóm
    const key = r.questions?.length ? `q\u0000${r.id}` : `${r.tool}\u0000${r.input.trim()}`
    const g = groups.get(key)
    if (g) g.push(r)
    else groups.set(key, [r])
  }
  return [...groups.values()]
}

/** Nhóm ≥ 2 yêu cầu giống hệt: duyệt một lần cho tất cả; từng thẻ bên trong vẫn duyệt riêng được. */
export function PermissionGroup({ reqs, tasks }: { reqs: PermissionRequest[]; tasks: Task[] }) {
  const [busy, setBusy] = useState(false)
  const [denying, setDenying] = useState(false)
  const [confirmHigh, setConfirmHigh] = useState(false)
  const high = reqs.some((r) => r.risk === 'high')
  const ids = reqs.map((r) => r.id)
  const riskReasons = [...new Set(reqs.flatMap((r) => r.riskReasons ?? []))]

  async function run(decision: 'allow' | 'deny', reason?: string) {
    if (busy) return
    setBusy(true)
    try {
      await decidePermissionsBatch(ids, decision, reason)
    } finally {
      setBusy(false)
      setDenying(false)
    }
  }

  return (
    <div className={`rounded-xl border-2 border-dashed p-3 ${high ? 'border-red-300 dark:border-red-800' : 'border-amber-300 dark:border-amber-800'}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="inline-flex flex-1 items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <Layers size={16} /> {tr('{n} task đang chờ cùng lệnh này', { n: reqs.length })}
        </p>
        {!denying && (
          <>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setDenying(true)}>
              <X size={14} /> {tr('Từ chối tất cả')}
            </Button>
            <Button variant="success" size="sm" disabled={busy} onClick={() => (high ? setConfirmHigh(true) : run('allow'))}>
              <Check size={14} /> {tr('Cho phép tất cả')}
            </Button>
          </>
        )}
      </div>
      {denying && (
        <div className="mb-3">
          <DenyReasonBox busy={busy} submitLabel={tr('Từ chối tất cả')} onSubmit={(r) => run('deny', r)} onCancel={() => setDenying(false)} />
        </div>
      )}
      <div className="space-y-3">
        {reqs.map((p) => (
          <PermissionCard key={p.id} req={p} task={tasks.find((t) => t.id === p.taskId)} showTask />
        ))}
      </div>
      <ConfirmDialog
        open={confirmHigh}
        danger
        title={tr('Cho phép lệnh rủi ro cao?')}
        confirmLabel={tr('Cho phép cả {n} task', { n: reqs.length })}
        message={
          <>
            <p>{riskReasons.length ? tr('Lệnh này được xếp rủi ro cao:') : tr('Lệnh này được xếp rủi ro cao.')}</p>
            {riskReasons.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-red-700 dark:text-red-300">
                {riskReasons.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
            <p className="mt-2">{tr('Bạn chắc chắn muốn cho phép cho cả {n} task cùng lúc?', { n: reqs.length })}</p>
          </>
        }
        onConfirm={() => run('allow')}
        onClose={() => setConfirmHigh(false)}
      />
    </div>
  )
}

// ------------------------------------------------------------ thẻ "Cần bạn"

const TONE = {
  permission: { label: tr('Xin quyền'), cls: 'border-amber-300 dark:border-amber-800', head: 'text-amber-700 dark:text-amber-400', glyph: 'needs_input' },
  waiting: { label: tr('Đang chờ bạn'), cls: 'border-amber-300 dark:border-amber-800', head: 'text-amber-700 dark:text-amber-400', glyph: 'needs_input' },
  review: { label: tr('Chờ duyệt'), cls: 'border-slate-200 dark:border-slate-800', head: 'text-violet-700 dark:text-violet-400', glyph: 'review' },
  failed: { label: tr('Bị dừng'), cls: 'border-slate-200 dark:border-slate-800', head: 'text-rose-700 dark:text-rose-400', glyph: 'failed' },
} as const

/** FR-40: câu hỏi của Claude dùng tông xanh, giống thẻ "Claude hỏi bạn" ở trang chi tiết. */
const QUESTION_TONE = { label: tr('Claude hỏi'), cls: 'border-sky-300 dark:border-sky-800', head: 'text-sky-700 dark:text-sky-400' }

/**
 * Một việc cần bạn, xử lý ngay trên thẻ: cho phép/từ chối quyền, chấp nhận output, tiếp tục/chạy lại.
 * Việc cần xem kỹ (lệnh rủi ro cao, còn nhận xét chưa gửi) thì mở khung chi tiết.
 */
export function AttentionCard({ item, task, project, onOpen, className = '' }: { item: AttentionItem; task: Task; project?: Project; onOpen: (id: number) => void; className?: string }) {
  const s = useStore()
  const now = useNow(1000)
  const [busy, setBusy] = useState(false)
  const [denying, setDenying] = useState(false)
  const isQuestion = item.kind === 'permission' && !!item.req.questions?.length
  const tone = isQuestion ? { ...TONE.permission, ...QUESTION_TONE } : TONE[item.kind]
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  // Thẻ Chờ duyệt cần số file thay đổi: tải diff nếu chưa có (dùng chung request với khung chi tiết)
  useEffect(() => {
    if (item.kind === 'review' && s.diffs[task.id] === undefined) void ensureDiff(task.id)
  }, [item.kind, task.id])

  let body: ReactNode = null
  let actions: ReactNode = null
  const open = (
    <Button size="sm" variant="ghost" onClick={() => onOpen(task.id)}>
      <Eye size={13} /> {tr('Chi tiết')}
    </Button>
  )

  if (item.kind === 'permission' && item.req.questions?.length) {
    // FR-40: Claude hỏi, trả lời ngay trên thẻ
    const req = item.req
    const left = permissionTimeLeft(req.timeoutAt, now)
    body = (
      <>
        <QuestionForm req={req} compact />
        <p className="inline-flex items-center gap-1 text-xs text-sky-700 dark:text-sky-400">
          <Timer size={12} /> {left > 0 ? tr('Claude tự quyết sau {time}', { time: duration(left) }) : tr('Hết thời gian chờ…')}
        </p>
      </>
    )
    actions = open
  } else if (item.kind === 'permission') {
    const req = item.req
    const high = req.risk === 'high'
    const left = permissionTimeLeft(req.timeoutAt, now)
    body = (
      <>
        {high && (
          <p className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 dark:text-red-300">
            <AlertTriangle size={12} /> {tr('Rủi ro cao')}{req.riskReasons?.[0] ? `: ${req.riskReasons[0]}` : ''}
          </p>
        )}
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {tr('Claude xin dùng')} <span className="font-mono text-slate-700 dark:text-slate-200">{req.tool}</span>
        </p>
        <pre className="line-clamp-3 whitespace-pre-wrap break-all rounded-md bg-slate-900 px-2.5 py-1.5 font-mono text-xs text-slate-100">{permissionDisplay(req)}</pre>
        <p className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
          <Timer size={12} /> {left > 0 ? tr('Tự từ chối sau {time}', { time: duration(left) }) : tr('Hết thời gian chờ…')}
        </p>
        {denying && <DenyReasonBox busy={busy} onSubmit={(r) => run(() => decidePermission(req.id, 'deny', r))} onCancel={() => setDenying(false)} />}
      </>
    )
    actions = !denying && (
      <>
        {high ? (
          <Button size="sm" variant="primary" onClick={() => onOpen(task.id)} title={tr('Lệnh rủi ro cao: xem đầy đủ trước khi cho phép')}>
            <Eye size={13} /> {tr('Xem để duyệt')}
          </Button>
        ) : (
          <Button size="sm" variant="success" disabled={busy} onClick={() => run(() => decidePermission(req.id, 'allow'))}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {tr('Cho phép')}
          </Button>
        )}
        <Button size="sm" disabled={busy} onClick={() => setDenying(true)}>
          <X size={13} /> {tr('Từ chối')}
        </Button>
        {!high && open}
      </>
    )
  } else if (item.kind === 'waiting') {
    body = <p className="text-xs text-slate-500 dark:text-slate-400">{tr('Claude đang chờ bạn. Mở chi tiết để xem yêu cầu.')}</p>
    actions = (
      <Button size="sm" variant="primary" onClick={() => onOpen(task.id)}>
        <Eye size={13} /> {tr('Mở chi tiết')}
      </Button>
    )
  } else if (item.kind === 'review') {
    const files = s.diffs[task.id]
    const add = files?.reduce((a, f) => a + f.additions, 0) ?? 0
    const del = files?.reduce((a, f) => a + f.deletions, 0) ?? 0
    const summary = [...s.runs].reverse().find((r) => r.taskId === task.id)?.summary
    body = (
      <>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {files === undefined ? (
            tr('Đang tải thay đổi…')
          ) : files.length === 0 ? (
            tr('Không thay đổi code')
          ) : (
            <>
              {files.length} file · <span className="text-emerald-600 dark:text-emerald-400">+{add}</span> <span className="text-rose-600 dark:text-rose-400">−{del}</span>
            </>
          )}
        </p>
        {task.reviewWarning && (
          <p className="inline-flex items-start gap-1 text-xs text-rose-600 dark:text-rose-400">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {task.reviewWarning}
          </p>
        )}
        {summary && <p className="line-clamp-2 text-xs text-slate-600 dark:text-slate-300">{stripMarkdown(summary)}</p>}
      </>
    )
    actions = (
      <>
        <Button
          size="sm"
          variant="success"
          disabled={busy}
          title={tr('Chấp nhận output, chuyển task sang Done (không merge)')}
          onClick={() => (hasDraftComments(task.id) ? onOpen(task.id) : run(() => approveTask(task.id)))}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {tr('Chấp nhận')}
        </Button>
        <Button size="sm" onClick={() => onOpen(task.id)}>
          <Eye size={13} /> {tr('Xem thay đổi')}
        </Button>
      </>
    )
  } else {
    const resumable = canResume(task, now)
    const paused = task.failReason === STOP_REASON
    body = (
      <p className="line-clamp-2 text-xs text-rose-600 dark:text-rose-400">
        {paused ? (
          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
            <Pause size={12} /> {tr('Bạn đã tạm dừng task này')}
          </span>
        ) : (
          task.failReason
        )}
      </p>
    )
    actions = (
      <>
        {resumable ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => resumeTask(task.id))} title={tr('Giữ thay đổi đang dở, chạy tiếp phiên Claude cũ')}>
            <StepForward size={13} /> {tr('Tiếp tục')}
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => retryTask(task.id))}>
            <RotateCcw size={13} /> {tr('Chạy lại')}
          </Button>
        )}
        {open}
      </>
    )
  }

  return (
    <div className={`flex min-w-0 flex-col gap-2 rounded-lg border bg-white p-3 dark:bg-slate-900 ${tone.cls} ${className}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
        {isQuestion ? <MessageCircleQuestion size={13} className="text-sky-600" /> : <StatusGlyph status={tone.glyph} size={13} />}
        <span className={tone.head}>{tone.label}</span>
        <span className="ml-auto truncate pl-2 text-xs font-normal normal-case tracking-normal text-slate-500 dark:text-slate-400">
          {project?.name} <span className="font-mono">#{task.id}</span>
        </span>
      </div>
      <button onClick={() => onOpen(task.id)} className="text-left text-sm font-medium leading-snug hover:text-indigo-600 dark:hover:text-indigo-400">
        {task.title}
      </button>
      {body}
      {actions && <div className="mt-auto flex flex-wrap gap-1.5 pt-1">{actions}</div>}
    </div>
  )
}

// ------------------------------------------------------------ dải "Cần bạn" trên view Bảng

const STRIP_KEY = 'board-attention-collapsed'
function storage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export function AttentionStrip({ items, tasks, projects, onOpen }: { items: AttentionItem[]; tasks: Task[]; projects: Project[]; onOpen: (id: number) => void }) {
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(storage(), STRIP_KEY))
  useEffect(() => saveCollapsed(storage(), collapsed, STRIP_KEY), [collapsed])
  const rows = items.map((it) => ({ it, task: tasks.find((t) => t.id === it.taskId) })).filter((r): r is { it: AttentionItem; task: Task } => !!r.task)

  if (!rows.length)
    return (
      <p className="mb-3 inline-flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <StatusGlyph status="done" size={13} /> {tr('Không có việc nào chờ bạn. Các agent đang tự chạy.')}
      </p>
    )

  return (
    <section aria-label={tr('Cần bạn')} className="mb-4 rounded-xl border border-amber-300/70 bg-amber-50/60 p-3 dark:border-amber-900/70 dark:bg-amber-950/20">
      <div className="flex items-center gap-2 text-sm">
        <StatusGlyph status="needs_input" />
        <span className="font-semibold">{tr('Cần bạn')} · {rows.length}</span>
        <span className="hidden text-xs text-slate-500 sm:inline dark:text-slate-400">{tr('Claude đang chờ, xử lý ngay tại đây')}</span>
        <button
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-white hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          {collapsed ? (
            <>
              <ChevronDown size={14} /> {tr('Mở ra')}
            </>
          ) : (
            <>
              <ChevronUp size={14} /> {tr('Thu gọn')}
            </>
          )}
        </button>
      </div>
      {!collapsed && (
        <div className="-mx-1 mt-2.5 flex gap-2.5 overflow-x-auto px-1 pb-1">
          {rows.map(({ it, task }) => (
            <AttentionCard
              key={it.kind === 'permission' ? it.req.id : `${it.kind}:${it.taskId}`}
              item={it}
              task={task}
              project={projects.find((p) => p.id === task.projectId)}
              onOpen={onOpen}
              className="w-[300px] shrink-0"
            />
          ))}
        </div>
      )}
    </section>
  )
}

// ------------------------------------------------------------ lưới "Cần bạn" trên view Điều phối

export function AttentionGrid({ items, tasks, projects, onOpen }: { items: AttentionItem[]; tasks: Task[]; projects: Project[]; onOpen: (id: number) => void }) {
  if (!items.length)
    return (
      <p className="inline-flex items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2.5 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        <StatusGlyph status="done" /> {tr('Không có việc nào chờ bạn. Việc mới sẽ hiện ở đây kèm thông báo.')}
      </p>
    )

  // Yêu cầu quyền giống hệt nhau (≥ 2 task) gom thành một nhóm duyệt một lần
  const perms = items.filter((i): i is Extract<AttentionItem, { kind: 'permission' }> => i.kind === 'permission').map((i) => i.req)
  const groups = groupSame(perms).filter((g) => g.length > 1)
  const grouped = new Set(groups.flat().map((r) => r.id))
  const rest = items.filter((i) => !(i.kind === 'permission' && grouped.has(i.req.id)))

  return (
    <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
      {groups.map((g) => (
        <div key={g[0].id} className="sm:col-span-2 2xl:col-span-3">
          <PermissionGroup reqs={g} tasks={tasks} />
        </div>
      ))}
      {rest.map((it) => {
        const task = tasks.find((t) => t.id === it.taskId)
        if (!task) return null
        return (
          <AttentionCard
            key={it.kind === 'permission' ? it.req.id : `${it.kind}:${it.taskId}`}
            item={it}
            task={task}
            project={projects.find((p) => p.id === task.projectId)}
            onOpen={onOpen}
          />
        )
      })}
    </div>
  )
}
