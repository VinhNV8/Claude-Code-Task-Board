// Duyệt quyền trên web (PLAN 3.3–3.5). MCP server `taskboard.approve` gọi long-poll về đây:
//   khớp allowlist của project  → cho phép ngay (FR-42)
//   không khớp                  → lưu permission_requests, task sang Needs Input, chờ người dùng quyết định
//   quá permissionTimeoutMin     → tự từ chối
// Task dừng/kết thúc trong lúc chờ → các yêu cầu còn treo bị huỷ.
import { randomUUID } from 'node:crypto'
import { bus, broadcast, type ServerMessage } from './bus.ts'
import { db, events, projects, settings, tasks } from './db.ts'
import { currentRunId, updateTask } from './runner.ts'
import { describeInput, matchesAllowed, riskOf, rulesFor } from './permissionRules.ts'
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
/** setTimeout tràn số (bắn ngay) khi delay > 2^31-1 ms (~24,8 ngày): hẹn từng chặng, tới hạn mới chốt. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** Đồng hồ dùng cho hạn chờ; test thay bằng đồng hồ giả qua setPermissionClock. */
let now: () => number = Date.now
export function setPermissionClock(clock?: () => number) {
  now = clock ?? Date.now
}

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
  deny_reason?: string | null
}

/** Độ dài tối đa của lý do từ chối (FR-46). */
export const MAX_DENY_REASON = 500

/** Chuẩn hoá lý do từ chối: trim, rỗng → undefined, quá dài → lỗi 400. */
export function normalizeReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) return undefined
  if (typeof reason !== 'string') throw new PermissionError(400, 'Lý do từ chối không hợp lệ')
  const r = reason.trim()
  if (r.length > MAX_DENY_REASON) throw new PermissionError(400, `Lý do từ chối tối đa ${MAX_DENY_REASON} ký tự`)
  return r || undefined
}

/** Thư mục Claude chạy cho task: worktree, chưa có thì repo của project (giống lúc so allowlist). */
function taskCwd(taskId: number): string | undefined {
  const task = tasks.get(taskId)
  if (!task) return
  return task.worktreePath ?? projects.get(task.projectId)?.repoPath
}

/** Rủi ro tính lúc đọc từ input đã lưu (không lưu DB): đổi quy tắc phân loại thì yêu cầu cũ cũng cập nhật. */
const riskOfRow = (r: Row) => riskOf(r.tool, JSON.parse(r.input_json) as Input, { cwd: taskCwd(r.task_id) })

const toRequest = (r: Row): PermissionRequest => {
  const input = JSON.parse(r.input_json) as Input
  const risk = riskOfRow(r)
  return {
    id: r.id,
    taskId: r.task_id,
    tool: r.tool,
    input: describeInput(r.tool, input),
    rules: rulesFor(r.tool, input),
    risk: risk.level,
    ...(risk.reasons.length ? { riskReasons: risk.reasons } : {}),
    createdAt: r.created_at,
    timeoutAt: r.timeout_at,
    status: r.status,
    ...(r.deny_reason ? { denyReason: r.deny_reason } : {}),
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
      return { decision: 'deny', message: denyMessage(r.tool, r.deny_reason) }
  }
}

/** Message deny gửi cho Claude; có lý do (FR-46) thì yêu cầu đổi cách làm thay vì thử lại đúng lệnh cũ. */
export function denyMessage(tool: string, reason?: string | null): string {
  const base = `Người dùng đã từ chối ${tool} trên Task Board.`
  if (!reason) return base
  return `${base} Lý do: ${reason}. Hãy điều chỉnh cách làm theo lý do này, không thử lại đúng thao tác vừa bị từ chối.`
}

/** Chốt trạng thái một yêu cầu, trả lời các long-poll đang chờ, đưa task về Running nếu hết yêu cầu treo. */
function settle(id: string, status: Exclude<PermissionRequest['status'], 'pending'>, note?: string, reason?: string) {
  const res = db
    .prepare("UPDATE permission_requests SET status = ?, decided_at = ?, deny_reason = ? WHERE id = ? AND status = 'pending'")
    .run(status, now(), status === 'denied' ? (reason ?? null) : null, id)
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
  const why = row.deny_reason ? ` • lý do: ${row.deny_reason}` : ''
  logToRun(row.task_id, `${label}: ${row.tool}(${describeInput(row.tool, JSON.parse(row.input_json))})${why}${note ? ` • ${note}` : ''}`)

  const t = tasks.get(row.task_id)
  if (t?.status === 'needs_input' && pendingRows(t.id).length === 0) updateTask(t.id, { status: 'running' })
  return row
}

/** Hẹn giờ tự từ chối theo timeout_at đã lưu (đồng hồ thật hoặc giả đều được kiểm lại lúc bắn). */
function schedule(id: string, timeoutAt: number): NodeJS.Timeout {
  const timer = setTimeout(
    () => {
      const l = live.get(id)
      if (!l || l.timer !== timer) return
      if (now() >= timeoutAt) return void settle(id, 'timeout')
      l.timer = schedule(id, timeoutAt) // chưa tới hạn (delay bị chặn MAX_TIMER_MS): hẹn tiếp
    },
    Math.min(MAX_TIMER_MS, Math.max(0, timeoutAt - now())),
  )
  timer.unref()
  return timer
}

function track(row: Row) {
  live.set(row.id, { timer: schedule(row.id, row.timeout_at), waiters: new Set() })
}

/**
 * Chốt 'timeout' cho mọi yêu cầu treo đã quá timeout_at. Timer tự gọi theo từng yêu cầu;
 * hàm này để quét bù (vd. sau khi đồng hồ nhảy, hoặc test dùng đồng hồ giả). Trả số yêu cầu đã chốt.
 */
