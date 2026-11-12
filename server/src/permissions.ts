// Duyệt quyền trên web (PLAN 3.3–3.5). MCP server `taskboard.approve` gọi long-poll về đây:
//   khớp allowlist của project  → cho phép ngay (FR-42)
//   không khớp                  → lưu permission_requests, task sang Needs Input, chờ người dùng quyết định
//   quá permissionTimeoutMin     → tự từ chối
// Task dừng/kết thúc trong lúc chờ → các yêu cầu còn treo bị huỷ.
import { randomUUID } from 'node:crypto'
import { bus, broadcast, type ServerMessage } from './bus.ts'
import { db, events, projects, settings, tasks } from './db.ts'
import { currentRunId, updateTask } from './runner.ts'
import { describeInput, matchesAllowed, rulesFor } from './permissionRules.ts'
import type { PermissionRequest } from './types.ts'

type Input = Record<string, unknown>
export type Decision = 'allow' | 'deny' | 'always' | 'timeout'
export type PollResponse =
  | { decision: 'allow'; updatedInput: Input }
  | { decision: 'deny'; message: string }
  | { status: 'pending'; requestId: string }

/** Backend trả `pending` trước mốc này để MCP server (requestTimeoutMs 90s) gọi lại. */
const POLL_WAIT_MS = 55_000
const ACTIVE = new Set(['running', 'needs_input'])

export class PermissionError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------- lưu trữ

interface Row {
  id: string
  task_id: number
  tool: string
  input_json: string
  status: PermissionRequest['status']
  created_at: number
  timeout_at: number
  decided_at: number | null
}

const toRequest = (r: Row): PermissionRequest => {
  const input = JSON.parse(r.input_json) as Input
  return {
    id: r.id,
    taskId: r.task_id,
    tool: r.tool,
    input: describeInput(r.tool, input),
    rules: rulesFor(r.tool, input),
    createdAt: r.created_at,
    timeoutAt: r.timeout_at,
    status: r.status,
  }
}

const getRow = (id: string) => db.prepare('SELECT * FROM permission_requests WHERE id = ?').get(id) as Row | undefined
const pendingRows = (taskId: number) =>
  db.prepare("SELECT * FROM permission_requests WHERE task_id = ? AND status = 'pending'").all(taskId) as unknown as Row[]

/** Yêu cầu đang chờ và 100 yêu cầu gần nhất (cho /api/state). */
export function listPermissions(): PermissionRequest[] {
  const rows = db
    .prepare(
      `SELECT * FROM permission_requests WHERE status = 'pending'
       UNION SELECT * FROM (SELECT * FROM permission_requests ORDER BY created_at DESC LIMIT 100)
       ORDER BY created_at`,
    )
    .all() as unknown as Row[]
  return rows.map(toRequest)
}

// ---------------------------------------------------------------- chờ quyết định

interface Live {
  timer: NodeJS.Timeout
  waiters: Set<(r: PollResponse) => void>
}
const live = new Map<string, Live>()

function logToRun(taskId: number, text: string) {
  const runId = currentRunId(taskId)
  if (runId) broadcast({ type: 'event', event: events.add(runId, { type: 'system', text }) })
}

function responseFor(r: Row): PollResponse | undefined {
  switch (r.status) {
    case 'pending':
      return undefined
    case 'allowed':
      return { decision: 'allow', updatedInput: JSON.parse(r.input_json) }
    case 'timeout':
      return { decision: 'deny', message: `Hết thời gian chờ duyệt quyền cho ${r.tool}, đã tự động từ chối.` }
    default:
      return { decision: 'deny', message: `Người dùng đã từ chối ${r.tool} trên Task Board.` }
  }
}

