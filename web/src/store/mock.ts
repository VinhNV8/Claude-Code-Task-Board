// Store GIẢ LẬP của prototype (chạy bằng `npm run dev:mock`). Bản thật: store.ts
// Store của prototype: dữ liệu giả và bộ giả lập việc Claude chạy task.
// P1 sẽ thay các action bên dưới bằng lời gọi REST/WS tới backend thật,
// còn giao diện giữ nguyên.
import { useSyncExternalStore } from 'react'
import { buildSeed, defaultSettings, diffPool, feedbackDiff, promptTemplates, seedProjects } from '../mocks/data'
import { resumeBlocker } from '../lib/resume'
import { parseRefs, resolveRefs, unmetDeps } from '../lib/deps'
import { formatReviewFeedback } from '../lib/reviewComments'
import type {
  DemoFlags,
  FileDiff,
  MergeCheck,
  LogEvent,
  LogEventInput,
  PermissionMode,
  PermissionRequest,
  Priority,
  PermissionPreset,
  Project,
  PromptTemplate,
  ReviewAction,
  ReviewComment,
  RuleSuggestion,
  Run,
  RunKind,
  Schedule,
  ScheduleRun,
  Settings,
  Stats,
  StatsRange,
  Task,
  TaskStatus,
  TelegramSettingsInput,
  ClaudeAuthInput,
  TestOutput,
  TestRun,
  Toast,
} from '../types'
import { showBrowserNotification, transitionNotice, type Notice } from '../lib/notify'
import type { ClaudeLimit } from '../lib/claudeLimit'

export interface State {
  projects: Project[]
  templates: PromptTemplate[]
  schedules: Schedule[]
  tasks: Task[]
  runs: Run[]
  events: LogEvent[]
  diffs: Record<number, FileDiff[]>
  permissions: PermissionRequest[]
  reviews: ReviewAction[]
  testRuns: TestRun[]
  testOutputs: Record<number, TestOutput>
  claudeLimit: ClaudeLimit | null
  toasts: Toast[]
  settings: Settings
  demo: DemoFlags
  nextTaskId: number
  depsConfirm?: { taskId: number; message: string } | null
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
    templates: promptTemplates,
    schedules: [],
    tasks: empty ? [] : seed.tasks,
    runs: empty ? [] : seed.runs,
    events: empty ? [] : seed.events,
    diffs: empty ? {} : seed.diffs,
    permissions: empty ? [] : seed.permissions,
    reviews: empty ? [] : seed.reviews,
    testRuns: [],
    testOutputs: {},
    claudeLimit: null,
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
/** Bản giả lập: diff đã nằm sẵn trong state, không có gì để tải. */
export async function ensureDiff(_taskId: number, _force = false): Promise<string | null> {
  return null
}

// ------------------------------------------------------------ giả lập chạy test (FR-34)

const testTimers = new Map<number, ReturnType<typeof setInterval>>()

export function ensureTestOutput(_taskId: number) {}

function finishTest(taskId: number, patch: Partial<TestRun>) {
  clearInterval(testTimers.get(taskId))
  testTimers.delete(taskId)
  set((s) => ({ testRuns: s.testRuns.map((r) => (r.taskId === taskId ? { ...r, ...patch, endedAt: Date.now() } : r)) }))
}

export function runTests(taskId: number) {
  if (testTimers.has(taskId)) return toast({ kind: 'error', title: 'Không chạy được test', body: 'Test của task này đang chạy, hãy đợi xong hoặc bấm Dừng' })
  const project = state.projects.find((p) => p.id === state.tasks.find((t) => t.id === taskId)?.projectId)
  const command = project?.testCommand ?? 'npm test'
  const fail = Math.random() < 0.3
  const lines = [
    `> ${command}`,
    '',
    ' ✓ src/cart.test.ts (8 tests) 41ms',
    ' ✓ src/checkout.test.ts (5 tests) 63ms',
    fail ? ' ✗ src/login.test.ts > hiển thị lỗi khi sai mật khẩu\n   AssertionError: expected "" to contain "Sai mật khẩu"' : ' ✓ src/login.test.ts (6 tests) 27ms',
    '',
    fail ? ' Tests  1 failed | 18 passed (19)' : ' Tests  19 passed (19)',
  ]
  const run: TestRun = { taskId, command, status: 'running', startedAt: Date.now() }
  set((s) => ({
    testRuns: [...s.testRuns.filter((r) => r.taskId !== taskId), run],
    testOutputs: { ...s.testOutputs, [taskId]: { text: '', end: 0 } },
  }))
  let i = 0
  testTimers.set(
    taskId,
    setInterval(() => {
      if (i < lines.length) {
        const chunk = lines[i++] + '\n'
        set((s) => {
          const cur = s.testOutputs[taskId] ?? { text: '', end: 0 }
          return { testOutputs: { ...s.testOutputs, [taskId]: { text: cur.text + chunk, end: cur.end + chunk.length } } }
        })
      } else finishTest(taskId, fail ? { status: 'failed', exitCode: 1 } : { status: 'passed', exitCode: 0 })
    }, 400 / state.demo.speed),
  )
}

export function stopTests(taskId: number) {
  if (testTimers.has(taskId)) finishTest(taskId, { status: 'stopped', error: 'Đã dừng bởi người dùng.' })
}

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
}