export function expireOverdue(): number {
  const rows = db
    .prepare("SELECT * FROM permission_requests WHERE status = 'pending' AND timeout_at <= ?")
    .all(now()) as unknown as Row[]
  return rows.filter((r) => settle(r.id, 'timeout')?.status === 'timeout').length
}

function wait(id: string, ms: number): Promise<PollResponse> {
  let row = getRow(id)
  if (row?.status === 'pending' && row.timeout_at <= now()) row = settle(id, 'timeout')
  const l = live.get(id)
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
  // Quy tắc đường dẫn tương đối (`Edit(src/**)`) tính từ worktree mà Claude đang chạy trong đó
  const cwd = task.worktreePath ?? project?.repoPath
  // Lệnh rủi ro cao luôn phải duyệt tay, kể cả khi khớp allowlist (FR-45, AC-10)
  const highRisk = riskOf(a.toolName, a.input ?? {}, { cwd }).level === 'high'
  if (project && !highRisk && matchesAllowed(project.allowedTools, a.toolName, a.input ?? {}, { cwd })) {
    logToRun(task.id, `Tự động cho phép ${a.toolName}(${describeInput(a.toolName, a.input)}) theo quy tắc của project`)
    return { decision: 'allow', updatedInput: a.input }
  }

  const createdAt = now()
  const row: Row = {
    id: `perm-${randomUUID()}`,
    task_id: task.id,
    tool: a.toolName,
    input_json: JSON.stringify(a.input ?? {}),
    status: 'pending',
    created_at: createdAt,
    // Lưu mốc tuyệt đối để web đếm ngược đúng, kể cả khi settings đổi sau đó
    timeout_at: createdAt + settings.get().permissionTimeoutMin * 60_000,
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
export function decidePermission(id: string, decision: Decision, reason?: string): PermissionRequest {
  const why = normalizeReason(reason)
  const row = getRow(id)
  if (!row) throw new PermissionError(404, 'Không tìm thấy yêu cầu xin quyền')
  if (row.status !== 'pending') throw new PermissionError(409, 'Yêu cầu này đã được xử lý')

  if (decision === 'always' && riskOfRow(row).level === 'high')
    throw new PermissionError(400, 'Lệnh rủi ro cao không thể đặt Luôn cho phép')

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
  return toRequest(settle(id, status, note, why)!)
}

export type BatchDecision = 'allow' | 'deny'

/**
 * POST /api/permissions/batch (FR-46): duyệt một lần nhiều yêu cầu giống hệt nhau.
 * Không hỗ trợ 'always' (đặt quy tắc từng card). Id không tồn tại hoặc không còn pending thì bỏ qua.
 */
export function decidePermissionsBatch(ids: unknown, decision: unknown, reason?: unknown): { decided: number; skipped: number } {
  if (decision !== 'allow' && decision !== 'deny')
    throw new PermissionError(400, 'Duyệt hàng loạt chỉ hỗ trợ Cho phép hoặc Từ chối')
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== 'string'))
    throw new PermissionError(400, 'Danh sách yêu cầu không hợp lệ')
  const why = decision === 'deny' ? normalizeReason(reason) : undefined
  let decided = 0
  let skipped = 0
  for (const id of new Set(ids as string[])) {
    // Đồng bộ: kiểm pending rồi settle ngay, không có quyết định nào chen giữa
    if (getRow(id)?.status !== 'pending') {
      skipped++
      continue
    }
    settle(id, decision === 'deny' ? 'denied' : 'allowed', 'duyệt hàng loạt', why)
    decided++
  }
  return { decided, skipped }
}

/** Huỷ (denied) mọi yêu cầu còn treo của task và giải phóng long-poll đang chờ. */
export function cancelPending(taskId: number, note: string) {
  for (const r of pendingRows(taskId)) settle(r.id, 'denied', note)
}

let listening = false

/** Khởi động: yêu cầu còn treo từ lần chạy trước không còn ai chờ → đóng như timeout. Theo dõi task dừng. */
export function initPermissions() {
  // Khởi động thật thì `live` rỗng; dọn phòng trường hợp gọi lại (test mô phỏng khởi động lại)
  const timedOut: PollResponse = { decision: 'deny', message: 'Hết thời gian chờ duyệt quyền do server khởi động lại.' }
  for (const [, l] of live) {
    clearTimeout(l.timer)
    for (const w of l.waiters) w(timedOut)
  }
  live.clear()
  const closed = db
    .prepare("UPDATE permission_requests SET status = 'timeout', decided_at = ? WHERE status = 'pending' RETURNING *")
    .all(now()) as unknown as Row[]
  for (const r of closed) broadcast({ type: 'permission', permission: toRequest(r) })
  if (listening) return
  listening = true
  bus.on('message', (m: ServerMessage) => {
    if (m.type === 'task_deleted') {
      for (const [id, l] of live) if (!getRow(id)) (clearTimeout(l.timer), live.delete(id))
      return
    }
    // Tiến trình Claude kết thúc (thành công, lỗi hay bị Stop): không còn ai nhận quyết định.
    // Bus chạy đồng bộ nên task về Running trước khi runner (completeRun) đọc lại trạng thái.
    if (m.type === 'run' && m.run.endedAt != null) return cancelPending(m.run.taskId, 'tiến trình Claude đã kết thúc')
    if (m.type !== 'task' || ACTIVE.has(m.task.status)) return
    cancelPending(m.task.id, 'task đã dừng')
  })
}
