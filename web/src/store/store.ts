// Store thật: dữ liệu từ backend (REST) và cập nhật realtime qua WebSocket.
// Giữ nguyên API với store giả lập (mock.ts) để giao diện không phải thay đổi.
import { useSyncExternalStore } from 'react'
import type {
  DemoFlags,
  FileDiff,
  MergeCheck,
  LogEvent,
  PermissionMode,
  PermissionPreset,
  PermissionRequest,
  Priority,
  Project,
  ProjectBudget,
  PromptTemplate,
  ReviewAction,
  ReviewComment,
  RuleSuggestion,
  Run,
  Schedule,
  ScheduleRun,
  Settings,
  Stats,
  StatsRange,
  Task,
  TaskStatus,
  TestOutput,
  TelegramSettingsInput,
  TestRun,
  Toast,
} from '../types'
import { EMPTY_TEST_OUTPUT, appendTestOutput } from '../lib/testOutput'
import { checkStillAuthenticated, onUnauthorized } from '../lib/auth'
import { showBrowserNotification, transitionNotice, type Notice } from '../lib/notify'

export interface State {
  projects: Project[]
  templates: PromptTemplate[]
  /** Lịch tạo task theo cron (PLAN 4.6) */
  schedules: Schedule[]
  tasks: Task[]
  runs: Run[]
  events: LogEvent[]
  diffs: Record<number, FileDiff[]>
  permissions: PermissionRequest[]
  reviews: ReviewAction[]
  /** Lần chạy test gần nhất của từng task (FR-34) */
  testRuns: TestRun[]
  /** Output test theo task, chỉ có với task đã mở panel test */
  testOutputs: Record<number, TestOutput>
  /** Chi tiêu tháng hiện tại theo project (PLAN P6, ước tính) */
  budgets: Record<string, ProjectBudget>
  toasts: Toast[]
  settings: Settings
  demo: DemoFlags
  nextTaskId: number
  /** Trạng thái kết nối tới backend */
  connection: 'connecting' | 'online' | 'offline'
  loaded: boolean
  /** "Chạy ngay" task còn chờ task khác chưa Done (FR-08, R8): hộp xác nhận gỡ phụ thuộc. */
  depsConfirm?: { taskId: number; message: string } | null
}

export const IS_MOCK = false

let state: State = {
  projects: [],
  templates: [],
  schedules: [],
  tasks: [],
  runs: [],
  events: [],
  diffs: {},
  permissions: [],
  reviews: [],
  testRuns: [],
  testOutputs: {},
  budgets: {},
  toasts: [],
  settings: {
    maxParallel: 2,
    browserNotifications: false,
    notifyOn: { review: true, needsInput: true, failed: true },
    permissionTimeoutMin: 30,
    defaultModel: 'auto',
    autoEscalate: true,
    telegram: { enabled: false, chatId: '', appUrl: '', hasToken: false },
  },
  demo: { speed: 1, mergeConflict: false, dirtyMainRepo: false, nextRunFails: false, nextRunAsksPermission: false },
  nextTaskId: 0,
  connection: 'connecting',
  loaded: false,
}

const listeners = new Set<() => void>()
function set(fn: (s: State) => Partial<State>) {
  state = { ...state, ...fn(state) }
  listeners.forEach((l) => l())
}
export const getState = () => state
export function useStore(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

const uid = () => Math.random().toString(36).slice(2, 10)

// ------------------------------------------------------------ toast & thông báo

export function toast(t: Omit<Toast, 'id'>) {
  const id = uid()
  set((s) => ({ toasts: [...s.toasts, { ...t, id }] }))
  setTimeout(() => dismissToast(id), 6000)
}

export function dismissToast(id: string) {
  set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }))
}

/** Toast trong trang, kèm thông báo của trình duyệt nếu đã bật (PLAN 3.9). `force`: hiện cả khi đang xem tab. */
export function notify(t: Notice, opts: { force?: boolean } = {}) {
  toast(t)
  if (state.settings.browserNotifications) showBrowserNotification(t, opts)
}

