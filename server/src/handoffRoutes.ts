// API "Mở task trong Claude Code" (SPEC-PLAN-HANDOFF Phần B, FR-110..116).
//   POST /api/tasks/:id/handoff          bắt đầu: khoá task, trả lệnh để mở / sao chép
//   GET  /api/handoffs/wait              long-poll cho extension VS Code: các yêu cầu mở chưa ai nhận
//   POST /api/tasks/:id/handoff/claim    extension nhận việc (chỉ lần đầu thành công), trả lệnh mở terminal
//   POST /api/tasks/:id/handoff/end      mở khoá: ghi nhận thay đổi, run 'manual', task về Review
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { broadcast, setTaskDecorator } from './bus.ts'
import { events, projects, runs, settings, tasks, telegramToken } from './db.ts'
import { sendTelegram, taskLink } from './telegram.ts'
import { HttpError } from './httpError.ts'
import { getAdapter } from './agents/index.ts'
import { captureChanges, runNumber } from './capture.ts'
import { stopTask, updateTask } from './runner.ts'
import {
  HANDOFF_REMIND_MS,
  displayCommand,
  handoffCheck,
  handoffs,
  interactiveArgs,
  sessionAgent,
  type Handoff,
  type HandoffVia,
  type InteractiveCommand,
} from './handoff.ts'
import type { Task } from './types.ts'

/** Yêu cầu mở qua extension cũ hơn mốc này không còn phát cho extension (người dùng đã chuyển sang cách khác). */
const PENDING_TTL_MS = 2 * 60 * 1000
const WAIT_MS = 25_000

// Gắn trạng thái khoá vào task gửi cho web (FR-113).
setTaskDecorator((t: Task) => {
  const h = handoffs.get(t.id)
  return h ? { ...t, handoff: { via: h.via, startedAt: h.startedAt, claimed: !!h.claimedAt } } : t
})

// ---------------------------------------------------------------- long-poll cho extension

const waiters = new Set<() => void>()
const wake = () => {
  for (const w of [...waiters]) w()
}

function pending(now = Date.now()) {
  return handoffs
    .all()
    .filter((h) => h.via === 'extension' && !h.claimedAt && now - h.startedAt < PENDING_TTL_MS)
    .map((h) => ({ taskId: h.taskId, requestId: h.requestId, repoPath: projects.get(tasks.get(h.taskId)?.projectId ?? '')?.repoPath ?? h.cwd }))
}

// ---------------------------------------------------------------- dựng lệnh

function commandFor(task: Task, h: Pick<Handoff, 'agent' | 'cwd'>): InteractiveCommand {
  const adapter = getAdapter(h.agent)
  const bin = adapter?.findBin()
  if (!bin) throw new HttpError(409, adapter?.missingBinReason ?? `Task Board chưa hỗ trợ agent "${h.agent}".`)
  const lastRun = runs.byTask(task.id).filter((r) => r.kind !== 'manual').at(-1)
  const args = interactiveArgs(h.agent, task.sessionId ?? '', lastRun?.requestedModel)
  if (!args || !task.sessionId) throw new HttpError(409, `Agent ${h.agent} chưa hỗ trợ mở phiên tương tác.`)
  return { file: bin.path, args, cwd: h.cwd, display: displayCommand(bin.path, args, h.cwd) }
}

/** Thư mục làm việc của task: worktree (mode Nhánh riêng) hoặc thư mục project (mode Ghi thẳng). */
const taskCwd = (t: Task) => t.worktreePath ?? projects.get(t.projectId)?.repoPath

function getTask(raw: string) {
  const t = tasks.get(Number(raw))
  if (!t) throw new HttpError(404, `Không tìm thấy task #${raw}`)
  return t
}

// ---------------------------------------------------------------- kết thúc

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })

/**
 * FR-115: mở khoá. Ghi một run 'manual' (chi phí không rõ, D9), commit thay đổi (mode Nhánh riêng) hoặc chụp
 * snapshot (mode Ghi thẳng), task về Review và tính lại diff (updateTask → publishDiff).
 */
