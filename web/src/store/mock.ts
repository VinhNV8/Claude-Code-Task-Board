// Store GIẢ LẬP của prototype (chạy bằng `npm run dev:mock`). Bản thật: store.ts
// Store của prototype: dữ liệu giả và bộ giả lập việc Claude chạy task.
// P1 sẽ thay các action bên dưới bằng lời gọi REST/WS tới backend thật,
// còn giao diện giữ nguyên.
import { useSyncExternalStore } from 'react'
import { buildSeed, defaultSettings, diffPool, feedbackDiff, seedProjects } from '../mocks/data'
import type {
  DemoFlags,
  FileDiff,
  LogEvent,
  LogEventInput,
  PermissionMode,
  PermissionRequest,
  Priority,
  Project,
  ReviewAction,
  Run,
  RunKind,
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
}

const defaultDemo: DemoFlags = {
  speed: 1,
  mergeConflict: false,
  dirtyMainRepo: false,
  nextRunFails: false,
  nextRunAsksPermission: false,
}

function initialState(empty = false): State {
  const seed = buildSeed()
  return {
    projects: seedProjects,
    tasks: empty ? [] : seed.tasks,
    runs: empty ? [] : seed.runs,
    events: empty ? [] : seed.events,
    diffs: empty ? {} : seed.diffs,
    permissions: empty ? [] : seed.permissions,
    reviews: empty ? [] : seed.reviews,
    toasts: [],
    settings: defaultSettings,
    demo: defaultDemo,
    nextTaskId: seed.nextTaskId,
  }
}

// ------------------------------------------------------------ store tối giản

let state: State = initialState()
const listeners = new Set<() => void>()

function set(fn: (s: State) => Partial<State>) {
  state = { ...state, ...fn(state) }
  listeners.forEach((l) => l())
  afterChange()
}

export const getState = () => state
export const IS_MOCK = true
export function ensureEvents(_runId: string) {}

export function useStore(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

// ------------------------------------------------------------ tiện ích

const uid = () => Math.random().toString(36).slice(2, 10)
const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })

function patchTask(id: number, patch: Partial<Task>) {
  set((s) => ({
    tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t)),
  }))
}

function patchRun(id: string, patch: Partial<Run>) {
  set((s) => ({ runs: s.runs.map((r) => (r.id === id ? { ...r, ...patch } : r)) }))
}

function addEvent(runId: string, e: LogEventInput) {
  const full = { id: uid(), runId, ts: Date.now(), ...e } as LogEvent
  set((s) => ({ events: [...s.events, full] }))
}

export function toast(t: Omit<Toast, 'id'>) {
  const id = uid()
  set((s) => ({ toasts: [...s.toasts, { ...t, id }] }))
  setTimeout(() => dismissToast(id), 6000)
  browserNotify(t)
}

export function dismissToast(id: string) {
  set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }))
}

function browserNotify(t: Omit<Toast, 'id'>) {
  if (!state.settings.browserNotifications) return
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    new Notification(t.title, { body: t.body })
  } catch {
    /* bỏ qua */
  }
}

function notifyStatus(task: Task, status: TaskStatus) {
  const on = state.settings.notifyOn
  if (status === 'review' && on.review)
    toast({ kind: 'info', title: `Cần review: #${task.id}`, body: task.title, taskId: task.id })
  if (status === 'needs_input' && on.needsInput)
    toast({ kind: 'warning', title: `Claude cần bạn: #${task.id}`, body: task.title, taskId: task.id })
  if (status === 'failed' && on.failed)
    toast({ kind: 'error', title: `Task lỗi: #${task.id}`, body: task.title, taskId: task.id })
}

function setStatus(id: number, status: TaskStatus, extra: Partial<Task> = {}) {
  patchTask(id, { status, ...extra })
  const task = state.tasks.find((t) => t.id === id)
  if (task) notifyStatus(task, status)
}