/** FR-08 (R4): task được chờ vừa Failed → báo các task trong hàng đợi đang chờ nó sẽ đứng chờ. */
function warnBlockedDependents(prev: TaskStatus | undefined, task: Task) {
  if (task.status !== 'failed' || prev === 'failed') return
  const waiting = state.tasks.filter((t) => t.status === 'queued' && t.dependsOn?.includes(task.id))
  if (!waiting.length) return
  toast({
    kind: 'error',
    title: `#${task.id} lỗi: ${waiting.length} task đang chờ nó`,
    body: `${waiting.map((t) => `#${t.id}`).join(', ')} sẽ đứng chờ tới khi #${task.id} Done (Chạy lại), hoặc gỡ phụ thuộc trong task đó.`,
    taskId: task.id,
  })
}

function notifyTransition(prev: TaskStatus | undefined, task: Task) {
  const n = transitionNotice(prev, task, state.settings.notifyOn)
  if (n) notify(n)
  else if (task.status === 'done' && prev === 'running') toast({ kind: 'success', title: `Hoàn thành: #${task.id}`, body: task.title, taskId: task.id })
}

// ------------------------------------------------------------ REST

class ApiError extends Error {
  constructor(
    message: string,
    /** Mã lỗi máy đọc của backend (ví dụ 'DEPS_PENDING') */
    public code?: string,
  ) {
    super(message)
  }
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError('Không kết nối được tới backend')
  }
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) onUnauthorized() // phiên đăng nhập hết hạn (PLAN 4.7)
  if (!res.ok) {
    const d = data as { error?: string; code?: string }
    throw new ApiError(d.error ?? `Lỗi ${res.status}`, d.code)
  }
  return data as T
}

/** Gọi API, lỗi thì hiện toast. Trả về undefined nếu lỗi. */
async function act<T>(fn: () => Promise<T>, errorTitle = 'Thao tác thất bại'): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    toast({ kind: 'error', title: errorTitle, body: (e as Error).message })
    return undefined
  }
}

async function loadState() {
  const s = await api<
    Pick<State, 'projects' | 'templates' | 'schedules' | 'tasks' | 'runs' | 'settings' | 'permissions' | 'reviews' | 'diffs' | 'testRuns' | 'budgets'>
  >('GET', '/state')
  loadedRuns.clear()
  loadedTests.clear()
  set(() => ({ ...s, schedules: s.schedules ?? [], testRuns: s.testRuns ?? [], budgets: s.budgets ?? {}, testOutputs: {}, events: [], loaded: true }))
}

// ------------------------------------------------------------ output chạy test (FR-34, tải khi mở panel)

const loadedTests = new Set<number>()

export function ensureTestOutput(taskId: number, force = false) {
  if (!force && loadedTests.has(taskId)) return
  loadedTests.add(taskId)
  api<{ testRun: TestRun | null; output: TestOutput }>('GET', `/tasks/${taskId}/test`)
    .then(({ testRun, output }) => {
      const cur = state.testRuns.find((r) => r.taskId === taskId)
      // Trong lúc tải đã có lần chạy mới bắt đầu: output vừa tải là của lần cũ, bỏ qua.
      if (cur && testRun && cur.startedAt !== testRun.startedAt) return
      set((s) => ({ testOutputs: { ...s.testOutputs, [taskId]: output } }))
    })
    .catch(() => loadedTests.delete(taskId))
}

export async function runTests(taskId: number) {
  const run = await act(() => api<TestRun>('POST', `/tasks/${taskId}/test`), 'Không chạy được test')
  if (run) onMessage({ type: 'test_run', testRun: run })
}

export const stopTests = (taskId: number) => act(() => api('POST', `/tasks/${taskId}/test/stop`), 'Không dừng được test')

// ------------------------------------------------------------ log theo lần chạy (tải khi cần)

const loadedRuns = new Set<string>()

export function ensureEvents(runId: string) {
  if (!runId || loadedRuns.has(runId)) return
  loadedRuns.add(runId)
  api<LogEvent[]>('GET', `/runs/${runId}/events`)
    .then((list) => {
      set((s) => {
        const ids = new Set(list.map((e) => e.id))
        const others = s.events.filter((e) => e.runId !== runId || !ids.has(e.id))
        return { events: [...others, ...list].sort((a, b) => Number(a.id) - Number(b.id)) }
      })
    })
    .catch(() => loadedRuns.delete(runId))
}