export function dismissToast(id: string) {
  set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }))
}

/** Toast kèm thông báo trình duyệt nếu đã bật (giống store thật). */
export function notify(t: Notice, opts: { force?: boolean } = {}) {
  toast(t)
  if (state.settings.browserNotifications) showBrowserNotification(t, opts)
}

function setStatus(id: number, status: TaskStatus, extra: Partial<Task> = {}) {
  const prev = state.tasks.find((t) => t.id === id)?.status
  patchTask(id, { status, ...extra })
  const task = state.tasks.find((t) => t.id === id)
  const n = task && transitionNotice(prev, task, state.settings.notifyOn)
  if (n) notify(n)
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
  if (kind === 'continue') {
    return [
      ev({ type: 'system', text: 'Tiếp tục phiên cũ (resume) trên worktree đang làm dở' }),
      ev({ type: 'assistant', text: 'Phiên trước bị gián đoạn. Tôi kiểm tra lại các thay đổi đã làm rồi làm tiếp phần còn lại.' }),
      ev({ type: 'tool_use', tool: 'Bash', input: 'git status --short' }),
      ev({ type: 'tool_result', tool: 'Bash', output: ' M src/lib/price.ts' }),
      ev({ type: 'tool_use', tool: 'Bash', input: 'npm test' }),
      ev({ type: 'tool_result', tool: 'Bash', output: 'Test Files  6 passed (6)\n     Tests  31 passed (31)' }),
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
  const ask = state.demo.nextRunAsksPermission && kind !== 'resume' && kind !== 'continue'
  set((s) => ({
    runs: [...s.runs, run],
    demo: { ...s.demo, nextRunFails: false },
  }))
  const sessionId = kind === 'resume' || kind === 'continue' ? (task.sessionId ?? uuid()) : uuid()
  patchTask(taskId, {
    status: 'running',
    startedAt: Date.now(),
    sessionId,
    branch: task.branch ?? `claude/task-${task.id}`,
    worktreePath: task.worktreePath ?? `…/worktrees/${task.id}`,
    failReason: undefined,
    reviewWarning: undefined,
    resumeNext: undefined,
    notBefore: undefined,
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
  const auto = task.permissionMode === 'auto'
  if (auto || matchesAllowed(project, tool, input)) {
    addEvent(a.runId, {
      type: 'system',
      text: auto ? `Tự động cho phép ${tool}(${input}) (mode Auto)` : `Tự động cho phép ${tool}(${input}) theo quy tắc của project`,
    })
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

const pendingOf = (t: Task) => unmetDeps(t, (id) => state.tasks.find((x) => x.id === id)?.status)

function pumpQueue() {
  const queued = state.tasks
    .filter((t) => t.status === 'queued')
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt)
  for (const t of queued) {
    if (runningCount() >= state.settings.maxParallel) return
    const project = state.projects.find((p) => p.id === t.projectId)
    if (project && runningCount(project.id) >= project.maxParallel) continue
    if (t.notBefore && t.notBefore > Date.now()) continue // đang chờ giới hạn sử dụng
    if (pendingOf(t).length) continue // FR-08: còn chờ task chưa Done
    const isRetry = state.runs.some((r) => r.taskId === t.id)
    startRun(t.id, t.resumeNext ? 'continue' : isRetry ? 'retry' : 'initial')
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
  /** '' = kế thừa project → Settings (P5) */
  model?: string
  dependsOn?: number[]
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
    model: input.model || undefined,
    dependsOn: input.dependsOn?.length ? input.dependsOn : undefined,
    status: input.run ? 'queued' : 'backlog',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  set((s) => ({ tasks: [...s.tasks, task], nextTaskId: s.nextTaskId + 1 }))
  toast({ kind: 'success', title: input.run ? `Đã đưa #${id} vào hàng đợi` : `Đã lưu #${id} vào Backlog`, body: input.title })
  return id
}

export function updateTask(id: number, patch: Partial<Pick<Task, 'title' | 'prompt' | 'priority' | 'projectId' | 'tags' | 'permissionMode' | 'model' | 'dependsOn'>>) {
  patchTask(id, patch.dependsOn ? { ...patch, dependsOn: patch.dependsOn.length ? patch.dependsOn : undefined } : patch)
  afterChange()
}

export const closeDepsConfirm = () => set(() => ({ depsConfirm: null }))

export async function fetchDepSuggestions(input: { projectId: string; title: string; prompt: string; taskId?: number; dependsOn: number[] }) {
  const ids = resolveRefs(parseRefs(`${input.title}
${input.prompt}`), state.tasks, input.projectId, input.taskId)
  return ids
    .map((id) => state.tasks.find((t) => t.id === id)!)
    .filter((t) => t.status !== 'done' && !input.dependsOn.includes(t.id))
    .map((t) => ({ id: t.id, title: t.title, status: t.status }))
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

/** Chạy ngay (kéo task sang cột Running). Hết slot thì đưa vào hàng đợi. */
export function runTaskNow(id: number, ignoreDeps = false) {
  const t = state.tasks.find((x) => x.id === id)
  if (!t || (t.status !== 'backlog' && t.status !== 'queued')) return
  const pending = pendingOf(t)
  if (pending.length) {
    if (!ignoreDeps) {
      set(() => ({ depsConfirm: { taskId: id, message: `Task #${id} đang chờ ${pending.map((d) => `#${d}`).join(', ')} chưa Done.` } }))
      return
    }
    patchTask(id, { dependsOn: undefined })
  }
  const project = state.projects.find((p) => p.id === t.projectId)
  if (project && runningCount() < state.settings.maxParallel && runningCount(project.id) < project.maxParallel) {
    startRun(id, state.runs.some((r) => r.taskId === id) ? 'retry' : 'initial')
    return
  }
  patchTask(id, { status: 'queued' })
  toast({ kind: 'info', title: `Đã đưa #${id} vào hàng đợi`, body: 'Đang hết slot chạy, task sẽ chạy khi tới lượt.' })
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
  patchTask(id, { status: 'queued', failReason: undefined, resumeNext: undefined, notBefore: undefined, sessionId: undefined })
  toast({ kind: 'info', title: `Đã đưa #${id} vào hàng đợi chạy lại` })
}

/** Tiếp tục task bị tạm dừng / lỗi / chờ giới hạn sử dụng: giữ thay đổi dở dang, chạy tiếp phiên cũ. */
export function resumeTask(id: number) {
  const t = state.tasks.find((x) => x.id === id)
  if (!t) return
  const blocker = resumeBlocker(t)
  if (blocker) {
    toast({ kind: 'error', title: 'Không tiếp tục được task', body: blocker })
    return
  }
  const project = state.projects.find((p) => p.id === t.projectId)
  if (project && runningCount() < state.settings.maxParallel && runningCount(project.id) < project.maxParallel) {
    startRun(id, t.pendingFeedback ? 'resume' : 'continue', t.pendingFeedback)
    toast({ kind: 'info', title: `Đang tiếp tục #${id}` })
    return
  }
  patchTask(id, { status: 'queued', failReason: undefined, resumeNext: true, notBefore: undefined })
  toast({ kind: 'info', title: `Đã đưa #${id} vào hàng đợi tiếp tục`, body: 'Đang hết slot chạy, task sẽ chạy tiếp khi tới lượt.' })
}

function addReview(taskId: number, action: ReviewAction['action'], feedback?: string, comments?: ReviewComment[]) {
  const c = comments?.length ? comments : undefined
  set((s) => ({ reviews: [...s.reviews, { id: uid(), taskId, action, feedback: feedback || undefined, comments: c, createdAt: Date.now() }] }))
}

export function approveTask(id: number): boolean {
  const task = state.tasks.find((t) => t.id === id)!
  addReview(id, 'approve')
  patchTask(id, { status: 'done', reviewWarning: undefined })
  toast({ kind: 'success', title: `Đã chấp nhận output #${id}`, body: task.title })
  return true
}

export function mergeTask(id: number): boolean {
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
  addReview(id, 'merge')
  patchTask(id, { status: 'done', reviewWarning: undefined })
  toast({ kind: 'success', title: `Đã merge #${id} vào ${project.mainBranch}`, body: task.title })
  return true
}

export function requestChanges(id: number, feedback: string, comments: ReviewComment[] = []): boolean {
  addReview(id, 'request_changes', feedback, comments)
  patchTask(id, { reviewWarning: undefined })
  startRun(id, 'resume', formatReviewFeedback(feedback, comments))
  return true
}

// Preview/Edit Markdown: dựng nội dung "bản mới" từ diff giả lập (dòng ngữ cảnh + dòng thêm)
const mockFiles = new Map<string, string>()

export async function fetchMergeCheck(id: number): Promise<MergeCheck | null> {
  const task = state.tasks.find((t) => t.id === id)
  const project = task && state.projects.find((p) => p.id === task.projectId)
  if (!task || !project) return null
  const files = state.diffs[id] ?? []
  const base = { mainBranch: project.mainBranch, currentBranch: project.mainBranch, staged: [], checkedAt: Date.now() }
  if (!files.length) return { ...base, hasChanges: false, ready: true, dirty: [], overlap: [] }
  // Demo "repo chính bẩn": một file trùng với task + vài file không liên quan
  if (!state.demo.dirtyMainRepo) return { ...base, hasChanges: true, ready: true, dirty: ['docs/notes.md'], overlap: [] }
  const overlap = [files[0].path]
  return {
    ...base,
    hasChanges: true,
    ready: false,
    dirty: [...overlap, 'docs/notes.md', 'scripts/tmp.mjs'],
    overlap,
    warning: `Repo chính có 1 file chưa commit trùng với file task đã sửa: ${overlap[0]}. Hãy commit hoặc bỏ thay đổi ở các file này trước khi merge.`,
  }
}

/** Bản prototype: không có server xem trước, dựng trang từ nội dung file (chỉ bản Sau). */
export async function createPreviewLink(id: number, path: string, side: 'old' | 'new'): Promise<string> {
  if (side === 'old') throw new Error('Bản prototype chỉ xem được bản Sau')
  const content = await fetchTaskFile(id, path)
  if (content === null) throw new Error(`Không đọc được ${path}`)
  return URL.createObjectURL(new Blob([content], { type: 'text/html' }))
}

export async function fetchTaskFile(id: number, path: string): Promise<string | null> {
  const saved = mockFiles.get(`${id}:${path}`)
  if (saved !== undefined) return saved
  const f = state.diffs[id]?.find((d) => d.path === path)
  if (!f) return null
  return f.hunks.flatMap((h) => h.lines.filter((l) => l.type !== 'del').map((l) => l.text)).join('\n') + '\n'
}

export async function saveTaskFile(id: number, path: string, content: string): Promise<boolean> {
  mockFiles.set(`${id}:${path}`, content)
  toast({ kind: 'success', title: `Đã lưu và commit ${path}` })
  return true
}

export function rejectTask(id: number): boolean {
  addReview(id, 'reject')
  setStatus(id, 'failed', { failReason: 'Bị từ chối khi review. Worktree và nhánh đã bị xoá.', reviewWarning: undefined })
  set((s) => {
    const diffs = { ...s.diffs }
    delete diffs[id]
    return { diffs }
  })
  return true
}

/** FR-46 (giả lập): duyệt hàng loạt, bỏ qua yêu cầu không còn chờ. */
export function decidePermissionsBatch(ids: string[], decision: 'allow' | 'deny', reason?: string) {
  let decided = 0
  for (const id of new Set(ids)) {
    if (state.permissions.find((p) => p.id === id)?.status !== 'pending') continue
    decidePermission(id, decision, reason)
    decided++
  }
  const r = { decided, skipped: new Set(ids).size - decided }
  toast({ kind: 'success', title: `${decision === 'allow' ? 'Đã cho phép' : 'Đã từ chối'} ${r.decided} yêu cầu` })
  return r
}

export function decidePermission(reqId: string, decision: 'allow' | 'deny' | 'always' | 'timeout', reason?: string) {
  const req = state.permissions.find((p) => p.id === reqId)
  if (!req || req.status !== 'pending') return
  const status: PermissionRequest['status'] =
    decision === 'timeout' ? 'timeout' : decision === 'deny' ? 'denied' : 'allowed'
  const denyReason = decision === 'deny' && reason?.trim() ? reason.trim() : undefined
  set((s) => ({ permissions: s.permissions.map((p) => (p.id === reqId ? { ...p, status, ...(denyReason ? { denyReason } : {}) } : p)) }))

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

export type TemplateInput = Omit<PromptTemplate, 'id'> & { id?: string }

export async function saveTemplate(t: TemplateInput): Promise<string | null> {
  if (!t.name.trim()) return 'Nhập tên template'
  if (t.prompt.trim().length < 10) return 'Nội dung prompt cần ít nhất 10 ký tự'
  const saved: PromptTemplate = { ...t, id: t.id || `tpl-${uid()}` }
  set((s) => ({
    templates: s.templates.some((x) => x.id === saved.id) ? s.templates.map((x) => (x.id === saved.id ? saved : x)) : [...s.templates, saved],
  }))
  toast({ kind: 'success', title: `Đã lưu template ${saved.name}` })
  return null
}

export function deleteTemplate(id: string) {
  set((s) => ({ templates: s.templates.filter((t) => t.id !== id) }))
}

export function updateSettings(patch: Partial<Omit<Settings, 'telegram'>>) {
  set((s) => ({ settings: { ...s.settings, ...patch } }))
}

// Telegram (FR-51): prototype chỉ lưu cấu hình, không gửi tin thật.
export async function saveTelegram(input: TelegramSettingsInput): Promise<string | null> {
  set((s) => {
    const { botToken, ...rest } = input
    const hasToken = botToken === undefined ? s.settings.telegram.hasToken : !!botToken
    return { settings: { ...s.settings, telegram: { ...s.settings.telegram, ...rest, hasToken } } }
  })
  return null
}

// Xác thực Claude: prototype chỉ lưu chế độ và cờ có key, không lưu key thật.
export async function saveClaudeAuth(input: ClaudeAuthInput): Promise<string | null> {
  set((s) => {
    const cur = s.settings.auth
    const hasApiKey = input.apiKey === undefined ? cur.hasApiKey : !!input.apiKey
    const apiKeyHint = input.apiKey ? input.apiKey.trim().slice(-4) : input.apiKey === undefined ? cur.apiKeyHint : undefined
    return { settings: { ...s.settings, auth: { ...cur, mode: input.mode ?? cur.mode, hasApiKey, apiKeyHint } } }
  })
  return null
}

export async function testClaudeAuth(_apiKey?: string): Promise<string | null> {
  return 'Kiểm tra API key chỉ hoạt động khi chạy với backend thật (npm run dev)'
}

export async function testTelegram(_input: TelegramSettingsInput): Promise<string | null> {
  return 'Gửi thử Telegram chỉ hoạt động khi chạy với backend thật (npm run dev)'
}

// Thống kê (PLAN 4.4) tổng hợp ở backend; prototype không có dữ liệu lịch sử.
export async function fetchStats(_days: StatsRange, _projectId?: string): Promise<Stats> {
  throw new Error('Trang thống kê chỉ có dữ liệu khi chạy với backend thật (npm run dev)')
}

// Preset allowlist (PLAN P7-01) do backend định nghĩa.
export async function fetchPermissionPresets(): Promise<PermissionPreset[]> {
  throw new Error('Preset quyền chỉ có khi chạy với backend thật (npm run dev)')
}

// Gợi ý rule allowlist (FR-44) tính từ lịch sử duyệt ở backend; prototype không có lịch sử nên không gợi ý.
export async function fetchRuleSuggestions(_projectId: string): Promise<RuleSuggestion[]> {
  return []
}

export async function dismissRuleSuggestion(_projectId: string, _rule: string): Promise<RuleSuggestion[] | undefined> {
  return []
}

export function onRuleSuggestions(_fn: (projectId: string, list: RuleSuggestion[]) => void) {
  return () => {}
}

// Lên lịch (PLAN 4.6): prototype chỉ lưu danh sách, không tự tạo task theo giờ.
export type ScheduleInput = Pick<Schedule, 'cron' | 'projectId' | 'title' | 'prompt' | 'priority' | 'enabled'> & { id?: string }

export async function saveSchedule(input: ScheduleInput): Promise<string | null> {
  if (!input.cron.trim()) return 'Nhập biểu thức cron'
  if (!input.title.trim()) return 'Vui lòng nhập tiêu đề'
  if (input.prompt.trim().length < 10) return 'Mô tả cần ít nhất 10 ký tự'
  const prev = state.schedules.find((x) => x.id === input.id)
  const saved: Schedule = { ...prev, ...input, id: input.id || `sch-${uid()}`, createdAt: prev?.createdAt ?? Date.now(), nextRunAt: undefined }
  set((s) => ({ schedules: prev ? s.schedules.map((x) => (x.id === saved.id ? saved : x)) : [...s.schedules, saved] }))
  toast({ kind: 'success', title: 'Đã lưu lịch', body: saved.title })
  return null
}

export async function setScheduleEnabled(id: string, enabled: boolean) {
  set((s) => ({ schedules: s.schedules.map((x) => (x.id === id ? { ...x, enabled } : x)) }))
}

export async function deleteSchedule(id: string) {
  set((s) => ({ schedules: s.schedules.filter((x) => x.id !== id) }))
}

export async function fetchScheduleRuns(_id: string): Promise<ScheduleRun[]> {
  return []
}

export async function previewCron(_cron: string): Promise<number[]> {
  throw new Error('Xem trước lịch chỉ có khi chạy với backend thật (npm run dev)')
}

export function onScheduleRun(_fn: (r: ScheduleRun) => void) {
  return () => {}
}

// ------------------------------------------------------------ bảng điều khiển demo

export function setDemo(patch: Partial<DemoFlags>) {
  set((s) => ({ demo: { ...s.demo, ...patch } }))
  // Giả lập gói Claude hết lượt khung 5 giờ, có lại sau 1 giờ 20 phút
  if (patch.claudeLimited !== undefined) {
    const now = Date.now()
    const resetAt = now + 80 * 60_000
    set(() => ({ claudeLimit: patch.claudeLimited ? { kind: 'five_hour', resetAt, until: resetAt, since: now } : null }))
  }
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

// `dev:mock` thay store.ts bằng file này qua alias của Vite: tsc không thấy chỗ lệch, nên kiểm tra
// ở đây để mọi hàm giao diện import từ store thật đều có bản giả lập (thiếu thì typecheck báo lỗi).
type MissingInMock = Exclude<keyof typeof import('./store'), keyof typeof import('./mock')>
export const MOCK_EXPORTS_COMPLETE: [MissingInMock] extends [never] ? true : MissingInMock = true
