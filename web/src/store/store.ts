// Store thật: dữ liệu từ backend (REST) và cập nhật realtime qua WebSocket.
// Giữ nguyên API với store giả lập (mock.ts) để giao diện không phải thay đổi.
import { useSyncExternalStore } from 'react'
import type {
  DemoFlags,
  FileDiff,
  LogEvent,
  PermissionMode,
  PermissionRequest,
  Priority,
  Project,
  PromptTemplate,
  ReviewAction,
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
  toasts: Toast[]
  settings: Settings
  demo: DemoFlags
  nextTaskId: number
  /** Trạng thái kết nối tới backend */
  connection: 'connecting' | 'online' | 'offline'
  loaded: boolean
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
  toasts: [],
  settings: {
    maxParallel: 2,
    browserNotifications: false,
    notifyOn: { review: true, needsInput: true, failed: true },
    permissionTimeoutMin: 30,
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
  if (state.settings.browserNotifications && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
    try {
      new Notification(t.title, { body: t.body })
    } catch {
      /* bỏ qua */
    }
  }
}

export function dismissToast(id: string) {
  set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }))
}

function notifyTransition(prev: TaskStatus | undefined, task: Task) {
  if (!prev || prev === task.status) return
  const on = state.settings.notifyOn
  if (task.status === 'review' && on.review) toast({ kind: 'info', title: `Cần review: #${task.id}`, body: task.title, taskId: task.id })
  if (task.status === 'needs_input' && on.needsInput) toast({ kind: 'warning', title: `Claude cần bạn: #${task.id}`, body: task.title, taskId: task.id })
  if (task.status === 'failed' && on.failed) toast({ kind: 'error', title: `Task lỗi: #${task.id}`, body: task.failReason ?? task.title, taskId: task.id })
  if (task.status === 'done' && prev === 'running') toast({ kind: 'success', title: `Hoàn thành: #${task.id}`, body: task.title, taskId: task.id })
}

// ------------------------------------------------------------ REST

class ApiError extends Error {}

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
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Lỗi ${res.status}`)
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
  const s = await api<Pick<State, 'projects' | 'templates' | 'schedules' | 'tasks' | 'runs' | 'settings' | 'permissions' | 'reviews' | 'diffs' | 'testRuns'>>('GET', '/state')
  loadedRuns.clear()
  loadedTests.clear()
  set(() => ({ ...s, schedules: s.schedules ?? [], testRuns: s.testRuns ?? [], testOutputs: {}, events: [], loaded: true }))
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

const upsert = <T extends { id: unknown }>(list: T[], item: T) =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]

function onMessage(m: ServerMessage) {
  switch (m.type) {
    case 'task': {
      const prev = state.tasks.find((t) => t.id === m.task.id)?.status
      set((s) => ({ tasks: upsert(s.tasks, m.task) }))
      notifyTransition(prev, m.task)
      break
    }
    case 'task_deleted':
      set((s) => ({ tasks: s.tasks.filter((t) => t.id !== m.id), testRuns: s.testRuns.filter((r) => r.taskId !== m.id) }))
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
    case 'notification':
      // Hook Notification của Claude (PLAN 3.6); nội dung cũng đã nằm trong log dưới dạng event system.
      if (state.settings.notifyOn.needsInput)
        toast({ kind: 'warning', title: `#${m.taskId}: ${m.title ?? 'Claude gửi thông báo'}`, body: m.message, taskId: m.taskId })
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
  run: boolean
}

export async function createTask(input: NewTask): Promise<number> {
  const t = await act(() => api<Task>('POST', '/tasks', input), 'Không tạo được task')
  if (!t) throw new ApiError('create failed')
  set((s) => ({ tasks: upsert(s.tasks, t) }))
  toast({ kind: 'success', title: input.run ? `Đã đưa #${t.id} vào hàng đợi` : `Đã lưu #${t.id} vào Backlog`, body: t.title })
  return t.id
}

export function updateTask(id: number, patch: Partial<Pick<Task, 'title' | 'prompt' | 'priority' | 'projectId' | 'tags' | 'permissionMode'>>) {
  return act(() => api('PATCH', `/tasks/${id}`, patch), 'Không lưu được task')
}

export async function deleteTask(id: number) {
  if (await act(() => api('DELETE', `/tasks/${id}`), 'Không xoá được task')) toast({ kind: 'info', title: `Đã xoá task #${id}` })
}

export const queueTask = (id: number) => act(() => api('POST', `/tasks/${id}/queue`))
export const unqueueTask = (id: number) => act(() => api('POST', `/tasks/${id}/unqueue`))
export const stopTask = (id: number) => act(() => api('POST', `/tasks/${id}/stop`), 'Không dừng được task')

export async function retryTask(id: number) {
  if (await act(() => api('POST', `/tasks/${id}/retry`))) toast({ kind: 'info', title: `Đã đưa #${id} vào hàng đợi chạy lại` })
}

export async function approveTask(id: number): Promise<boolean> {
  return !!(await act(() => api('POST', `/tasks/${id}/review`, { action: 'approve' }), 'Không merge được'))
}

export function requestChanges(id: number, feedback: string) {
  return act(() => api('POST', `/tasks/${id}/review`, { action: 'request_changes', feedback }))
}

export function rejectTask(id: number) {
  return act(() => api('POST', `/tasks/${id}/review`, { action: 'reject' }))
}

export function decidePermission(reqId: string, decision: 'allow' | 'deny' | 'always' | 'timeout') {
  return act(() => api('POST', `/permissions/${reqId}`, { decision }))
}

/** Trả về thông báo lỗi (để hiện trong form) hoặc null nếu thành công. */
export async function saveProject(p: Project): Promise<string | null> {
  try {
    const saved = await api<Project>('POST', '/projects', p)
    set((s) => ({ projects: upsert(s.projects, saved) }))
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

/** Thống kê theo ngày/project (PLAN 4.4). Ngày được chia theo múi giờ của trình duyệt. */
export function fetchStats(days: StatsRange, projectId?: string): Promise<Stats> {
  const q = new URLSearchParams({ days: String(days), tz: String(new Date().getTimezoneOffset()) })
  if (projectId) q.set('projectId', projectId)
  return api<Stats>('GET', `/stats?${q}`)
}

export function updateSettings(patch: Partial<Omit<Settings, 'telegram'>>) {
  set((s) => ({ settings: { ...s.settings, ...patch } })) // cập nhật ngay cho mượt
  return act(() => api('PUT', '/settings', patch), 'Không lưu được cài đặt')
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