// ------------------------------------------------------------ diff của task (PLAN 2.9, tải khi mở task)

const diffRequests = new Map<number, Promise<string | null>>()

/**
 * Lấy diff qua `GET /api/tasks/:id/diff` nếu state chưa có (hoặc `force`).
 * Trả về thông báo lỗi để hiện trong tab, hoặc null khi thành công. Gọi trùng thì dùng chung một request.
 */
export function ensureDiff(taskId: number, force = false): Promise<string | null> {
  if (!force && state.diffs[taskId] !== undefined) return Promise.resolve(null)
  const inflight = diffRequests.get(taskId)
  if (inflight) return inflight
  const req = api<FileDiff[]>('GET', `/tasks/${taskId}/diff`)
    .then((files) => {
      // Task đã bị xoá trong lúc tải thì bỏ qua
      if (state.tasks.some((t) => t.id === taskId)) set((s) => ({ diffs: { ...s.diffs, [taskId]: files } }))
      return null
    })
    .catch((e: Error) => e.message)
    .finally(() => diffRequests.delete(taskId))
  diffRequests.set(taskId, req)
  return req
}

function dropDiff(taskId: number) {
  if (state.diffs[taskId] === undefined) return
  set((s) => {
    const diffs = { ...s.diffs }
    delete diffs[taskId]
    return { diffs }
  })
}

// ------------------------------------------------------------ WebSocket

type ServerMessage =
  | { type: 'task'; task: Task }
  | { type: 'task_deleted'; id: number }
  | { type: 'run'; run: Run }
  | { type: 'event'; event: LogEvent }
  | { type: 'project'; project: Project }
  | { type: 'project_deleted'; id: string }
  | { type: 'settings'; settings: Settings }
  | { type: 'permission'; permission: PermissionRequest }
  | { type: 'notification'; taskId: number; runId: string; message: string; title?: string; notificationType?: string }
  | { type: 'template'; template: PromptTemplate }
  | { type: 'template_deleted'; id: string }
  | { type: 'test_run'; testRun: TestRun }
  | { type: 'test_output'; taskId: number; offset: number; chunk: string }
  | { type: 'schedule'; schedule: Schedule }
  | { type: 'schedule_deleted'; id: string }
  | { type: 'schedule_run'; run: ScheduleRun }
  | { type: 'diff'; taskId: number; files: FileDiff[] }
  | { type: 'review'; review: ReviewAction }
  | { type: 'budgets'; budgets: Record<string, ProjectBudget> }
  | { type: 'budget_alert'; projectId: string; level: 'warn' | 'over'; month: string; message: string }
  | { type: 'rule_suggestions'; projectId: string; suggestions: RuleSuggestion[] }

const upsert = <T extends { id: unknown }>(list: T[], item: T) =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]

