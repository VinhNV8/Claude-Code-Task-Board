import { Link } from 'react-router-dom'
import { AlertTriangle, Clock, GitBranch, Hand, Loader2, Play } from 'lucide-react'
import type { Project, Task } from '../types'
import { PRIORITY_META, duration, timeAgo } from '../lib/format'
import { queueTask } from '../store/store'
import { useNow } from './ui'

export function TaskCard({ task, project, fileCount }: { task: Task; project?: Project; fileCount?: number }) {
  const now = useNow(1000)
  const pr = PRIORITY_META[task.priority]
  return (
    <Link
      to={`/tasks/${task.id}`}
      className={`group block rounded-lg border bg-white p-3 shadow-sm transition hover:border-indigo-400 hover:shadow dark:bg-slate-900 ${
        task.status === 'needs_input'
          ? 'border-amber-400 ring-2 ring-amber-400/30 dark:border-amber-500'
          : task.status === 'running'
            ? 'border-indigo-300 dark:border-indigo-800'
            : 'border-slate-200 dark:border-slate-800'
      }`}
    >
      <div className="mb-1 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="font-mono">#{task.id}</span>
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
        {task.status === 'failed' && (
          <span className="line-clamp-1 inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
            <AlertTriangle size={12} className="shrink-0" /> {task.failReason}
          </span>
        )}
        {['backlog', 'queued', 'done'].includes(task.status) && (
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
