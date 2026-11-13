import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, FolderGit2, KanbanSquare, Plus, Radar, Rows3 } from 'lucide-react'
import { queueTask, retryTask, runTaskNow, stopTask, unqueueTask, useStore } from '../store/store'
import { STATUS_META } from '../lib/format'
import { BOARD_COLUMNS, DRAG_MIME, applyDrop, canDrag, columnTasks, dropAction, isStale, type BoardColumn, type DropAction, type DropHandlers } from '../lib/board'
import { collectTags, facetCounts, filterToParams, matchTask, parseFilter, pruneProjects, type BoardFilter } from '../lib/taskFilter'
import { FILTER_PANEL_STORAGE_KEY, loadCollapsed, saveCollapsed } from '../lib/sidebar'
import {
  VIEW_META,
  VIEW_STORAGE_KEY,
  WORK_VIEWS,
  attentionItems,
  initialView,
  parseTaskParam,
  stepSelection,
  triageGroups,
  withParams,
  workShortcut,
  type WorkView,
} from '../lib/workView'
import { TaskCard } from '../components/TaskCard'
import { useNewTask } from '../components/Layout'
import { Button, ConfirmDialog, EmptyState, StatusGlyph, useMediaQuery } from '../components/ui'
import { BoardFilterPanel, BoardToolbar } from '../components/BoardFilters'
import { AttentionStrip } from '../components/Attention'
import { OpsView } from '../components/OpsView'
import { TriageList } from '../components/TriageView'
import { TaskPanel } from '../components/TaskPanel'
import { BLANK_PROJECT, ProjectModal } from './Projects'
import type { Project, Task, TaskStatus } from '../types'

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
  backlog: 'Chưa chạy hoặc đã dừng',
  queued: 'Tới lượt sẽ tự chạy',
  running: 'Claude đang làm',
  review: 'Duyệt để merge',
}

/** Cột Kanban: task Cần bạn nằm ở dải phía trên nên không có cột riêng. */
const KANBAN_COLUMNS = BOARD_COLUMNS.filter((c) => c !== 'needs_input')
const DONE_COLLAPSED_KEY = 'board-done-collapsed'

const VIEW_ICON: Record<WorkView, JSX.Element> = {
  board: <KanbanSquare size={15} />,
  ops: <Radar size={15} />,
  triage: <Rows3 size={15} />,
}