function onMessage(m: ServerMessage) {
  switch (m.type) {
    case 'task': {
      const prev = state.tasks.find((t) => t.id === m.task.id)?.status
      set((s) => ({ tasks: upsert(s.tasks, m.task) }))
      notifyTransition(prev, m.task)
      warnBlockedDependents(prev, m.task)
      break
    }
    case 'task_deleted':
      set((s) => {
        const diffs = { ...s.diffs }
        delete diffs[m.id]
        return {
          tasks: s.tasks.filter((t) => t.id !== m.id),
          testRuns: s.testRuns.filter((r) => r.taskId !== m.id),
          reviews: s.reviews.filter((r) => r.taskId !== m.id),
          diffs,
        }
      })
      break
    case 'diff':
      set((s) => ({ diffs: { ...s.diffs, [m.taskId]: m.files } }))
      break
    case 'test_run': {
      const r = m.testRun
      const prev = state.testRuns.find((x) => x.taskId === r.taskId)
      const isNew = r.status === 'running' && prev?.startedAt !== r.startedAt
      if (isNew) loadedTests.add(r.taskId) // lần chạy mới: output bắt đầu từ rỗng, không cần tải
      set((s) => ({
        testRuns: prev ? s.testRuns.map((x) => (x.taskId === r.taskId ? r : x)) : [...s.testRuns, r],
        testOutputs: isNew ? { ...s.testOutputs, [r.taskId]: EMPTY_TEST_OUTPUT } : s.testOutputs,
      }))
      break
    }
    case 'test_output': {
      const cur = state.testOutputs[m.taskId]
      if (!cur) break // chưa mở panel test của task này
      const next = appendTestOutput(cur, m.offset, m.chunk)
      if (next === null) ensureTestOutput(m.taskId, true) // hụt dữ liệu (mất kết nối giữa chừng): tải lại
      else if (next !== cur) set((s) => ({ testOutputs: { ...s.testOutputs, [m.taskId]: next } }))
      break
    }
    case 'run':
      // Retry chạy lại từ nhánh chính: diff cũ không còn đúng (diff mới sẽ được broadcast khi lên Review)
      if (m.run.kind === 'retry' && !state.runs.some((r) => r.id === m.run.id)) dropDiff(m.run.taskId)
      set((s) => ({ runs: upsert(s.runs, m.run) }))
      break
    case 'event':
      if (!state.events.some((e) => e.id === m.event.id)) set((s) => ({ events: [...s.events, m.event] }))
      break
    case 'project':
      set((s) => ({ projects: upsert(s.projects, m.project) }))
      break
    case 'project_deleted':
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== m.id),
        templates: s.templates.filter((t) => t.projectId !== m.id),
        schedules: s.schedules.filter((x) => x.projectId !== m.id),
      }))
      break
    case 'schedule':
      set((s) => ({ schedules: upsert(s.schedules, m.schedule) }))
      break
    case 'schedule_deleted':
      set((s) => ({ schedules: s.schedules.filter((x) => x.id !== m.id) }))
      break
    case 'schedule_run':
      scheduleRunListeners.forEach((l) => l(m.run))
      if (m.run.taskId)
        toast({
          kind: 'info',
          title: m.run.catchUp ? `Lịch đã tạo bù #${m.run.taskId}` : `Lịch đã tạo #${m.run.taskId}`,
          body: m.run.title,
          taskId: m.run.taskId,
        })
      break
    case 'template':
      set((s) => ({ templates: upsert(s.templates, m.template) }))
      break
    case 'template_deleted':
      set((s) => ({ templates: s.templates.filter((t) => t.id !== m.id) }))
      break
    case 'settings':
      set(() => ({ settings: m.settings }))
      break
    case 'permission':
      set((s) => ({ permissions: upsert(s.permissions, m.permission) }))
      break
    case 'rule_suggestions':
      ruleSuggestionListeners.forEach((l) => l(m.projectId, m.suggestions))
      break
    case 'review':
      set((s) => ({ reviews: upsert(s.reviews, m.review) }))
      // Reject xoá nhánh task: không còn diff. Approve giữ diff để xem lại những gì đã merge.
      if (m.review.action === 'reject') dropDiff(m.review.taskId)
      break
    case 'notification':
      // Hook Notification của Claude (PLAN 3.6); nội dung cũng đã nằm trong log dưới dạng event system.
      if (state.settings.notifyOn.needsInput)
        notify({ kind: 'warning', title: `#${m.taskId}: ${m.title ?? 'Claude gửi thông báo'}`, body: m.message, taskId: m.taskId })
      break
    case 'budgets':
      set(() => ({ budgets: m.budgets }))
      break
    case 'budget_alert':
      // P6 B2: mỗi mức chỉ báo một lần mỗi tháng (server đã lọc).
      notify({ kind: m.level === 'over' ? 'error' : 'warning', title: m.level === 'over' ? 'Vượt budget tháng' : 'Sắp hết budget tháng', body: m.message })
      break
  }
}