/** Chốt trạng thái một yêu cầu, trả lời các long-poll đang chờ, đưa task về Running nếu hết yêu cầu treo. */
function settle(id: string, status: Exclude<PermissionRequest['status'], 'pending'>, note?: string) {
  const res = db
    .prepare("UPDATE permission_requests SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
    .run(status, Date.now(), id)
  const row = getRow(id)
  if (!row || res.changes === 0) return row

  const l = live.get(id)
  live.delete(id)
  if (l) {
    clearTimeout(l.timer)
    const out = responseFor(row)!
    for (const w of l.waiters) w(out)
  }
  broadcast({ type: 'permission', permission: toRequest(row) })

  const label = { allowed: 'Đã cho phép', denied: 'Đã từ chối', timeout: 'Hết thời gian, tự động từ chối' }[status]
  logToRun(row.task_id, `${label}: ${row.tool}(${describeInput(row.tool, JSON.parse(row.input_json))})${note ? ` • ${note}` : ''}`)

  const t = tasks.get(row.task_id)
  if (t?.status === 'needs_input' && pendingRows(t.id).length === 0) updateTask(t.id, { status: 'running' })
  return row
}

function track(row: Row) {
  const timer = setTimeout(() => settle(row.id, 'timeout'), Math.max(0, row.timeout_at - Date.now()))
  timer.unref()
  live.set(row.id, { timer, waiters: new Set() })
}

function wait(id: string, ms: number): Promise<PollResponse> {
  const l = live.get(id)
  const row = getRow(id)
  if (!row) return Promise.resolve({ decision: 'deny', message: 'Yêu cầu xin quyền không còn tồn tại.' })
  const done = responseFor(row)
  if (done) return Promise.resolve(done)
  if (!l) {
    // Treo nhưng không còn được theo dõi (không nên xảy ra): theo dõi lại để timeout vẫn chạy
    track(row)
    return wait(id, ms)
  }
  return new Promise((resolve) => {
    const finish = (r: PollResponse) => {
      clearTimeout(t)
      l.waiters.delete(finish)
      resolve(r)
    }
    const t = setTimeout(() => finish({ status: 'pending', requestId: id }), ms)
    l.waiters.add(finish)
  })
}

// ---------------------------------------------------------------- API cho routes

export interface PermissionAsk {
  taskId: number
  toolName: string
  input: Input
  requestId?: string
}

/** POST /api/internal/permissions (MCP server gọi). */
export async function requestPermission(a: PermissionAsk, waitMs = POLL_WAIT_MS): Promise<PollResponse> {
  if (a.requestId) {
    const row = getRow(a.requestId)
    if (!row || row.task_id !== a.taskId) throw new PermissionError(404, 'Không tìm thấy yêu cầu xin quyền')
    return wait(row.id, waitMs)
  }

  const task = tasks.get(a.taskId)
  if (!task) throw new PermissionError(404, `Không tìm thấy task #${a.taskId}`)
  if (!ACTIVE.has(task.status) || !currentRunId(task.id))
    throw new PermissionError(409, `Task #${task.id} không có lần chạy nào đang diễn ra`)

  // Đọc allowlist mới nhất: quy tắc "Luôn cho phép" thêm giữa chừng cũng có hiệu lực ngay trong run hiện tại
  const project = projects.get(task.projectId)
  if (project && matchesAllowed(project.allowedTools, a.toolName, a.input)) {
    logToRun(task.id, `Tự động cho phép ${a.toolName}(${describeInput(a.toolName, a.input)}) theo quy tắc của project`)
    return { decision: 'allow', updatedInput: a.input }
  }

  const now = Date.now()
  const row: Row = {
    id: `perm-${randomUUID()}`,
    task_id: task.id,
    tool: a.toolName,
    input_json: JSON.stringify(a.input ?? {}),
    status: 'pending',
    created_at: now,
    timeout_at: now + settings.get().permissionTimeoutMin * 60_000,
    decided_at: null,
  }
  db.prepare(
    `INSERT INTO permission_requests (id, task_id, tool, input_json, status, created_at, timeout_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(row.id, row.task_id, row.tool, row.input_json, row.created_at, row.timeout_at)
  track(row)

  const req = toRequest(row)
  broadcast({ type: 'permission', permission: req })
  logToRun(task.id, `Claude xin quyền ${req.tool}(${req.input}), đang chờ bạn duyệt`)
  if (task.status === 'running') updateTask(task.id, { status: 'needs_input' })
  return wait(row.id, waitMs)
}

/** POST /api/permissions/:id (người dùng bấm trên web). */
export function decidePermission(id: string, decision: Decision): PermissionRequest {
  const row = getRow(id)
  if (!row) throw new PermissionError(404, 'Không tìm thấy yêu cầu xin quyền')
  if (row.status !== 'pending') throw new PermissionError(409, 'Yêu cầu này đã được xử lý')

  let note: string | undefined
  if (decision === 'always') {
    const task = tasks.get(row.task_id)
    const project = task && projects.get(task.projectId)
    const add = rulesFor(row.tool, JSON.parse(row.input_json)).filter((r) => !project?.allowedTools.includes(r))
    if (project && add.length) {
      const saved = projects.upsert({ ...project, allowedTools: [...project.allowedTools, ...add] })
      broadcast({ type: 'project', project: saved })
      note = `thêm quy tắc ${add.join(', ')}`
    }
  }
  const status = decision === 'deny' ? 'denied' : decision === 'timeout' ? 'timeout' : 'allowed'
  return toRequest(settle(id, status, note)!)
}

/** Khởi động: yêu cầu còn treo từ lần chạy trước không còn ai chờ → đánh dấu hết hạn. Theo dõi task dừng. */
export function initPermissions() {
  db.prepare("UPDATE permission_requests SET status = 'timeout', decided_at = ? WHERE status = 'pending'").run(Date.now())
  bus.on('message', (m: ServerMessage) => {
    if (m.type === 'task_deleted') {
      for (const [id, l] of live) if (!getRow(id)) (clearTimeout(l.timer), live.delete(id))
      return
    }
    if (m.type !== 'task' || ACTIVE.has(m.task.status)) return
    for (const r of pendingRows(m.task.id)) settle(r.id, 'denied', 'task đã dừng')
  })
}