// ------------------------------------------------------------ kịch bản chạy giả lập

type Step =
  | { kind: 'event'; e: LogEventInput }
  | { kind: 'permission'; tool: string; input: string }
  | { kind: 'finish' }

interface Active {
  taskId: number
  runId: string
  steps: Step[]
  idx: number
  timer?: ReturnType<typeof setTimeout>
  paused: boolean
  fails: boolean
}

const active = new Map<number, Active>()

function buildScript(task: Task, kind: RunKind, feedback: string | undefined, askPermission: boolean): Step[] {
  const ev = (e: LogEventInput): Step => ({ kind: 'event', e })
  const project = state.projects.find((p) => p.id === task.projectId)
  if (kind === 'resume') {
    return [
      ev({ type: 'system', text: 'Tiếp tục phiên (resume) với feedback của người dùng' }),
      ev({ type: 'assistant', text: `Đã nhận feedback: “${feedback}”. Tôi sẽ chỉnh lại.` }),
      ev({ type: 'tool_use', tool: 'Read', input: 'src/components/LoginForm.tsx' }),
      ev({ type: 'tool_result', tool: 'Read', output: '66 dòng' }),
      ev({ type: 'tool_use', tool: 'Edit', input: 'src/components/LoginForm.tsx' }),
      ev({ type: 'tool_result', tool: 'Edit', output: 'Đã sửa (+1 −1)' }),
      { kind: 'finish' },
    ]
  }
  const steps: Step[] = [
    ev({
      type: 'system',
      text: `Khởi tạo phiên • model claude-opus-5-5 • cwd …/worktrees/${project?.name}/${task.id}${kind === 'retry' ? ' • retry' : ''}`,
    }),
    ev({ type: 'assistant', text: 'Tôi sẽ tìm hiểu cấu trúc dự án và các file liên quan trước.' }),
    ev({ type: 'tool_use', tool: 'Glob', input: 'src/**/*.{ts,tsx}' }),
    ev({ type: 'tool_result', tool: 'Glob', output: '47 file' }),
    ev({ type: 'tool_use', tool: 'Grep', input: task.title.split(' ').slice(0, 2).join(' ') }),
    ev({ type: 'tool_result', tool: 'Grep', output: '3 file khớp' }),
    ev({ type: 'tool_use', tool: 'Read', input: 'src/lib/price.ts' }),
    ev({ type: 'tool_result', tool: 'Read', output: '24 dòng' }),
    ev({ type: 'assistant', text: 'Tôi đã hiểu vấn đề. Bắt đầu sửa code.' }),
    ev({ type: 'tool_use', tool: 'Edit', input: 'src/lib/price.ts' }),
    ev({ type: 'tool_result', tool: 'Edit', output: 'Đã sửa (+7 −2)' }),
  ]
  if (askPermission) {
    steps.push(
      ev({ type: 'assistant', text: 'Cần cài thêm thư viện để chạy test.' }),
      { kind: 'permission', tool: 'Bash', input: 'npm install -D vitest@2.1.5' },
    )
  }
  steps.push(
    ev({ type: 'tool_use', tool: 'Bash', input: 'npm test' }),
    ev({ type: 'tool_result', tool: 'Bash', output: 'Test Files  6 passed (6)\n     Tests  31 passed (31)' }),
    { kind: 'finish' },
  )
  return steps
}

function stepDelay() {
  return (900 + Math.random() * 900) / state.demo.speed
}