let retry = 0
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws`)
  ws.onopen = async () => {
    retry = 0
    try {
      await loadState() // đồng bộ lại sau khi (tái) kết nối
      set(() => ({ connection: 'online' }))
    } catch {
      ws.close()
    }
  }
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data))
    } catch {
      /* bỏ qua tin nhắn lỗi */
    }
  }
  ws.onclose = () => {
    set(() => ({ connection: 'offline' }))
    void checkStillAuthenticated() // WS bị từ chối do chưa đăng nhập thì quay về màn hình đăng nhập
    const delay = Math.min(10_000, 500 * 2 ** retry++)
    setTimeout(connect, delay)
  }
}
connect()

// ------------------------------------------------------------ action công khai

export interface NewTask {
  title: string
  prompt: string
  projectId: string
  priority: Priority
  permissionMode: PermissionMode
  tags: string[]
  /** '' = kế thừa project → Settings (P5) */
  model?: string
  /** Các task phải Done trước (FR-08) */
  dependsOn?: number[]
  run: boolean
}

export async function createTask(input: NewTask): Promise<number> {
  const t = await act(() => api<Task>('POST', '/tasks', input), 'Không tạo được task')
  if (!t) throw new ApiError('create failed')
  set((s) => ({ tasks: upsert(s.tasks, t) }))
  toast({ kind: 'success', title: input.run ? `Đã đưa #${t.id} vào hàng đợi` : `Đã lưu #${t.id} vào Backlog`, body: t.title })
  return t.id
}

export function updateTask(id: number, patch: Partial<Pick<Task, 'title' | 'prompt' | 'priority' | 'projectId' | 'tags' | 'permissionMode' | 'model' | 'dependsOn'>>) {
  return act(() => api('PATCH', `/tasks/${id}`, patch), 'Không lưu được task')
}

export async function deleteTask(id: number) {
  if (await act(() => api('DELETE', `/tasks/${id}`), 'Không xoá được task')) toast({ kind: 'info', title: `Đã xoá task #${id}` })
}

export const queueTask = (id: number) => act(() => api('POST', `/tasks/${id}/queue`))
export const unqueueTask = (id: number) => act(() => api('POST', `/tasks/${id}/unqueue`))
export const stopTask = (id: number) => act(() => api('POST', `/tasks/${id}/stop`), 'Không dừng được task')

/** Chạy ngay (kéo task sang cột Running). Hết slot thì server đưa vào hàng đợi. */
export async function runTaskNow(id: number, ignoreDeps = false) {
  let r: { started: boolean } | undefined
  try {
    r = await api<{ started: boolean }>('POST', `/tasks/${id}/run`, ignoreDeps ? { ignoreDeps: true } : undefined)
  } catch (e) {
    // FR-08 (R8): còn chờ task chưa Done → hỏi xác nhận gỡ phụ thuộc rồi mới chạy.
    if (e instanceof ApiError && e.code === 'DEPS_PENDING') set(() => ({ depsConfirm: { taskId: id, message: e.message } }))
    else toast({ kind: 'error', title: 'Không chạy được task', body: (e as Error).message })
    return
  }
  if (r && !r.started) toast({ kind: 'info', title: `Đã đưa #${id} vào hàng đợi`, body: 'Đang hết slot chạy, task sẽ chạy khi tới lượt.' })
}

export const closeDepsConfirm = () => set(() => ({ depsConfirm: null }))

export interface DepSuggestion {
  id: number
  title: string
  status: TaskStatus
}

/** FR-08 nguồn ③: task được nhắc tới (#id / mã) trong tiêu đề + prompt, chưa Done, chưa nằm trong danh sách chờ. */
export const fetchDepSuggestions = (input: { projectId: string; title: string; prompt: string; taskId?: number; dependsOn: number[] }) =>
  api<DepSuggestion[]>('POST', '/tasks/dep-suggest', input)

export async function retryTask(id: number) {
  if (await act(() => api('POST', `/tasks/${id}/retry`))) toast({ kind: 'info', title: `Đã đưa #${id} vào hàng đợi chạy lại` })
}

