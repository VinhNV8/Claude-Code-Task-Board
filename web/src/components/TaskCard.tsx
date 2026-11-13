import type { DragEvent } from 'react'
import { Link, type To } from 'react-router-dom'
import { AlertTriangle, Clock, GitBranch, Hand, Hourglass, Link2, Loader2, Pause, Play, RotateCcw, StepForward } from 'lucide-react'
import type { Project, Task } from '../types'
import { PRIORITY_META, duration, hhmm, timeAgo } from '../lib/format'
import { isFailed } from '../lib/board'
import { STOP_REASON, canResume } from '../lib/resume'
import { queueTask, resumeTask, retryTask, useStore } from '../store/store'
import { unmetDeps } from '../lib/deps'
import { useNow } from './ui'

export function TaskCard({
  task,
  to,
  selected = false,
  project,
  fileCount,
  draggable = false,
  dragging = false,
  onDragStart,
  onDragEnd,
}: {
  task: Task
  /** Mở task ở đâu: mặc định trang /tasks/:id; trang Công việc truyền link mở khung chi tiết. */
  to?: To
  /** Task đang mở trong khung chi tiết */
  selected?: boolean
  project?: Project
  fileCount?: number
  /** Cho kéo thả thẻ sang cột khác trên Bảng công việc. */
  draggable?: boolean
  dragging?: boolean
  onDragStart?: (e: DragEvent) => void
  onDragEnd?: () => void
}) {
  const now = useNow(1000)
  const pr = PRIORITY_META[task.priority]
  // Task lỗi nằm ở cột Backlog, hiện cờ Fail
  const failed = isFailed(task)
  // Task tự quay lại hàng đợi sau lỗi giới hạn sử dụng: chưa tới giờ thì runner chưa lấy ra chạy.
  const waitingUntil = task.status === 'queued' && task.notBefore && task.notBefore > now ? task.notBefore : undefined
  const resumable = failed && canResume(task, now)
  const paused = failed && task.failReason === STOP_REASON
  // FR-08 (R4): task trong Backlog/Queued còn chờ task chưa Done. Task được chờ đang lỗi thì nhãn đỏ.
  const all = useStore().tasks
  const statusOf = (id: number) => all.find((t) => t.id === id)?.status
  const waitingOn = task.status === 'backlog' || task.status === 'queued' ? unmetDeps(task, statusOf) : []
  const depFailed = waitingOn.some((id) => statusOf(id) === 'failed')
  return (
    <Link
      to={to ?? `/tasks/${task.id}`}
      aria-current={selected ? 'true' : undefined}
      // Thẻ không kéo được thì tắt kéo link mặc định của trình duyệt (tránh thả URL vào cột).
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      aria-grabbed={draggable ? dragging : undefined}
      className={`group block rounded-lg border bg-white p-3 shadow-sm transition hover:border-indigo-400 hover:shadow dark:bg-slate-900 ${
        draggable ? 'cursor-grab active:cursor-grabbing' : ''
      } ${dragging ? 'opacity-50' : ''} ${selected ? 'outline outline-2 outline-offset-1 outline-indigo-500' : ''} ${
        task.status === 'needs_input'
          ? 'border-amber-400 ring-2 ring-amber-400/30 dark:border-amber-500'
          : failed
            ? 'border-rose-300 dark:border-rose-900'
            : task.status === 'running'
            ? 'border-indigo-300 dark:border-indigo-800'
            : 'border-slate-200 dark:border-slate-800'
      }`}
    >
      <div className="mb-1 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="font-mono">#{task.id}</span>
        {failed && !paused && (
          <span
            className="shrink-0 rounded bg-rose-100 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-rose-700 dark:bg-rose-950 dark:text-rose-300"
            title={task.failReason}
          >
            Fail
          </span>
        )}
        {paused && (
          <span
            className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-amber-700 dark:bg-amber-950 dark:text-amber-300"
            title={task.failReason}
          >
            <Pause size={10} /> Tạm dừng
          </span>
        )}
        <span className="truncate">{project?.name}</span>
        {task.priority !== 'normal' && <span className={`ml-auto shrink-0 font-medium ${pr.cls}`}>{pr.label}</span>}
      </div>
      <p className="line-clamp-2 text-sm font-medium text-slate-800 dark:text-slate-100">{task.title}</p>

      {waitingOn.length > 0 && (
        <div
          className={`mt-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${
            depFailed
              ? 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
              : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
          }`}
          title={depFailed ? 'Có task được chờ đang lỗi: Chạy lại task đó, hoặc gỡ phụ thuộc' : 'Chỉ chạy khi các task này Done (đã chấp nhận output)'}
        >
          <Link2 size={11} /> Chờ {waitingOn.map((id) => `#${id}${statusOf(id) === 'failed' ? ' (lỗi)' : ''}`).join(', ')}
        </div>
      )}

      {task.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.tags.map((t) => (
            <span key={t} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {t}
            </span>
          ))}
        </div>
      )}

      {failed && !paused && task.failReason && (
        <p className="mt-2 line-clamp-2 break-words text-xs text-rose-600 dark:text-rose-400" title={task.failReason}>
          {task.failReason}
        </p>
      )}

      <div className="mt-2 flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
        {task.status === 'running' && task.startedAt && (
          <span className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400">
            <Loader2 size={12} className="animate-spin" /> {duration(now - task.startedAt)}
          </span>
        )}
        {task.status === 'needs_input' && (
          <span className="inline-flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400">
            <Hand size={12} /> Đang chờ bạn cấp quyền
          </span>
        )}
        {task.status === 'review' && (
          <span className="inline-flex items-center gap-1">
            <GitBranch size={12} /> {fileCount ?? 0} file thay đổi
          </span>
        )}
        {task.status === 'review' && task.reviewWarning && (
          <span className="inline-flex items-center gap-1 text-rose-600">
            <AlertTriangle size={12} /> Cảnh báo
          </span>
        )}
        {failed && (
          <span className="inline-flex shrink-0 items-center gap-1 text-rose-600 dark:text-rose-400">
            <AlertTriangle size={12} className="shrink-0" /> {paused ? 'Đã dừng' : 'Lỗi'}
          </span>
        )}
        {failed && resumable && (
          <button
            onClick={(e) => {
              e.preventDefault()
              resumeTask(task.id)
            }}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded bg-indigo-50 px-1.5 py-0.5 font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:text-indigo-300 dark:hover:bg-indigo-900"
            title="Giữ thay đổi đang dở, chạy tiếp phiên Claude cũ (Chạy lại từ đầu: mở chi tiết task)"
          >
            <StepForward size={12} /> Tiếp tục
          </button>
        )}
        {failed && !resumable && (
          <button
            onClick={(e) => {
              e.preventDefault()
              retryTask(task.id)
            }}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded bg-indigo-50 px-1.5 py-0.5 font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:text-indigo-300 dark:hover:bg-indigo-900"
            title="Chạy lại"
          >
            <RotateCcw size={12} /> Chạy lại
          </button>
        )}
        {waitingUntil && (
          <span className="line-clamp-1 inline-flex items-center gap-1 text-amber-600 dark:text-amber-400" title={new Date(waitingUntil).toLocaleString('vi-VN')}>
            <Hourglass size={12} className="shrink-0" /> Chờ đến {hhmm(waitingUntil)} do giới hạn sử dụng
          </span>
        )}
        {waitingUntil && (
          <button
            onClick={(e) => {
              e.preventDefault()
              resumeTask(task.id)
            }}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded bg-indigo-50 px-1.5 py-0.5 font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:text-indigo-300 dark:hover:bg-indigo-900"
            title="Không chờ tới giờ reset, chạy tiếp ngay"
          >
            <StepForward size={12} /> Tiếp tục ngay
          </button>
        )}
        {!waitingUntil && ['backlog', 'queued', 'done'].includes(task.status) && (
          <span className="inline-flex items-center gap-1">
            <Clock size={12} /> {timeAgo(task.updatedAt, now)}
          </span>
        )}
        {task.status === 'backlog' && (
          <button
            onClick={(e) => {
              e.preventDefault()
              queueTask(task.id)
            }}
            className="ml-auto inline-flex items-center gap-1 rounded bg-indigo-50 px-1.5 py-0.5 font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:text-indigo-300 dark:hover:bg-indigo-900"
            title="Đưa vào hàng đợi"
          >
            <Play size={12} /> Chạy
          </button>
        )}
      </div>
    </Link>
  )
}
