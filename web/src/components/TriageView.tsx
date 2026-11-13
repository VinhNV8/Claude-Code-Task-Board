import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { isGroupOpen, toggleGroup } from '../lib/workView'
import { useStore } from '../store/store'
import { StatusGlyph, useNow } from './ui'
import { duration, timeAgo, STATUS_META } from '../lib/format'
import { unmetDeps } from '../lib/deps'
import type { Project, Task, TaskStatus } from '../types'

/** Dòng phụ dưới tiêu đề: việc đang làm / đang chờ gì. */
function subline(t: Task, s: ReturnType<typeof useStore>): string {
  if (t.status === 'needs_input') {
    const p = s.permissions.find((x) => x.taskId === t.id && x.status === 'pending')
    return p ? `Xin dùng ${p.tool}: ${p.input.trim().split('\n')[0]}` : 'Đang chờ bạn'
  }
  if (t.status === 'review') {
    const f = s.diffs[t.id]
    if (!f) return t.reviewWarning ? `Cảnh báo: ${t.reviewWarning}` : 'Chờ bạn duyệt'
    return `${f.length} file · +${f.reduce((a, x) => a + x.additions, 0)} −${f.reduce((a, x) => a + x.deletions, 0)}${t.reviewWarning ? ' · có cảnh báo' : ''}`
  }
  if (t.status === 'failed') return t.failReason ?? 'Lỗi'
  if (t.status === 'queued' || t.status === 'backlog') {
    const waiting = unmetDeps(t, (id) => s.tasks.find((x) => x.id === id)?.status)
    if (waiting.length) return `Chờ ${waiting.map((id) => `#${id}`).join(', ')} xong`
  }
  return t.tags.length ? t.tags.join(', ') : ''
}

/**
 * Danh sách bên trái của view Phân luồng, nhóm theo trạng thái (việc cần bạn trước).
 * Khung chi tiết bên phải do trang Công việc gắn vào.
 */
export function TriageList({
  groups,
  projects,
  selectedId,
  taskLink,
  collapsed,
  onCollapsedChange,
}: {
  groups: { status: TaskStatus; tasks: Task[] }[]
  projects: Project[]
  selectedId?: number
  taskLink: (id: number) => string
  /** Các nhóm đang thu gọn */
  collapsed: TaskStatus[]
  onCollapsedChange: (next: TaskStatus[]) => void
}) {
  const s = useStore()
  const now = useNow(1000)
  const listRef = useRef<HTMLDivElement>(null)

  // Đổi task bằng J/K thì cuộn dòng đang chọn vào tầm nhìn
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  if (!groups.length) return <p className="px-4 py-10 text-center text-sm text-slate-400">Không có task nào khớp bộ lọc.</p>

  const allCollapsed = groups.every((g) => collapsed.includes(g.status))

  return (
    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex items-center justify-end border-b border-slate-200 px-3.5 py-1 dark:border-slate-800">
        <button
          onClick={() => onCollapsedChange(allCollapsed ? [] : groups.map((g) => g.status))}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
          {allCollapsed ? 'Mở tất cả' : 'Thu gọn tất cả'}
        </button>
      </div>
      {groups.map((g) => {
        const open = isGroupOpen(g, collapsed, selectedId)
        return (
        <section key={g.status} aria-label={STATUS_META[g.status].label}>
          <h3 className="sticky top-0 z-[1] border-b border-slate-200 bg-slate-50/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
            <button
              onClick={() => onCollapsedChange(toggleGroup(collapsed, g.status))}
              aria-expanded={open}
              className="flex w-full items-center gap-1.5 px-3.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
              title={open ? 'Thu gọn nhóm' : 'Mở nhóm'}
            >
              <ChevronRight size={13} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
              <StatusGlyph status={g.status} size={12} /> {STATUS_META[g.status].label}
              <span className="ml-auto rounded-full bg-slate-200/70 px-1.5 font-mono text-[10px] normal-case tracking-normal text-slate-600 dark:bg-slate-800 dark:text-slate-300">{g.tasks.length}</span>
            </button>
          </h3>
          {open && g.tasks.map((t) => {
            const on = t.id === selectedId
            const project = projects.find((p) => p.id === t.projectId)
            const sub = subline(t, s)
            return (
              <Link
                key={t.id}
                to={taskLink(t.id)}
                replace
                aria-current={on ? 'true' : undefined}
                className={`grid grid-cols-[16px_minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 border-b border-l-[3px] border-b-slate-100 px-3.5 py-2.5 dark:border-b-slate-800 ${
                  on ? 'border-l-indigo-500 bg-indigo-50/70 dark:bg-indigo-950/40' : 'border-l-transparent hover:bg-slate-50 dark:hover:bg-slate-800/40'
                }`}
              >
                <StatusGlyph status={t.status} className="mt-[3px]" />
                <span className="truncate text-sm font-medium">{t.title}</span>
                <span className="whitespace-nowrap text-[11px] tabular-nums text-slate-400">
                  {t.status === 'running' && t.startedAt ? duration(now - t.startedAt) : timeAgo(t.updatedAt, now)}
                </span>
                <span className={`col-start-2 col-end-4 truncate text-xs ${t.status === 'failed' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'}`}>
                  {project?.name} <span className="font-mono">#{t.id}</span>
                  {sub && <> · {sub}</>}
                </span>
              </Link>
            )
          })}
        </section>
        )
      })}
    </div>
  )
}