/** Tiếp tục task bị tạm dừng / lỗi / hết giới hạn sử dụng: chạy tiếp phiên Claude cũ trên worktree đang dở. */
export async function resumeTask(id: number) {
  const r = await act(() => api<{ started: boolean }>('POST', `/tasks/${id}/resume`), 'Không tiếp tục được task')
  if (r)
    toast(
      r.started
        ? { kind: 'info', title: `Đang tiếp tục #${id}` }
        : { kind: 'info', title: `Đã đưa #${id} vào hàng đợi tiếp tục`, body: 'Đang hết slot chạy, task sẽ chạy tiếp khi tới lượt.' },
    )
}

// Review (PLAN 2.10). Lỗi (conflict, repo chính chưa sạch...) hiện toast; server đồng thời ghi
// `reviewWarning` lên task và broadcast nên banner cảnh báo trong tab Review cũng cập nhật.

type ReviewResult = { task: Task; review: ReviewAction; queued?: boolean }

function applyReview(r: ReviewResult) {
  onMessage({ type: 'review', review: r.review })
  onMessage({ type: 'task', task: r.task })
}

export async function approveTask(id: number): Promise<boolean> {
  // Task không thay đổi code thì Approve chỉ chuyển Done, không merge
  const hadChanges = (state.diffs[id]?.length ?? 0) > 0
  const r = await act(() => api<ReviewResult>('POST', `/tasks/${id}/review`, { action: 'approve' }), hadChanges ? 'Không merge được' : 'Không duyệt được')
  if (!r) return false
  applyReview(r)
  const main = state.projects.find((p) => p.id === r.task.projectId)?.mainBranch
  const title = hadChanges ? `Đã merge #${id}${main ? ` vào ${main}` : ''}` : `Đã duyệt #${id}, chuyển Done`
  toast({ kind: 'success', title, body: r.task.title })
  return true
}

export async function requestChanges(id: number, feedback: string, comments: ReviewComment[] = []): Promise<boolean> {
  const r = await act(
    () => api<ReviewResult>('POST', `/tasks/${id}/review`, { action: 'request_changes', feedback, comments }),
    'Không gửi được feedback',
  )
  if (!r) return false
  applyReview(r)
  if (r.queued) toast({ kind: 'info', title: `Đã gửi feedback cho #${id}`, body: 'Đang hết slot chạy, Claude sẽ sửa khi tới lượt.' })
  return true
}

/** Nội dung hiện tại của file trong worktree (Preview Markdown khi review). `null` nếu lỗi (đã báo toast). */
/** Kiểm tra trước khi Approve & Merge. Lỗi mạng thì trả null (giao diện hiện "chưa kiểm tra được"). */
export async function fetchMergeCheck(id: number): Promise<MergeCheck | null> {
  try {
    return await api<MergeCheck>('GET', `/tasks/${id}/merge-check`)
  } catch {
    return null
  }
}

export async function fetchTaskFile(id: number, path: string): Promise<string | null> {
  const r = await act(() => api<{ content: string }>('GET', `/tasks/${id}/file?${new URLSearchParams({ path })}`), `Không đọc được ${path}`)
  return r ? r.content : null
}

/** Lưu file Markdown đã sửa khi review: server ghi vào worktree, commit trên nhánh task và trả diff mới. */
export async function saveTaskFile(id: number, path: string, content: string): Promise<boolean> {
  const r = await act(() => api<{ committed: boolean; files: FileDiff[] }>('PUT', `/tasks/${id}/file`, { path, content }), `Không lưu được ${path}`)
  if (!r) return false
  set((s) => ({ diffs: { ...s.diffs, [id]: r.files } }))
  toast({ kind: 'success', title: r.committed ? `Đã lưu và commit ${path}` : `${path} không có thay đổi` })
  return true
}

export async function rejectTask(id: number): Promise<boolean> {
  const r = await act(() => api<ReviewResult>('POST', `/tasks/${id}/review`, { action: 'reject' }), 'Không reject được')
  if (!r) return false
  applyReview(r) // task chuyển Failed ("Bị từ chối khi review") → đã có toast từ notifyTransition
  return true
}

