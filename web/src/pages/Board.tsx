import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { FolderGit2, KanbanSquare, Plus, Search, Tag, X } from 'lucide-react'
import { useStore } from '../store/store'
import { PRIORITY_META, STATUS_META, STATUS_ORDER } from '../lib/format'
import { EMPTY_FILTER, PRIORITY_VALUES, collectTags, filterToParams, isFilterActive, matchTask, parseFilter, type BoardFilter } from '../lib/taskFilter'
import { TaskCard } from '../components/TaskCard'
import { useNewTask } from '../components/Layout'
import { Button, EmptyState, inputCls } from '../components/ui'
import type { Priority, TaskStatus } from '../types'

const HINT: Partial<Record<TaskStatus, string>> = {
  backlog: 'Việc đã tạo, chưa chạy',
  queued: 'Chờ tới lượt chạy',
  running: 'Claude đang làm',
  needs_input: 'Claude đang chờ bạn',
  review: 'Chờ bạn duyệt',
}

export function Board() {
  const s = useStore()
  const openNew = useNewTask()
  // Bộ lọc nằm trên URL query để chia sẻ/tải lại không mất (FR-07)
  const [params, setParams] = useSearchParams()
  const parsed = useMemo(() => parseFilter(params), [params])
  // project đã bị xoá thì coi như "tất cả"
  const filter: BoardFilter = useMemo(
    () => (parsed.projectId && !s.projects.some((p) => p.id === parsed.projectId) ? { ...parsed, projectId: null } : parsed),
    [parsed, s.projects],
  )
  const setFilter = (patch: Partial<BoardFilter>) => setParams(filterToParams({ ...filter, ...patch }), { replace: true })
  const projectId = filter.projectId ?? 'all'
  const hideOld = !filter.showAll
  const active = isFilterActive(filter)

  const allTags = useMemo(() => collectTags(s.tasks.map((t) => t.tags)), [s.tasks])
  const tagOptions = allTags.filter((t) => !filter.tags.some((x) => x.toLowerCase() === t.toLowerCase()))

  const tasks = useMemo(() => s.tasks.filter((t) => matchTask(t, filter)), [s.tasks, filter])

  const byStatus = (st: TaskStatus) => {
    let list = tasks.filter((t) => t.status === st)
    if (hideOld && (st === 'done' || st === 'failed')) list = list.filter((t) => Date.now() - t.updatedAt < 24 * 3600_000)
    return list.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  if (s.projects.length === 0)
    return (
      <EmptyState
        icon={<FolderGit2 size={48} />}
        title="Bắt đầu bằng việc thêm project"
        body="Khai báo một git repo trên máy. Claude sẽ làm việc trong repo đó khi bạn giao task."
        action={
          <Link to="/projects" className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-indigo-500">
            <Plus size={16} /> Thêm project
          </Link>
        }
      />
    )

  if (s.tasks.length === 0)
    return (
      <EmptyState
        icon={<KanbanSquare size={48} />}
        title="Chưa có task nào"
        body="Giao việc đầu tiên cho Claude. Task sẽ chạy tự động và hiện lên đây để bạn theo dõi và review."
        action={
          <Button variant="primary" onClick={() => openNew()}>
            <Plus size={16} /> Giao việc đầu tiên
          </Button>
        }
      />
    )

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-lg font-semibold">Bảng công việc</h1>
        <div className="relative">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className={`${inputCls} w-56 py-1.5 pl-8`}
            placeholder="Tìm theo tiêu đề, prompt, tag, #id"
            value={filter.q}
            onChange={(e) => setFilter({ q: e.target.value })}
          />
        </div>
        <select className={`${inputCls} w-auto py-1.5`} value={projectId} onChange={(e) => setFilter({ projectId: e.target.value === 'all' ? null : e.target.value })}>
          <option value="all">Tất cả project</option>
          {s.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          className={`${inputCls} w-auto py-1.5`}
          aria-label="Lọc theo độ ưu tiên"
          value={filter.priorities.length === 1 ? filter.priorities[0] : filter.priorities.length ? 'multi' : 'all'}
          onChange={(e) => setFilter({ priorities: e.target.value === 'all' ? [] : [e.target.value as Priority] })}
        >
          <option value="all">Mọi độ ưu tiên</option>
          {filter.priorities.length > 1 && (
            <option value="multi" disabled>
              {filter.priorities.map((p) => PRIORITY_META[p].label).join(', ')}
            </option>
          )}
          {PRIORITY_VALUES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_META[p].label}
            </option>
          ))}
        </select>
        {tagOptions.length > 0 && (
          <select
            className={`${inputCls} w-auto py-1.5`}
            aria-label="Lọc theo tag"
            value=""
            onChange={(e) => e.target.value && setFilter({ tags: [...filter.tags, e.target.value] })}
          >
            <option value="">{filter.tags.length ? '+ Thêm tag' : 'Lọc theo tag'}</option>
            {tagOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
        {filter.tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
            <Tag size={11} /> {t}
            <button
              onClick={() => setFilter({ tags: filter.tags.filter((x) => x !== t) })}
              className="rounded hover:text-indigo-900 dark:hover:text-white"
              aria-label={`Bỏ lọc tag ${t}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {active && (
          <>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {tasks.length}/{s.tasks.length} task
            </span>
            <Button variant="ghost" size="sm" onClick={() => setFilter({ ...EMPTY_FILTER, showAll: filter.showAll })}>
              Xoá bộ lọc
            </Button>
          </>
        )}
        <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <input type="checkbox" checked={hideOld} onChange={(e) => setFilter({ showAll: !e.target.checked })} />
          Chỉ hiện Done/Failed trong 24 giờ
        </label>
      </div>

      <div className="-mx-4 flex flex-1 gap-3 overflow-x-auto px-4 pb-4 md:-mx-6 md:px-6">
        {STATUS_ORDER.map((st) => {
          const list = byStatus(st)
          const m = STATUS_META[st]
          return (
            <section key={st} className={`flex w-72 shrink-0 flex-col rounded-lg border-t-4 bg-slate-100/70 dark:bg-slate-900/50 ${m.col}`}>
              <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
                <span className="text-sm font-semibold">{m.label}</span>
                <span className="rounded-full bg-white px-1.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">{list.length}</span>
                {st === 'backlog' && (
                  <button
                    onClick={() => openNew(projectId === 'all' ? undefined : projectId)}
                    className="ml-auto rounded p-0.5 text-slate-400 hover:bg-white hover:text-slate-700 dark:hover:bg-slate-800"
                    aria-label="Thêm task"
                  >
                    <Plus size={16} />
                  </button>
                )}
              </div>
              {HINT[st] && <p className="px-3 pb-2 text-[11px] text-slate-500 dark:text-slate-400">{HINT[st]}</p>}
              <div className="flex flex-1 flex-col gap-2 px-2 pb-2">
                {list.map((t) => (
                  <TaskCard key={t.id} task={t} project={s.projects.find((p) => p.id === t.projectId)} fileCount={s.diffs[t.id]?.length} />
                ))}
                {list.length === 0 && <p className="py-6 text-center text-xs text-slate-400">Trống</p>}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