function startRun(taskId: number, kind: RunKind, feedback?: string) {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return
  const run: Run = { id: uid(), taskId, kind, feedback, startedAt: Date.now() }
  const fails = state.demo.nextRunFails
  const ask = state.demo.nextRunAsksPermission && kind !== 'resume'
  set((s) => ({
    runs: [...s.runs, run],
    demo: { ...s.demo, nextRunFails: false },
  }))
  const sessionId = kind === 'resume' ? task.sessionId : uuid()
  patchTask(taskId, {
    status: 'running',
    startedAt: Date.now(),
    sessionId,
    branch: task.branch ?? `claude/task-${task.id}`,
    failReason: undefined,
    reviewWarning: undefined,
  })
  const a: Active = { taskId, runId: run.id, steps: buildScript(task, kind, feedback, ask), idx: 0, paused: false, fails }
  if (fails) {
    // chèn lỗi giữa chừng
    a.steps = [
      ...a.steps.slice(0, 6),
      { kind: 'event', e: { type: 'tool_use', tool: 'Bash', input: 'npm run build' } },
      {
        kind: 'event',
        e: { type: 'tool_result', tool: 'Bash', isError: true, output: "error TS2307: Cannot find module '@/lib/format' or its corresponding type declarations." },
      },
      { kind: 'finish' },
    ]
  }
  active.set(taskId, a)
  schedule(a)
}

function schedule(a: Active) {
  a.timer = setTimeout(() => advance(a), stepDelay())
}

function advance(a: Active) {
  if (active.get(a.taskId) !== a || a.paused) return
  const step = a.steps[a.idx++]
  if (!step) return
  if (step.kind === 'event') {
    addEvent(a.runId, step.e)
    schedule(a)
    return
  }
  if (step.kind === 'permission') {
    requestPermission(a, step.tool, step.input)
    return
  }
  finishRun(a)
}

function matchesAllowed(project: Project | undefined, tool: string, input: string) {
  if (!project) return false
  return project.allowedTools.some((rule) => {
    const m = rule.match(/^(\w+)\((.*)\)$/)
    if (!m) return rule === tool
    if (m[1] !== tool) return false
    const pat = m[2]
    return pat.endsWith(':*') ? input.startsWith(pat.slice(0, -2)) : input === pat
  })
}

function requestPermission(a: Active, tool: string, input: string) {
  const task = state.tasks.find((t) => t.id === a.taskId)!
  const project = state.projects.find((p) => p.id === task.projectId)
  addEvent(a.runId, { type: 'tool_use', tool, input })
  if (matchesAllowed(project, tool, input)) {
    addEvent(a.runId, { type: 'system', text: `Tự động cho phép ${tool}(${input}) theo quy tắc của project` })
    addEvent(a.runId, { type: 'tool_result', tool, output: 'added 1 package in 2s' })
    schedule(a)
    return
  }
  a.paused = true
  const req: PermissionRequest = {
    id: uid(),
    taskId: a.taskId,
    tool,
    input,
    createdAt: Date.now(),
    timeoutAt: Date.now() + state.settings.permissionTimeoutMin * 60_000,
    status: 'pending',
  }
  set((s) => ({ permissions: [...s.permissions, req] }))
  addEvent(a.runId, { type: 'system', text: `Đang chờ bạn cấp quyền: ${tool}(${input})` })
  setStatus(a.taskId, 'needs_input')
}

function finishRun(a: Active) {
  active.delete(a.taskId)
  const task = state.tasks.find((t) => t.id === a.taskId)!
  const run = state.runs.find((r) => r.id === a.runId)!
  const turns = Math.round(5 + Math.random() * 10)
  const cost = Math.round((0.05 + Math.random() * 0.4) * 100) / 100
  if (a.fails) {
    const text = 'Build lỗi: không tìm thấy module `@/lib/format`. Tôi dừng lại để bạn kiểm tra cấu hình alias.'
    addEvent(a.runId, { type: 'result', isError: true, text })
    patchRun(a.runId, { endedAt: Date.now(), exitCode: 1, numTurns: turns, costUsd: cost, summary: text })
    setStatus(a.taskId, 'failed', { failReason: 'Claude kết thúc với lỗi (exit code 1): build thất bại do thiếu module `@/lib/format`' })
    return
  }
  let summary: string
  if (run.kind === 'resume') {
    summary = `Đã chỉnh theo feedback: ${run.feedback}`
    set((s) => ({
      diffs: { ...s.diffs, [task.id]: [...(s.diffs[task.id] ?? []).filter((d) => d.path !== feedbackDiff.path), feedbackDiff] },
    }))
  } else {
    summary = 'Đã hoàn thành yêu cầu, chỉnh sửa các file liên quan. Toàn bộ test (31) đều pass.'
    const pool = diffPool[task.id % diffPool.length]
    set((s) => ({ diffs: { ...s.diffs, [task.id]: pool } }))
  }
  addEvent(a.runId, { type: 'result', text: summary })
  patchRun(a.runId, { endedAt: Date.now(), exitCode: 0, numTurns: turns, costUsd: cost, summary })
  setStatus(a.taskId, 'review')
}