export async function endHandoff(taskId: number, now = Date.now()) {
  const h = handoffs.get(taskId)
  const task = tasks.get(taskId)
  if (!h || !task) return task
  handoffs.end(taskId) // mở khoá trước: lỗi ghi nhận thay đổi không được để task kẹt khoá
  const project = projects.get(task.projectId)
  const run = runs.create({
    id: randomUUID(),
    taskId,
    kind: 'manual',
    sessionId: task.sessionId,
    startedAt: h.startedAt,
    agent: h.agent,
    phase: task.planPhase,
  })
  const ev = events.add(run.id, {
    type: 'system',
    text: `Bạn đã làm tiếp trong ${h.agent === 'claude' ? 'Claude Code' : h.agent} (${hhmm(h.startedAt)}–${hhmm(now)}). Chi phí phần này không tính được.`,
  })
  broadcast({ type: 'event', event: ev })
  let headRef: string | undefined
  let failReason: string | undefined
  if (project && task.worktreePath) {
    try {
      ;({ headRef } = await captureChanges(
        { id: task.id, title: task.title, baseRef: task.baseRef, worktreePath: task.worktreePath },
        project,
        runNumber(runs.byTask(taskId), run.id),
      ))
    } catch (e) {
      failReason = `Không ghi nhận được thay đổi làm tay: ${(e as Error).message}`
    }
  }
  broadcast({ type: 'run', run: runs.finish(run.id, { endedAt: now, exitCode: failReason ? 1 : 0, summary: failReason ?? 'Làm tay trong Claude Code' }) })
  return failReason
    ? updateTask(taskId, { status: 'failed', failReason })
    : updateTask(taskId, { status: 'review', failReason: null, reviewWarning: null, ...(headRef ? { headRef } : {}) })
}

// ---------------------------------------------------------------- nhắc task khoá lâu (FR-114c)

export interface RemindDeps {
  notifyWeb: (taskId: number, message: string) => void
  notifyTelegram: (text: string) => Promise<void>
  log: (msg: string) => void
}

const defaultRemindDeps: RemindDeps = {
  notifyWeb: (taskId, message) => {
    const runId = runs.byTask(taskId).at(-1)?.id ?? ''
    broadcast({ type: 'notification', taskId, runId, title: 'Task vẫn đang khoá', message })
  },
  notifyTelegram: async (text) => {
    const s = settings.get()
    const token = telegramToken.get()
    if (!s.telegram.enabled || !s.telegram.chatId || !token) return
    await sendTelegram({ token, chatId: s.telegram.chatId }, text)
  },
  log: (msg) => console.warn(msg),
}

/**
 * FR-114c (bản 1): task khoá quá 12 giờ thì nhắc một lần (web + Telegram), không tự mở khoá.
 * Khác spec ban đầu: không xét "thư mục không đổi", vì cần chụp trạng thái thư mục định kỳ; nhắc theo thời gian là đủ
 * để người dùng không quên task đang khoá (ví dụ mở từ lệnh sao chép rồi đóng máy).
 */
export function remindStaleHandoffs(now = Date.now(), deps: RemindDeps = defaultRemindDeps): number[] {
  const due = handoffs.all().filter((h) => !h.remindedAt && now - h.startedAt >= HANDOFF_REMIND_MS)
  for (const h of due) {
    handoffs.markReminded(h.taskId, now)
    const t = tasks.get(h.taskId)
    if (!t) continue
    const hours = Math.floor((now - h.startedAt) / 3_600_000)
    const message = `Task #${t.id} "${t.title}" đã mở trong Claude Code ${hours} giờ và vẫn đang khoá. Làm xong thì đóng terminal hoặc bấm "Đưa về Review".`
    deps.notifyWeb(t.id, message)
    const link = taskLink(settings.get().telegram.appUrl, t.id)
    const text = `🔒 ${message}${link ? `\nMở task: ${link}` : ''}`
    deps.notifyTelegram(text).catch((e) => deps.log(`Gửi Telegram nhắc task khoá #${t.id} thất bại: ${(e as Error).message}`))
  }
  return due.map((h) => h.taskId)
}

