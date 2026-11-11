import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { FolderGit2, KanbanSquare, Plus, Search } from 'lucide-react'
import { useStore } from '../store/store'
import { STATUS_META, STATUS_ORDER } from '../lib/format'
import { TaskCard } from '../components/TaskCard'
import { useNewTask } from '../components/Layout'
import { Button, EmptyState, inputCls } from '../components/ui'
import type { TaskStatus } from '../types'

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
  const [projectId, setProjectId] = useState('all')
  const [q, setQ] = useState('')
  const [hideOld, setHideOld] = useState(true)

  const tasks = useMemo(() => {
    const query = q.trim().toLowerCase()
    return s.tasks.filter(
      (t) =>
        (projectId === 'all' || t.projectId === projectId) &&
        (!query || t.title.toLowerCase().includes(query) || t.tags.some((x) => x.includes(query)) || String(t.id) === query.replace('#', '')),
    )
  }, [s.tasks, projectId, q])

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
          <input className={`${inputCls} w-56 py-1.5 pl-8`} placeholder="Tìm theo tiêu đề, tag, #id" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className={`${inputCls} w-auto py-1.5`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="all">Tất cả project</option>
          {s.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <input type="checkbox" checked={hideOld} onChange={(e) => setHideOld(e.target.checked)} />
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