// ------------------------------------------------------------ hàng đợi

function runningCount(projectId?: string) {
  return state.tasks.filter(
    (t) => (t.status === 'running' || t.status === 'needs_input') && (!projectId || t.projectId === projectId),
  ).length
}

const PRIORITY_ORDER: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 }

let pumping = false
function afterChange() {
  if (pumping) return
  pumping = true
  queueMicrotask(() => {
    pumping = false
    pumpQueue()
  })
}

function pumpQueue() {
  const queued = state.tasks
    .filter((t) => t.status === 'queued')
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt)
  for (const t of queued) {
    if (runningCount() >= state.settings.maxParallel) return
    const project = state.projects.find((p) => p.id === t.projectId)
    if (project && runningCount(project.id) >= project.maxParallel) continue
    const isRetry = state.runs.some((r) => r.taskId === t.id)
    startRun(t.id, isRetry ? 'retry' : 'initial')
  }
}

// timeout xin quyền
setInterval(() => {
  const nowTs = Date.now()
  for (const p of state.permissions) {
    if (p.status === 'pending' && p.timeoutAt <= nowTs) decidePermission(p.id, 'timeout')
  }
}, 1000)

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
  const id = state.nextTaskId
  const task: Task = {
    id,
    title: input.title,
    prompt: input.prompt,
    projectId: input.projectId,
    priority: input.priority,
    permissionMode: input.permissionMode,
    tags: input.tags,
    status: input.run ? 'queued' : 'backlog',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  set((s) => ({ tasks: [...s.tasks, task], nextTaskId: s.nextTaskId + 1 }))
  toast({ kind: 'success', title: input.run ? `Đã đưa #${id} vào hàng đợi` : `Đã lưu #${id} vào Backlog`, body: input.title })
  return id
}

export function updateTask(id: number, patch: Partial<Pick<Task, 'title' | 'prompt' | 'priority' | 'projectId' | 'tags' | 'permissionMode'>>) {
  patchTask(id, patch)
}

export function deleteTask(id: number) {
  set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }))
  toast({ kind: 'info', title: `Đã xoá task #${id}` })
}

export function queueTask(id: number) {
  patchTask(id, { status: 'queued' })
}

export function unqueueTask(id: number) {
  patchTask(id, { status: 'backlog' })
}

export function stopTask(id: number) {
  const a = active.get(id)
  if (a) {
    clearTimeout(a.timer)
    active.delete(id)
    addEvent(a.runId, { type: 'result', isError: true, text: 'Đã dừng bởi người dùng.' })
    patchRun(a.runId, { endedAt: Date.now(), exitCode: 130 })
  } else {
    // task đang chờ quyền nhưng không có kịch bản chạy (dữ liệu mẫu)
    const open = state.runs.find((r) => r.taskId === id && r.endedAt === undefined)
    if (open) {
      addEvent(open.id, { type: 'result', isError: true, text: 'Đã dừng bởi người dùng.' })
      patchRun(open.id, { endedAt: Date.now(), exitCode: 130 })
    }
  }
  set((s) => ({
    permissions: s.permissions.map((p) => (p.taskId === id && p.status === 'pending' ? { ...p, status: 'denied' } : p)),
  }))
  setStatus(id, 'failed', { failReason: 'Đã dừng bởi người dùng' })
}

