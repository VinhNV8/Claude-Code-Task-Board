import type { DragEvent } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Clock, GitBranch, Hand, Hourglass, Loader2, Pause, Play, RotateCcw, StepForward } from 'lucide-react'
import type { Project, Task } from '../types'
import { PRIORITY_META, duration, hhmm, timeAgo } from '../lib/format'
import { isFailed } from '../lib/board'
import { STOP_REASON, canResume } from '../lib/resume'
import { queueTask, resumeTask, retryTask } from '../store/store'
import { useNow } from './ui'

export function TaskCard({
  task,
  project,
  fileCount,
  draggable = false,
  dragging = false,
  onDragStart,
  onDragEnd,
}: {
  task: Task
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
  return (
    <Link
      to={`/tasks/${task.id}`}
      // Thẻ không kéo được thì tắt kéo link mặc định của trình duyệt (tránh thả URL vào cột).
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      aria-grabbed={draggable ? dragging : undefined}
      className={`group block rounded-lg border bg-white p-3 shadow-sm transition hover:border-indigo-400 hover:shadow dark:bg-slate-900 ${
        draggable ? 'cursor-grab active:cursor-grabbing' : ''
      } ${dragging ? 'opacity-50' : ''} ${
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

      {task.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.tags.map((t) => (
            <span key={t} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {t}
            </span>
          ))}
        </div>
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
          <span className="line-clamp-1 inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
            <AlertTriangle size={12} className="shrink-0" /> {task.failReason}
          </span>
        )}
        {failed && resumable && (
          <button
            onClick={(e) => {
              e.preventDefault()
              resumeTask(task.id)
            }}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-indigo-600 opacity-0 hover:bg-indigo-50 group-hover:opacity-100 dark:text-indigo-400 dark:hover:bg-indigo-950"
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
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-indigo-600 opacity-0 hover:bg-indigo-50 group-hover:opacity-100 dark:text-indigo-400 dark:hover:bg-indigo-950"
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
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-indigo-600 opacity-0 hover:bg-indigo-50 group-hover:opacity-100 dark:text-indigo-400 dark:hover:bg-indigo-950"
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
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-indigo-600 opacity-0 hover:bg-indigo-50 group-hover:opacity-100 dark:text-indigo-400 dark:hover:bg-indigo-950"
            title="Đưa vào hàng đợi"
          >
            <Play size={12} /> Chạy
          </button>
        )}
      </div>
    </Link>
  )
}
