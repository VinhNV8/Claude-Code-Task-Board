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
  ReviewAction,
  Run,
  Settings,
  Task,
  TaskStatus,
  Toast,
} from '../types'

export interface State {
  projects: Project[]
  tasks: Task[]
  runs: Run[]
  events: LogEvent[]
  diffs: Record<number, FileDiff[]>
  permissions: PermissionRequest[]
  reviews: ReviewAction[]
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
  tasks: [],
  runs: [],
  events: [],
  diffs: {},
  permissions: [],
  reviews: [],
  toasts: [],
  settings: { maxParallel: 2, browserNotifications: false, notifyOn: { review: true, needsInput: true, failed: true }, permissionTimeoutMin: 30 },
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
  const s = await api<Pick<State, 'projects' | 'tasks' | 'runs' | 'settings' | 'permissions' | 'reviews' | 'diffs'>>('GET', '/state')
  loadedRuns.clear()
  set(() => ({ ...s, events: [], loaded: true }))
}

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
      set((s) => ({ tasks: s.tasks.filter((t) => t.id !== m.id) }))
      break
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
      set((s) => ({ projects: s.projects.filter((p) => p.id !== m.id) }))
      break
    case 'settings':
      set(() => ({ settings: m.settings }))
      break
    case 'permission':
      set((s) => ({ permissions: upsert(s.permissions, m.permission) }))
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

export function updateSettings(patch: Partial<Settings>) {
  set((s) => ({ settings: { ...s.settings, ...patch } })) // cập nhật ngay cho mượt
  return act(() => api('PUT', '/settings', patch), 'Không lưu được cài đặt')
}

// Bảng điều khiển demo chỉ có ở bản giả lập
export function setDemo(_patch: Partial<DemoFlags>) {}
export function resetDemo(_mode: 'seed' | 'empty' | 'many') {}
