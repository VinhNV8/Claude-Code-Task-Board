import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Eye, Hand, Play, Square } from 'lucide-react'
import { ensureEvents, runTaskNow, stopTask, useStore } from '../store/store'
import { AttentionGrid } from './Attention'
import { Button, ConfirmDialog, StatusGlyph, useNow } from './ui'
import { duration, timeAgo } from '../lib/format'
import { columnTasks } from '../lib/board'
import { unmetDeps } from '../lib/deps'
import { logLine, slotAssignments, type AttentionItem } from '../lib/workView'
import type { Project, Task, TaskStatus } from '../types'

const LOG_LINES = 6

function SectionHead({ title, count, hint }: { title: string; count?: string | number; hint?: string }) {
  return (
    <div className="mb-2.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
      <span>{title}</span>
      {count !== undefined && <span className="font-mono normal-case tracking-normal text-slate-800 dark:text-slate-200">{count}</span>}
      <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
      {hint && <span className="hidden text-xs font-normal normal-case tracking-normal sm:inline">{hint}</span>}
    </div>
  )
}

/** Một slot chạy: task đang giữ slot (log trực tiếp), task chờ quyền, hoặc slot trống kèm task kế tiếp. */
function AgentSlot({ index, task, project, next, taskLink, onOpen }: { index: number; task?: Task; project?: Project; next?: Task; taskLink: (id: number) => string; onOpen: (id: number) => void }) {
  const s = useStore()
  const now = useNow(1000)
  const [confirmStop, setConfirmStop] = useState(false)
  const run = useMemo(() => (task ? [...s.runs].reverse().find((r) => r.taskId === task.id) : undefined), [s.runs, task?.id])
  useEffect(() => {
    if (run) ensureEvents(run.id)
  }, [run?.id])
  const lines = useMemo(() => (run ? s.events.filter((e) => e.runId === run.id).slice(-LOG_LINES).map(logLine) : []), [s.events, run?.id])

  const head = (extra?: ReactNode) => (
    <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 font-mono text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
      {extra}
      <span className="truncate">
        SLOT {index + 1}
        {task && ` · #${task.id} · ${project?.name ?? ''}`}
      </span>
      {task?.status === 'running' && task.startedAt && <span className="ml-auto text-xs tabular-nums text-slate-800 dark:text-slate-200">{duration(now - task.startedAt)}</span>}
    </div>
  )

  if (!task)
    return (
      <div className="flex min-h-[210px] flex-col rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        {head()}
        <div className="m-3 flex flex-1 flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-slate-300 p-3 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
          <span className="font-medium text-slate-700 dark:text-slate-200">Slot trống</span>
          {next ? (
            <>
              <span className="line-clamp-2">
                Kế tiếp: <span className="font-mono">#{next.id}</span> {next.title}
              </span>
              <Button size="sm" className="mt-1" onClick={() => void runTaskNow(next.id)}>
                <Play size={13} /> Chạy ngay
              </Button>
            </>
          ) : (
            <span>Hàng đợi trống</span>
          )}
        </div>
      </div>
    )

  if (task.status === 'needs_input')
    return (
      <div className="flex min-h-[210px] flex-col rounded-lg border border-amber-300 bg-white dark:border-amber-800 dark:bg-slate-900">
        {head(<StatusGlyph status="needs_input" size={12} />)}
        <div className="m-3 flex flex-1 flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-amber-300 p-3 text-center text-xs text-slate-500 dark:border-amber-800 dark:text-slate-400">
          <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400">
            <Hand size={13} /> Slot bị giữ: Claude chờ bạn cấp quyền
          </span>
          <span className="line-clamp-2 text-slate-700 dark:text-slate-200">{task.title}</span>
          <Button size="sm" variant="primary" className="mt-1" onClick={() => onOpen(task.id)}>
            <Eye size={13} /> Xem yêu cầu
          </Button>
        </div>
      </div>
    )

  return (
    <div className="flex min-h-[210px] min-w-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      {head(<span className="h-2 w-2 shrink-0 rounded-full bg-indigo-500 motion-safe:animate-pulse" />)}
      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        <Link to={taskLink(task.id)} className="line-clamp-2 text-sm font-medium leading-snug hover:text-indigo-600 dark:hover:text-indigo-400">
          {task.title}
        </Link>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setConfirmStop(true)} className="text-rose-600">
            <Square size={12} /> Tạm dừng
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onOpen(task.id)}>
            <Eye size={13} /> Xem log
          </Button>
        </div>
      </div>
      <div className="mt-auto flex h-[118px] flex-col justify-end overflow-hidden border-t border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11px] leading-[1.7] text-slate-500 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-400">
        {lines.length === 0 && <span>Đang chờ log…</span>}
        {lines.map((l, i) => (
          <div
            key={i}
            className={`truncate ${i === lines.length - 1 ? 'log-caret text-slate-700 dark:text-slate-200' : ''} ${
              l.kind === 'tool' ? 'text-indigo-600 dark:text-indigo-400' : l.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : l.kind === 'error' ? 'text-rose-600 dark:text-rose-400' : ''
            }`}
          >
            {l.text}
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        title={`Tạm dừng task #${task.id}?`}
        message="Claude sẽ bị dừng ngay. Các thay đổi đang làm dở vẫn còn trong worktree, bạn có thể bấm Tiếp tục để chạy tiếp phiên cũ hoặc Chạy lại từ đầu."
        confirmLabel="Tạm dừng"
        danger
        onConfirm={() => stopTask(task.id)}
      />
    </div>
  )
}

function Lane({ status, title, tasks, taskLink, now, more }: { status: TaskStatus; title: string; tasks: Task[]; taskLink: (id: number) => string; now: number; more?: number }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-1.5 pb-1.5 text-sm font-medium">
        <StatusGlyph status={status} />
        {title}
        <span className="font-normal text-slate-500 dark:text-slate-400">{tasks.length + (more ?? 0)}</span>
      </div>
      {tasks.length === 0 && <p className="border-t border-slate-100 py-2 text-xs text-slate-400 dark:border-slate-800">Trống</p>}
      {tasks.map((t) => (
        <Link key={t.id} to={taskLink(t.id)} className="group flex items-center gap-2 border-t border-slate-100 py-1.5 text-[13px] dark:border-slate-800">
          <span className="font-mono text-[11px] text-slate-400">#{t.id}</span>
          <span className="min-w-0 flex-1 truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400">{t.title}</span>
          <span className="shrink-0 text-[11px] text-slate-400">
            {t.status === 'failed' ? <span className="text-rose-500">lỗi</span> : timeAgo(t.updatedAt, now)}
          </span>
        </Link>
      ))}
      {!!more && <p className="border-t border-slate-100 pt-1.5 text-[11px] text-slate-400 dark:border-slate-800">và {more} task khác, xem ở view Bảng</p>}
    </div>
  )
}