export async function decidePermission(reqId: string, decision: 'allow' | 'deny' | 'always' | 'timeout', reason?: string) {
  const body = decision === 'deny' && reason?.trim() ? { decision, reason: reason.trim() } : { decision }
  const saved = await act(() => api<PermissionRequest>('POST', `/permissions/${reqId}`, body), 'Không gửi được quyết định')
  // Cập nhật ngay, không chờ WS (các tab khác nhận qua broadcast 'permission')
  if (saved) onMessage({ type: 'permission', permission: saved })
  return saved
}

/** FR-46: duyệt một lần nhiều yêu cầu giống hệt nhau. Từng yêu cầu đã chốt được server broadcast qua WS. */
export async function decidePermissionsBatch(ids: string[], decision: 'allow' | 'deny', reason?: string) {
  const body = decision === 'deny' && reason?.trim() ? { ids, decision, reason: reason.trim() } : { ids, decision }
  const r = await act(() => api<{ decided: number; skipped: number }>('POST', '/permissions/batch', body), 'Không gửi được quyết định')
  if (r)
    toast({
      kind: 'success',
      title: `${decision === 'allow' ? 'Đã cho phép' : 'Đã từ chối'} ${r.decided} yêu cầu`,
      body: r.skipped ? `${r.skipped} yêu cầu đã được xử lý trước đó nên bỏ qua.` : undefined,
    })
  return r
}

/** Trả về thông báo lỗi (để hiện trong form) hoặc null nếu thành công. */
/** Thêm/sửa project. Trả về thông báo lỗi để hiện trong form, hoặc null nếu thành công (`onSaved` nhận project đã lưu). */
export async function saveProject(p: Project, onSaved?: (saved: Project) => void): Promise<string | null> {
  try {
    const saved = await api<Project>('POST', '/projects', p)
    set((s) => ({ projects: upsert(s.projects, saved) }))
    onSaved?.(saved)
    toast({ kind: 'success', title: `Đã lưu project ${saved.name}` })
    return null
  } catch (e) {
    return (e as Error).message
  }
}

export function deleteProject(id: string) {
  return act(() => api('DELETE', `/projects/${id}`), 'Không xoá được project')
}

export type TemplateInput = Omit<PromptTemplate, 'id'> & { id?: string }

/** Thêm (không có id) hoặc sửa template. Trả về thông báo lỗi để hiện trong form, hoặc null nếu thành công. */
export async function saveTemplate(t: TemplateInput): Promise<string | null> {
  try {
    const saved = t.id ? await api<PromptTemplate>('PUT', `/templates/${t.id}`, t) : await api<PromptTemplate>('POST', '/templates', t)
    set((s) => ({ templates: upsert(s.templates, saved) }))
    toast({ kind: 'success', title: `Đã lưu template ${saved.name}` })
    return null
  } catch (e) {
    return (e as Error).message
  }
}

export async function deleteTemplate(id: string) {
  if (await act(() => api('DELETE', `/templates/${id}`), 'Không xoá được template')) {
    set((s) => ({ templates: s.templates.filter((t) => t.id !== id) }))
  }
}

// ------------------------------------------------------------ lên lịch theo cron (PLAN 4.6)

export type ScheduleInput = Pick<Schedule, 'cron' | 'projectId' | 'title' | 'prompt' | 'priority' | 'enabled'> & { id?: string }

/** Thêm (không có id) hoặc sửa lịch. Trả về thông báo lỗi để hiện trong form, hoặc null nếu thành công. */
export async function saveSchedule(input: ScheduleInput): Promise<string | null> {
  try {
    const saved = input.id ? await api<Schedule>('PUT', `/schedules/${input.id}`, input) : await api<Schedule>('POST', '/schedules', input)
    set((s) => ({ schedules: upsert(s.schedules, saved) }))
    toast({ kind: 'success', title: 'Đã lưu lịch', body: saved.title })
    return null
  } catch (e) {
    return (e as Error).message
  }
}

export async function setScheduleEnabled(id: string, enabled: boolean) {
  const saved = await act(() => api<Schedule>('PUT', `/schedules/${id}`, { enabled }), 'Không lưu được lịch')
  if (saved) set((s) => ({ schedules: upsert(s.schedules, saved) }))
}