export function retryTask(id: number) {
  set((s) => {
    const diffs = { ...s.diffs }
    delete diffs[id]
    return { diffs }
  })
  patchTask(id, { status: 'queued', failReason: undefined })
  toast({ kind: 'info', title: `Đã đưa #${id} vào hàng đợi chạy lại` })
}

function addReview(taskId: number, action: ReviewAction['action'], feedback?: string) {
  set((s) => ({ reviews: [...s.reviews, { id: uid(), taskId, action, feedback, createdAt: Date.now() }] }))
}

export function approveTask(id: number): boolean {
  const task = state.tasks.find((t) => t.id === id)!
  const project = state.projects.find((p) => p.id === task.projectId)!
  if (state.demo.dirtyMainRepo) {
    patchTask(id, {
      reviewWarning: `Repo chính (${project.repoPath}) đang có thay đổi chưa commit. Hãy commit hoặc stash rồi thử lại.`,
    })
    toast({ kind: 'error', title: 'Không thể merge', body: 'Repo chính đang có thay đổi chưa commit' })
    return false
  }
  if (state.demo.mergeConflict) {
    set((s) => ({ demo: { ...s.demo, mergeConflict: false } }))
    patchTask(id, {
      reviewWarning: `Conflict khi merge ${task.branch} vào ${project.mainBranch} tại: src/components/LoginForm.tsx. Đã huỷ merge. Bạn có thể Request changes để Claude rebase và xử lý conflict.`,
    })
    toast({ kind: 'error', title: 'Merge bị conflict', body: `#${id} ${task.title}` })
    return false
  }
  addReview(id, 'approve')
  patchTask(id, { status: 'done', reviewWarning: undefined })
  toast({ kind: 'success', title: `Đã merge #${id} vào ${project.mainBranch}`, body: task.title })
  return true
}

export function requestChanges(id: number, feedback: string) {
  addReview(id, 'request_changes', feedback)
  patchTask(id, { reviewWarning: undefined })
  startRun(id, 'resume', feedback)
}

export function rejectTask(id: number) {
  addReview(id, 'reject')
  setStatus(id, 'failed', { failReason: 'Bị từ chối khi review. Worktree và nhánh đã bị xoá.', reviewWarning: undefined })
  set((s) => {
    const diffs = { ...s.diffs }
    delete diffs[id]
    return { diffs }
  })
}