function storage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function readStoredView(): string | null {
  try {
    return storage()?.getItem(VIEW_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

function ViewSwitcher({ view, onChange }: { view: WorkView; onChange: (v: WorkView) => void }) {
  return (
    <div role="tablist" aria-label="Cách xem" className="inline-flex rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800/80">
      {WORK_VIEWS.map((v) => {
        const on = v === view
        return (
          <button
            key={v}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(v)}
            title={`${VIEW_META[v].hint} (phím ${VIEW_META[v].key})`}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm ${
              on ? 'bg-white font-medium text-slate-900 shadow-sm dark:bg-slate-900 dark:text-slate-100' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            {VIEW_ICON[v]}
            <span className="hidden sm:inline">{VIEW_META[v].label}</span>
            <kbd className="hidden rounded border border-slate-300 px-1 font-mono text-[10px] leading-4 text-slate-400 lg:inline dark:border-slate-600">{VIEW_META[v].key}</kbd>
          </button>
        )
      })}
    </div>
  )
}

/**
 * Trang Công việc: một bộ lọc, một khung chi tiết task, ba cách xem.
 * - Bảng: Kanban kéo thả + dải "Cần bạn" phía trên.
 * - Điều phối: việc cần bạn, agent đang chạy, pipeline.
 * - Phân luồng: danh sách theo trạng thái + khung chi tiết gắn cố định.
 * URL: `?view=board|ops|triage&task=55` cùng các tham số lọc.
 */
export function Board() {
  const s = useStore()
  const openNew = useNewTask()
  const isDesktop = useMediaQuery('(min-width: 768px)')
  // Bộ lọc, cách xem và task đang mở nằm trên URL để chia sẻ/tải lại không mất (FR-07)
  const [params, setParams] = useSearchParams()
  const parsed = useMemo(() => parseFilter(params), [params])
  // project đã bị xoá thì bỏ khỏi bộ lọc
  const filter: BoardFilter = useMemo(() => pruneProjects(parsed, s.projects.map((p) => p.id)), [parsed, s.projects])
  const view = initialView(params.get('view'), readStoredView(), !isDesktop)
  const taskParam = parseTaskParam(params.get('task'))
  const selectedId = taskParam !== undefined && s.tasks.some((t) => t.id === taskParam) ? taskParam : undefined

  const setFilter = (next: BoardFilter) => setParams(withParams(filterToParams(next), { view, task: params.get('task') }), { replace: true })
  const setView = (v: WorkView) => {
    try {
      storage()?.setItem(VIEW_STORAGE_KEY, v)
    } catch {
      /* bỏ qua */
    }
    setParams(withParams(params, { view: v }), { replace: true })
  }
  // URL luôn ghi rõ cách xem (menu bên trái dựa vào đó để biết mục nào đang mở)
  useEffect(() => {
    if (params.get('view') !== view) setParams(withParams(params, { view }), { replace: true })
  }, [params, view])

  const taskLink = (id: number) => `?${withParams(params, { view, task: String(id) })}`
  const openTask = (id: number, replace = false) => setParams(withParams(params, { view, task: String(id) }), { replace })
  const closeTask = () => setParams(withParams(params, { task: null }), { replace: true })

  // Đúng một project đang chọn: nút + ở Backlog tạo task cho project đó, thẻ task không cần ghi tên project
  const singleProject = filter.projectIds.length === 1 ? filter.projectIds[0] : undefined
  const hideOld = !filter.showAll

  const allTags = useMemo(() => collectTags(s.tasks.map((t) => t.tags)), [s.tasks])

  const tasks = useMemo(() => s.tasks.filter((t) => matchTask(t, filter)), [s.tasks, filter])

  // Số task cạnh từng lựa chọn trong panel: chỉ đếm task đang hiện được trên bảng (bỏ Done cũ khi đang ẩn)
  const counts = useMemo(() => {
    const now = Date.now()
    const pool = s.tasks.filter((t) => !isStale(t, hideOld, now))
    return facetCounts(pool, filter, s.projects.map((p) => p.id), allTags)
  }, [s.tasks, s.projects, filter, hideOld, allTags])

  // Badge "cần xử lý" theo project (không phụ thuộc bộ lọc)
  const attention = useMemo(() => {
    const m: Record<string, number> = {}
    for (const t of s.tasks) if (t.status === 'review' || t.status === 'needs_input') m[t.projectId] = (m[t.projectId] ?? 0) + 1
    return m
  }, [s.tasks])

  // Việc cần bạn trong phạm vi bộ lọc. View Bảng đã có cột Chờ duyệt nên dải trên không lặp lại
  const now = Date.now()
  const attnBoard = useMemo(() => attentionItems(tasks, s.permissions, { includeReview: false, now }), [tasks, s.permissions])
  const attnOps = useMemo(() => attentionItems(tasks, s.permissions, { includeReview: true, now }), [tasks, s.permissions])

  // Danh sách Phân luồng (bỏ task Done cũ như trên Bảng); cũng là thứ tự J/K
  const groups = useMemo(() => triageGroups(tasks.filter((t) => !isStale(t, hideOld))), [tasks, hideOld])
  const order = useMemo(() => groups.flatMap((g) => g.tasks.map((t) => t.id)), [groups])
  // Phân luồng trên desktop: chưa chọn thì xem task đầu danh sách
  const docked = view === 'triage' && isDesktop
  const shownId = docked ? (selectedId ?? order[0]) : selectedId

  // Phím tắt: 1/2/3 đổi cách xem, J/K chuyển task, Esc đóng khung chi tiết
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const sc = workShortcut({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, targetTag: el?.tagName, isContentEditable: el?.isContentEditable })
      if (!sc) return
      // Đang mở hộp thoại (xác nhận, sửa task…) thì để hộp thoại xử lý phím
      if (document.querySelector('[aria-modal="true"]')) return
      if (sc === 'close') {
        if (selectedId !== undefined && !docked) {
          e.preventDefault()
          closeTask()
        }
        return
      }
      if (sc === 'next' || sc === 'prev') {
        if (shownId === undefined && view !== 'triage') return
        const id = stepSelection(order, shownId, sc === 'next' ? 1 : -1)
        if (id !== undefined) {
          e.preventDefault()
          openTask(id, true)
        }
        return
      }
      e.preventDefault()
      setView(sc)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  // Panel Bộ lọc: thu gọn trên desktop (nhớ trong localStorage), mở/đóng trên mobile
  const [panelCollapsed, setPanelCollapsed] = useState(() => loadCollapsed(storage(), FILTER_PANEL_STORAGE_KEY))
  useEffect(() => saveCollapsed(storage(), panelCollapsed, FILTER_PANEL_STORAGE_KEY), [panelCollapsed])
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false)
  // Cột Xong thu thành dải dọc để bảng vừa màn hình laptop
  const [doneCollapsed, setDoneCollapsed] = useState(() => {
    try {
      // Chưa từng chọn: mặc định thu gọn
      return (storage()?.getItem(DONE_COLLAPSED_KEY) ?? '1') === '1'
    } catch {
      return true
    }
  })
  useEffect(() => saveCollapsed(storage(), doneCollapsed, DONE_COLLAPSED_KEY), [doneCollapsed])

  // Thêm project ngay tại bảng; lưu xong thì lọc theo project mới để giao việc luôn
  const [newProject, setNewProject] = useState<Project | null>(null)
  const addProject = () => setNewProject(BLANK_PROJECT)
  const projectModal = (
    <ProjectModal project={newProject} onClose={() => setNewProject(null)} onSaved={(p) => setFilter({ ...filter, projectIds: [p.id] })} />
  )

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
      <>
        <EmptyState
          icon={<FolderGit2 size={48} />}
          title="Bắt đầu bằng việc thêm project"
          body="Khai báo một git repo trên máy. Claude sẽ làm việc trong repo đó khi bạn giao task."
          action={
            <Button variant="primary" onClick={addProject}>
              <Plus size={16} /> Thêm project
            </Button>
          }
        />
        {projectModal}
      </>
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

  const kanban = (
    <>
      <AttentionStrip items={attnBoard} tasks={tasks} projects={s.projects} onOpen={(id) => openTask(id)} />
      <div className="-mx-4 flex flex-1 gap-3 overflow-x-auto px-4 pb-4 md:ml-0 md:-mr-6 md:pl-0 md:pr-6">
        {KANBAN_COLUMNS.map((st) => {
          const list = byStatus(st)
          const m = STATUS_META[st]
          const action = dragTask ? dropAction(dragTask, st) : null
          const isOver = action !== null && overCol === st
          if (st === 'done' && doneCollapsed && !action)
            return (
              <button
                key={st}
                onClick={() => setDoneCollapsed(false)}
                className="flex w-11 shrink-0 flex-col items-center gap-2 rounded-lg border border-dashed border-slate-300 py-3 text-xs text-slate-500 hover:border-slate-400 hover:text-slate-800 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                title="Mở cột Xong"
              >
                <StatusGlyph status="done" />
                <span className="[writing-mode:vertical-rl]">
                  {m.label} · {list.length}
                </span>
              </button>
            )
          return (
            <section
              key={st}
              onDragOver={onColDragOver(st)}
              onDragLeave={onColDragLeave(st)}
              onDrop={onColDrop(st)}
              data-drop-target={action ?? undefined}
              className={`flex w-72 shrink-0 flex-col rounded-lg bg-slate-100/70 transition md:w-auto md:min-w-[208px] md:max-w-sm md:flex-1 dark:bg-slate-900/50 ${
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
                <StatusGlyph status={st} />
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
                    onClick={() => openNew(singleProject)}
                    className="ml-auto rounded p-0.5 text-slate-400 hover:bg-white hover:text-slate-700 dark:hover:bg-slate-800"
                    aria-label="Thêm task"
                  >
                    <Plus size={16} />
                  </button>
                )}
                {st === 'done' && (
                  <button
                    onClick={() => setDoneCollapsed(true)}
                    className="ml-auto rounded p-0.5 text-slate-400 hover:bg-white hover:text-slate-700 dark:hover:bg-slate-800"
                    aria-label="Thu gọn cột Xong"
                    title="Thu gọn cột Xong"
                  >
                    <ChevronLeft size={16} />
                  </button>
                )}
              </div>
              {HINT[st] && <p className="px-3 pb-2 text-xs text-slate-500 dark:text-slate-400">{HINT[st]}</p>}
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
                      to={taskLink(t.id)}
                      selected={t.id === selectedId}
                      project={singleProject ? undefined : s.projects.find((p) => p.id === t.projectId)}
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
    </>
  )

  return (
    <div className="flex h-full flex-col gap-4 md:flex-row md:items-start">
      <BoardFilterPanel
        filter={filter}
        onChange={setFilter}
        projects={s.projects}
        tags={allTags}
        counts={counts}
        attention={attention}
        collapsed={panelCollapsed}
        onCollapsedChange={setPanelCollapsed}
        mobileOpen={mobileFilterOpen}
        onAddProject={addProject}
      />

      <div className="flex min-w-0 flex-1 flex-col self-stretch">
        <BoardToolbar
          filter={filter}
          onChange={setFilter}
          projects={s.projects}
          shown={tasks.length}
          total={s.tasks.length}
          showChips={panelCollapsed}
          mobileOpen={mobileFilterOpen}
          onToggleMobile={() => setMobileFilterOpen((v) => !v)}
          right={<ViewSwitcher view={view} onChange={setView} />}
        />

        {view === 'board' && kanban}

        {view === 'ops' && (
          <OpsView tasks={tasks} attention={attnOps} projects={s.projects} hideOld={hideOld} taskLink={taskLink} onOpen={(id) => openTask(id)} />
        )}

        {view === 'triage' && (
          <div className="flex min-h-[480px] overflow-hidden rounded-lg border border-slate-200 bg-white md:h-[calc(100vh-10rem)] dark:border-slate-800 dark:bg-slate-900">
            <div className="flex w-full min-w-0 flex-col md:w-[340px] md:shrink-0 md:border-r md:border-slate-200 lg:w-[380px] md:dark:border-slate-800">
              <TriageList groups={groups} projects={s.projects} selectedId={shownId} taskLink={taskLink} />
              <p className="hidden gap-3 border-t border-slate-200 px-3.5 py-1.5 text-[11px] text-slate-400 md:flex dark:border-slate-800">
                <span>
                  <kbd className="font-mono">J</kbd> / <kbd className="font-mono">K</kbd> chuyển task
                </span>
                <span>
                  <kbd className="font-mono">1</kbd> <kbd className="font-mono">2</kbd> <kbd className="font-mono">3</kbd> đổi cách xem
                </span>
              </p>
            </div>
            {docked &&
              (shownId !== undefined ? (
                <TaskPanel taskId={shownId} variant="dock" onClose={closeTask} taskLink={taskLink} />
              ) : (
                <p className="flex-1 self-center text-center text-sm text-slate-400">Chọn một task để xem chi tiết</p>
              ))}
          </div>
        )}
      </div>

      {/* Khung chi tiết nổi: view Bảng, Điều phối, và Phân luồng trên điện thoại */}
      {!docked && selectedId !== undefined && <TaskPanel taskId={selectedId} variant="float" onClose={closeTask} taskLink={taskLink} />}

      {projectModal}

      <ConfirmDialog
        open={confirmStop !== null}
        onClose={() => setConfirmStop(null)}
        title={`Tạm dừng task #${confirmStop?.id ?? ''}?`}
        message="Claude sẽ bị dừng ngay và task quay về Chờ chạy kèm cờ Tạm dừng. Các thay đổi đang làm dở vẫn còn trong worktree, bạn có thể bấm Tiếp tục để chạy tiếp phiên cũ hoặc Chạy lại từ đầu."
        confirmLabel="Tạm dừng"
        danger
        onConfirm={() => confirmStop && applyDrop(confirmStop, 'backlog', DROP_HANDLERS)}
      />
    </div>
  )
}