const LANE_MAX = 8

/**
 * View Điều phối: việc cần bạn lên đầu, các slot agent đang chạy (log trực tiếp), pipeline thu gọn.
 * `tasks` đã qua bộ lọc; slot luôn tính trên toàn bộ task vì số slot là giới hạn chung.
 */
export function OpsView({
  tasks,
  attention,
  projects,
  hideOld,
  taskLink,
  onOpen,
}: {
  tasks: Task[]
  attention: AttentionItem[]
  projects: Project[]
  hideOld: boolean
  taskLink: (id: number) => string
  onOpen: (id: number) => void
}) {
  const s = useStore()
  const now = useNow(30_000)
  const slots = slotAssignments(s.tasks, s.settings.maxParallel)
  const used = slots.filter(Boolean).length
  const statusOf = (id: number) => s.tasks.find((t) => t.id === id)?.status
  const queued = columnTasks(tasks, 'queued', { hideOld })
  const next = queued.find((t) => unmetDeps(t, statusOf).length === 0)
  const backlog = columnTasks(tasks, 'backlog', { hideOld })
  const done = columnTasks(tasks, 'done', { hideOld: true, now })
  const lane = (list: Task[]) => ({ tasks: list.slice(0, LANE_MAX), more: Math.max(0, list.length - LANE_MAX) })
  const project = (t?: Task) => projects.find((p) => p.id === t?.projectId)

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Cần bạn">
        <SectionHead title="Cần bạn" count={attention.length} hint="Xin quyền, chờ duyệt, bị dừng trong 24 giờ" />
        <AttentionGrid items={attention} tasks={tasks} projects={projects} onOpen={onOpen} />
      </section>

      <section aria-label="Agent đang chạy">
        <SectionHead title="Agent đang chạy" count={`${used}/${s.settings.maxParallel}`} hint="Task chờ quyền vẫn giữ slot" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {slots.map((t, i) => (
            <AgentSlot key={t ? t.id : `empty-${i}`} index={i} task={t} project={project(t)} next={next} taskLink={taskLink} onOpen={onOpen} />
          ))}
        </div>
      </section>

      <section aria-label="Pipeline">
        <SectionHead title="Pipeline" hint="Kéo thả đầy đủ ở view Bảng" />
        <div className="grid gap-3 md:grid-cols-3">
          <Lane status="queued" title="Hàng đợi" {...lane(queued)} taskLink={taskLink} now={now} />
          <Lane status="backlog" title="Chờ chạy" {...lane(backlog)} taskLink={taskLink} now={now} />
          <Lane status="done" title="Xong trong 24 giờ" {...lane(done)} taskLink={taskLink} now={now} />
        </div>
      </section>
    </div>
  )
}