export function decidePermission(reqId: string, decision: 'allow' | 'deny' | 'always' | 'timeout') {
  const req = state.permissions.find((p) => p.id === reqId)
  if (!req || req.status !== 'pending') return
  const status: PermissionRequest['status'] =
    decision === 'timeout' ? 'timeout' : decision === 'deny' ? 'denied' : 'allowed'
  set((s) => ({ permissions: s.permissions.map((p) => (p.id === reqId ? { ...p, status } : p)) }))

  const task = state.tasks.find((t) => t.id === req.taskId)
  if (!task) return
  if (decision === 'always') {
    const rule = `${req.tool}(${req.input.split(' ').slice(0, 2).join(' ')}:*)`
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === task.projectId && !p.allowedTools.includes(rule) ? { ...p, allowedTools: [...p.allowedTools, rule] } : p,
      ),
    }))
    toast({ kind: 'success', title: 'Đã thêm quy tắc cho phép', body: rule })
  }

  let a = active.get(req.taskId)
  if (!a) {
    // Task mẫu đang chờ sẵn (không có kịch bản đang chạy): tạo kịch bản chạy tiếp
    const run = [...state.runs].reverse().find((r) => r.taskId === req.taskId)
    if (!run) return
    a = {
      taskId: req.taskId,
      runId: run.id,
      idx: 0,
      paused: false,
      fails: false,
      steps: [
        { kind: 'event', e: { type: 'tool_use', tool: 'Edit', input: 'src/utils/date.ts' } },
        { kind: 'event', e: { type: 'tool_result', tool: 'Edit', output: 'Đã sửa (+12 −9)' } },
        { kind: 'event', e: { type: 'tool_use', tool: 'Bash', input: 'npm test' } },
        { kind: 'event', e: { type: 'tool_result', tool: 'Bash', output: 'Tests  31 passed (31)' } },
        { kind: 'finish' },
      ],
    }
    active.set(req.taskId, a)
  }
  a.paused = false
  if (status === 'allowed') {
    addEvent(a.runId, { type: 'system', text: `Bạn đã cho phép ${req.tool}(${req.input})` })
    addEvent(a.runId, { type: 'tool_result', tool: req.tool, output: 'added 1 package in 3s' })
  } else {
    addEvent(a.runId, {
      type: 'tool_result',
      tool: req.tool,
      isError: true,
      output: status === 'timeout' ? 'Hết thời gian chờ, quyền bị từ chối tự động' : 'Người dùng từ chối quyền',
    })
    addEvent(a.runId, { type: 'assistant', text: 'Không được phép chạy lệnh này, tôi sẽ tiếp tục mà không cài thêm thư viện.' })
  }
  patchTask(req.taskId, { status: 'running' })
  schedule(a)
}

// ------------------------------------------------------------ project & settings

export async function saveProject(p: Project): Promise<string | null> {
  if (/tmp|temp|notgit/i.test(p.repoPath)) return "Thư mục này không phải git repo (không tìm thấy .git)"
  set((s) => {
    const exists = s.projects.some((x) => x.id === p.id)
    return { projects: exists ? s.projects.map((x) => (x.id === p.id ? p : x)) : [...s.projects, p] }
  })
  toast({ kind: 'success', title: `Đã lưu project ${p.name}` })
  return null
}

export function deleteProject(id: string) {
  set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }))
}

export function updateSettings(patch: Partial<Settings>) {
  set((s) => ({ settings: { ...s.settings, ...patch } }))
}

// ------------------------------------------------------------ bảng điều khiển demo

export function setDemo(patch: Partial<DemoFlags>) {
  set((s) => ({ demo: { ...s.demo, ...patch } }))
}

export function resetDemo(mode: 'seed' | 'empty' | 'many') {
  active.forEach((a) => clearTimeout(a.timer))
  active.clear()
  const base = initialState(mode === 'empty')
  if (mode === 'many') {
    const titles = [
      'Tối ưu truy vấn danh sách đơn hàng', 'Thêm phân trang cho bảng sản phẩm', 'Sửa lỗi upload ảnh > 5MB',
      'Viết test cho giỏ hàng', 'Thêm export CSV báo cáo', 'Chuẩn hoá thông báo lỗi API', 'Cập nhật dependencies',
      'Thêm loading skeleton', 'Refactor module thanh toán', 'Sửa lỗi timezone ngày đặt hàng', 'Thêm rate limit cho API',
      'Dịch giao diện sang tiếng Anh',
    ]
    titles.forEach((title, i) => {
      base.tasks.push({
        id: base.nextTaskId++,
        projectId: seedProjects[i % 3].id,
        title,
        prompt: title,
        status: (['backlog', 'backlog', 'queued', 'done'] as const)[i % 4],
        priority: (['low', 'normal', 'high', 'urgent'] as const)[i % 4],
        permissionMode: 'acceptEdits',
        tags: [],
        createdAt: Date.now() - i * 600_000,
        updatedAt: Date.now() - i * 600_000,
      })
    })
  }
  state = { ...base, demo: state.demo, settings: state.settings }
  listeners.forEach((l) => l())
  afterChange()
}

// Bắt đầu chạy hàng đợi khi khởi động
afterChange()
