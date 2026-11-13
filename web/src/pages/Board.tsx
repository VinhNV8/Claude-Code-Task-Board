import { useMemo, useState, type DragEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { FolderGit2, KanbanSquare, Plus } from 'lucide-react'
import { queueTask, retryTask, runTaskNow, stopTask, unqueueTask, useStore } from '../store/store'
import { STATUS_META } from '../lib/format'
import { BOARD_COLUMNS, DRAG_MIME, applyDrop, canDrag, columnTasks, dropAction, type BoardColumn, type DropAction, type DropHandlers } from '../lib/board'
import { collectTags, filterToParams, matchTask, parseFilter, type BoardFilter } from '../lib/taskFilter'
import { TaskCard } from '../components/TaskCard'
import { useNewTask } from '../components/Layout'
import { Button, ConfirmDialog, EmptyState } from '../components/ui'
import { BoardFilterBar } from '../components/BoardFilterBar'
import type { Task, TaskStatus } from '../types'

/** Nhãn gợi ý hiện trong cột đích khi đang kéo task qua. */
const DROP_LABEL: Record<DropAction, string> = {
  queue: 'Thả để đưa vào hàng đợi',
  unqueue: 'Thả để bỏ khỏi hàng đợi',
  run: 'Thả để chạy ngay',
  retry: 'Thả để chạy lại',
  stop: 'Thả để dừng task',
}

const DROP_HANDLERS: DropHandlers = {
  queue: queueTask,
  unqueue: unqueueTask,
  run: runTaskNow,
  retry: retryTask,
  stop: stopTask,
}

const HINT: Partial<Record<TaskStatus, string>> = {
  backlog: 'Việc chưa chạy hoặc đã Fail',
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
  const projectId = filter.projectId ?? 'all'
  const hideOld = !filter.showAll

  const allTags = useMemo(() => collectTags(s.tasks.map((t) => t.tags)), [s.tasks])

  const tasks = useMemo(() => s.tasks.filter((t) => matchTask(t, filter)), [s.tasks, filter])

  // Task Failed nằm ở cột Backlog kèm cờ Fail (không còn cột Failed riêng)
  const byStatus = (st: BoardColumn) => columnTasks(tasks, st, { hideOld })

  // ---- Kéo thả giữa Backlog / Queued / Running
  const [dragId, setDragId] = useState<number | null>(null)
  const [overCol, setOverCol] = useState<BoardColumn | null>(null)
  const [confirmStop, setConfirmStop] = useState<Task | null>(null)
  // Lấy task mới nhất từ store: trạng thái có thể đổi (qua WS) trong lúc đang kéo.
  const dragTask = dragId === null ? undefined : s.tasks.find((t) => t.id === dragId)
  const endDrag = () => {
    setDragId(null)
    setOverCol(null)
  }
  const onCardDragStart = (task: Task) => (e: DragEvent) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(DRAG_MIME, String(task.id))
    setDragId(task.id)
  }
  const onColDragOver = (col: BoardColumn) => (e: DragEvent) => {
    if (!dragTask || !e.dataTransfer.types.includes(DRAG_MIME) || !dropAction(dragTask, col)) return
    e.preventDefault() // cho phép thả
    e.dataTransfer.dropEffect = 'move'
    if (overCol !== col) setOverCol(col)
  }
  const onColDragLeave = (col: BoardColumn) => (e: DragEvent) => {
    // Bỏ qua dragleave khi chỉ đi qua phần tử con bên trong cột
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    if (overCol === col) setOverCol(null)
  }
  const onColDrop = (col: BoardColumn) => (e: DragEvent) => {
    e.preventDefault()
    const task = dragTask
    endDrag()
    if (!task) return
    // Dừng task đang chạy cần xác nhận (task về Backlog kèm cờ Fail)
    if (dropAction(task, col) === 'stop') return setConfirmStop(task)
    applyDrop(task, col, DROP_HANDLERS)
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
      <BoardFilterBar
        filter={filter}
        onChange={(next) => setParams(filterToParams(next), { replace: true })}
        projects={s.projects}
        tags={allTags}
        shown={tasks.length}
        total={s.tasks.length}
      />

      <div className="-mx-4 flex flex-1 gap-3 overflow-x-auto px-4 pb-4 md:-mx-6 md:px-6">
        {BOARD_COLUMNS.map((st) => {
          const list = byStatus(st)
          const m = STATUS_META[st]
          const action = dragTask ? dropAction(dragTask, st) : null
          const isOver = action !== null && overCol === st
          return (
            <section
              key={st}
              onDragOver={onColDragOver(st)}
              onDragLeave={onColDragLeave(st)}
              onDrop={onColDrop(st)}
              data-drop-target={action ?? undefined}
              className={`flex w-72 shrink-0 flex-col rounded-lg border-t-4 bg-slate-100/70 transition dark:bg-slate-900/50 ${m.col} ${
                isOver
                  ? 'bg-indigo-50 ring-2 ring-indigo-400 dark:bg-indigo-950/40'
                  : action
                    ? 'outline-dashed outline-2 outline-indigo-300 dark:outline-indigo-700'
                    : dragTask
                      ? 'opacity-60'
                      : ''
              }`}
            >
              <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
                <span className="text-sm font-semibold">{m.label}</span>
                <span
                  className={`rounded-full px-1.5 text-xs ${
                    // PLAN 2.12: cột Review có task chờ duyệt thì badge nổi bật
                    st === 'review' && list.length > 0
                      ? 'bg-violet-500 font-semibold text-white'
                      : 'bg-white text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                  }`}
                >
                  {list.length}
                </span>
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
                {action && (
                  <p
                    className={`rounded-md border-2 border-dashed py-3 text-center text-xs font-medium ${
                      isOver
                        ? 'border-indigo-400 text-indigo-600 dark:text-indigo-300'
                        : 'border-slate-300 text-slate-400 dark:border-slate-700'
                    }`}
                  >
                    {DROP_LABEL[action]}
                  </p>
                )}
                {list.map((t) => {
                  const draggable = canDrag(t)
                  return (
                    <TaskCard
                      key={t.id}
                      task={t}
                      project={s.projects.find((p) => p.id === t.projectId)}
                      fileCount={s.diffs[t.id]?.length}
                      draggable={draggable}
                      dragging={dragId === t.id}
                      onDragStart={draggable ? onCardDragStart(t) : undefined}
                      onDragEnd={endDrag}
                    />
                  )
                })}
                {list.length === 0 && !action && <p className="py-6 text-center text-xs text-slate-400">Trống</p>}
              </div>
            </section>
          )
        })}
      </div>

      <ConfirmDialog
        open={confirmStop !== null}
        onClose={() => setConfirmStop(null)}
        title={`Tạm dừng task #${confirmStop?.id ?? ''}?`}
        message="Claude sẽ bị dừng ngay và task quay về Backlog kèm cờ Tạm dừng. Các thay đổi đang làm dở vẫn còn trong worktree, bạn có thể bấm Tiếp tục để chạy tiếp phiên cũ hoặc Chạy lại từ đầu."
        confirmLabel="Tạm dừng"
        danger
        onConfirm={() => confirmStop && applyDrop(confirmStop, 'backlog', DROP_HANDLERS)}
      />
    </div>
  )
}