export async function deleteSchedule(id: string) {
  if (await act(() => api('DELETE', `/schedules/${id}`), 'Không xoá được lịch')) set((s) => ({ schedules: s.schedules.filter((x) => x.id !== id) }))
}

/** Lịch sử task đã tạo của một lịch (mới nhất trước). */
export const fetchScheduleRuns = (id: string) => api<ScheduleRun[]>('GET', `/schedules/${id}/runs`)

/** Xem trước các lần chạy kế tiếp; ném lỗi (tiếng Việt) nếu biểu thức sai. */
export async function previewCron(cron: string): Promise<number[]> {
  return (await api<{ next: number[] }>('GET', `/schedules/preview?${new URLSearchParams({ cron })}`)).next
}

const scheduleRunListeners = new Set<(r: ScheduleRun) => void>()
/** Nghe lịch sử mới (realtime) khi đang mở danh sách lịch sử. */
export function onScheduleRun(fn: (r: ScheduleRun) => void) {
  scheduleRunListeners.add(fn)
  return () => {
    scheduleRunListeners.delete(fn)
  }
}

// ------------------------------------------------------------ gợi ý rule allowlist (FR-44, PLAN P7-02)

export const fetchRuleSuggestions = (projectId: string) =>
  api<RuleSuggestion[]>('GET', `/projects/${encodeURIComponent(projectId)}/rule-suggestions`)

/** Bỏ qua một gợi ý; trả danh sách gợi ý mới (undefined nếu lỗi, đã có toast). */
export const dismissRuleSuggestion = (projectId: string, rule: string) =>
  act(() => api<RuleSuggestion[]>('POST', `/projects/${encodeURIComponent(projectId)}/rule-suggestions/dismiss`, { rule }), 'Không bỏ qua được gợi ý')

const ruleSuggestionListeners = new Set<(projectId: string, list: RuleSuggestion[]) => void>()
/** Nghe gợi ý mới (realtime) của các project. */
export function onRuleSuggestions(fn: (projectId: string, list: RuleSuggestion[]) => void) {
  ruleSuggestionListeners.add(fn)
  return () => {
    ruleSuggestionListeners.delete(fn)
  }
}

/** Bộ rule allowlist có sẵn (PLAN P7-01). */
export const fetchPermissionPresets = () => api<PermissionPreset[]>('GET', '/permission-presets')

/** Thống kê theo ngày/project (PLAN 4.4). Ngày được chia theo múi giờ của trình duyệt. */
export function fetchStats(days: StatsRange, projectId?: string): Promise<Stats> {
  const q = new URLSearchParams({ days: String(days), tz: String(new Date().getTimezoneOffset()) })
  if (projectId) q.set('projectId', projectId)
  return api<Stats>('GET', `/stats?${q}`)
}

export function updateSettings(patch: Partial<Omit<Settings, 'telegram'>>) {
  set((s) => ({ settings: { ...s.settings, ...patch } })) // cập nhật ngay cho mượt
  // Giá trị đã chuẩn hoá (giới hạn min/max) quay về qua WS 'settings' cho mọi tab
  return act(() => api<Settings>('PUT', '/settings', patch), 'Không lưu được cài đặt')
}

/** Lưu cấu hình Telegram (FR-51). Trả về thông báo lỗi hoặc null khi thành công. */
export async function saveTelegram(input: TelegramSettingsInput): Promise<string | null> {
  try {
    const saved = await api<Settings>('PUT', '/settings', { telegram: input })
    set(() => ({ settings: saved }))
    return null
  } catch (e) {
    return (e as Error).message
  }
}

/** Gửi tin nhắn thử bằng giá trị đang nhập (token bỏ trống thì dùng token đã lưu). */
export async function testTelegram(input: TelegramSettingsInput): Promise<string | null> {
  try {
    await api('POST', '/settings/telegram/test', { botToken: input.botToken || undefined, chatId: input.chatId, appUrl: input.appUrl })
    return null
  } catch (e) {
    return (e as Error).message
  }
}

// Bảng điều khiển demo chỉ có ở bản giả lập
export function setDemo(_patch: Partial<DemoFlags>) {}
export function resetDemo(_mode: 'seed' | 'empty' | 'many') {}