const REMIND_EVERY_MS = 30 * 60 * 1000
setInterval(() => remindStaleHandoffs(), REMIND_EVERY_MS).unref()

// ---------------------------------------------------------------- routes

export function handoffRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string }; Body: { via?: string; stop?: boolean } }>('/api/tasks/:id/handoff', async (req) => {
    const t = getTask(req.params.id)
    const via: HandoffVia = req.body?.via === 'copy' ? 'copy' : 'extension'
    const agent = sessionAgent(runs.byTask(t.id).filter((r) => r.kind !== 'manual').at(-1))
    const cwd = taskCwd(t)
    const check = handoffCheck(t, { agent, cwd, locked: !!handoffs.get(t.id) })
    if (!check.ok) throw new HttpError(409, check.reason)
    if (check.needsStop && !req.body?.stop)
      throw new HttpError(409, 'Task đang chạy hoặc đang chờ trong hàng đợi. Dừng task để mở trong Claude Code?', 'NEEDS_STOP')
    // Kiểm tra lệnh trước khi dừng task: thiếu CLI thì báo lỗi, không dừng oan.
    const command = commandFor(t, { agent, cwd: cwd! })
    if (t.status === 'running' || t.status === 'needs_input') await stopTask(t.id)
    else if (t.status === 'queued') updateTask(t.id, { status: 'failed', failReason: 'Đã bỏ khỏi hàng đợi để mở trong Claude Code.' })
    const h = handoffs.start({ taskId: t.id, via, cwd: cwd!, agent })
    broadcast({ type: 'task', task: tasks.get(t.id)! })
    wake()
    // FR-116: phiên tương tác dùng đăng nhập trên máy, không dùng API key của Task Board.
    const warning =
      agent === 'claude' && settings.get().auth.mode === 'apiKey'
        ? 'Phiên Claude Code sẽ dùng đăng nhập trên máy của bạn, không dùng API key của Task Board. Chi phí phần làm tay không được tính vào budget project.'
        : undefined
    return { requestId: h.requestId, command, ...(warning ? { warning } : {}) }
  })

  app.get('/api/handoffs/wait', async (req) => {
    const now = pending()
    if (now.length) return { pending: now }
    return new Promise<{ pending: ReturnType<typeof pending> }>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        waiters.delete(done)
        resolve({ pending: pending() })
      }
      const timer = setTimeout(done, WAIT_MS)
      waiters.add(done)
      req.raw.on('close', () => {
        clearTimeout(timer)
        waiters.delete(done)
      })
    })
  })

  app.post<{ Params: { id: string }; Body: { requestId?: string } }>('/api/tasks/:id/handoff/claim', async (req) => {
    const t = getTask(req.params.id)
    const h = handoffs.get(t.id)
    if (!h || !req.body?.requestId || !handoffs.claim(t.id, req.body.requestId)) throw new HttpError(409, 'Yêu cầu mở đã được nhận hoặc đã huỷ')
    broadcast({ type: 'task', task: tasks.get(t.id)! })
    return { title: t.title, ...commandFor(t, h) }
  })

  app.post<{ Params: { id: string }; Body: { requestId?: string } }>('/api/tasks/:id/handoff/end', async (req) => {
    const t = getTask(req.params.id)
    const h = handoffs.get(t.id)
    if (!h) throw new HttpError(409, 'Task không đang mở trong Claude Code')
    // Terminal của một lần mở cũ đóng muộn không được mở khoá lần mở mới.
    if (req.body?.requestId && req.body.requestId !== h.requestId) throw new HttpError(409, 'Lần mở này đã cũ')
    return endHandoff(t.id)
  })
}
