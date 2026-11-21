// Duyệt quyền qua Telegram (P7-03, FR-46): tin nhắn kèm nút inline + long polling getUpdates.
// Chỉ mở rộng luồng duyệt có sẵn (permissions.ts): quyết định vẫn đi qua decidePermission.
// Mọi phụ thuộc (fetch, DB, đồng hồ, sleep) truyền vào để test không cần mạng/DB.
import type { Answers, PermissionRequest, Settings, Task } from './types.ts'
import { taskLink, type FetchLike, type TelegramConfig } from './telegram.ts'

type Action = 'allow' | 'always' | 'deny'
const ACTIONS: Action[] = ['allow', 'always', 'deny']

/** FR-40: câu hỏi của Claude (AskUserQuestion) trả lời được bằng nút khi chỉ có một câu, chọn một đáp án. */
export const isQuestion = (req: Pick<PermissionRequest, 'questions'>) => !!req.questions?.length
export const buttonQuestion = (req: Pick<PermissionRequest, 'questions'>) => {
  const qs = req.questions ?? []
  return qs.length === 1 && !qs[0].multiSelect && qs[0].options.length > 0 ? qs[0] : undefined
}

// ---------------------------------------------------------------- gọi Bot API

/** Lỗi gọi Bot API; `status` = HTTP status (0 = lỗi mạng/timeout). Thông báo không bao giờ chứa token. */
export class TelegramApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function callTelegram<T = unknown>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetchImpl: FetchLike,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000)
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    })
  } catch (e) {
    if (opts.signal?.aborted) throw e
    throw new TelegramApiError(0, `Không kết nối được tới Telegram (${(e as Error)?.name ?? 'lỗi mạng'})`)
  }
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string }
  if (res.ok && data.ok !== false) return data.result as T
  const desc = typeof data.description === 'string' ? data.description.replaceAll(token, '***').slice(0, 200) : ''
  throw new TelegramApiError(res.status, `Telegram ${method} lỗi HTTP ${res.status}${desc ? `: ${desc}` : ''}`)
}

// ---------------------------------------------------------------- soạn tin

const MAX_DETAIL = 300

export function clip(s: string, max = MAX_DETAIL) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const PATH_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'Read', 'NotebookEdit', 'Glob', 'Grep'])

export function hhmm(ms: number) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function formatPermissionMessage(
  req: PermissionRequest,
  task: Pick<Task, 'id' | 'title'> | undefined,
  opts: { projectName?: string; appUrl: string; now: number },
) {
  if (isQuestion(req)) return formatQuestionMessage(req, task, opts)
  const label = req.tool === 'Bash' ? 'Lệnh' : PATH_TOOLS.has(req.tool) ? 'Đường dẫn' : 'Chi tiết'
  const lines = [`🔐 Claude xin quyền: #${req.taskId}`]
  if (task?.title) lines.push(task.title)
  if (opts.projectName) lines.push(`Project: ${opts.projectName}`)
  lines.push(`Công cụ: ${req.tool}`)
  if (req.input) lines.push(`${label}: ${clip(req.input)}`)
  if (req.risk === 'high') lines.push(`⚠️ Rủi ro cao${req.riskReasons?.length ? `: ${req.riskReasons.join('; ')}` : ''}`)
  const mins = Math.max(0, Math.round((req.timeoutAt - opts.now) / 60_000))
  lines.push(`Hạn chờ: ${hhmm(req.timeoutAt)} (còn ${mins} phút, quá hạn sẽ tự từ chối)`)
  const link = taskLink(opts.appUrl, req.taskId)
  if (link) lines.push('', `Mở task: ${link}`)
  return lines.join('\n')
}

function formatQuestionMessage(
  req: PermissionRequest,
  task: Pick<Task, 'id' | 'title'> | undefined,
  opts: { projectName?: string; appUrl: string; now: number },
) {
  const lines = [`❓ Claude hỏi: #${req.taskId}`]
  if (task?.title) lines.push(task.title)
  if (opts.projectName) lines.push(`Project: ${opts.projectName}`)
  for (const q of req.questions ?? []) {
    lines.push('', clip(q.question) + (q.multiSelect ? ' (chọn nhiều)' : ''))
    q.options.forEach((o, i) => lines.push(`${i + 1}. ${clip(o.label, 100)}${o.description ? ` — ${clip(o.description, 150)}` : ''}`))
  }
  const mins = Math.max(0, Math.round((req.timeoutAt - opts.now) / 60_000))
  lines.push('', `Hạn chờ: ${hhmm(req.timeoutAt)} (còn ${mins} phút, quá hạn Claude sẽ tự quyết)`)
  const link = taskLink(opts.appUrl, req.taskId)
  if (!buttonQuestion(req)) lines.push('Câu hỏi này cần trả lời trên web.')
  if (link) lines.push('', `${buttonQuestion(req) ? 'Mở task' : 'Trả lời trên web'}: ${link}`)
  return lines.join('\n')
}

export const callbackData = (requestId: string, action: Action | `o${number}`) => `perm:${requestId}:${action}`

export type ParsedCallback = { id: string; action: Action } | { id: string; action: 'option'; option: number }

export function parseCallbackData(data: unknown): ParsedCallback | undefined {
  if (typeof data !== 'string') return
  const m = /^perm:(.+):(allow|always|deny|o(\d{1,2}))$/.exec(data)
  if (!m) return
  return m[3] !== undefined ? { id: m[1], action: 'option', option: Number(m[3]) } : { id: m[1], action: m[2] as Action }
}

/** Bàn phím cho câu hỏi: mỗi lựa chọn một nút (một hàng) khi trả lời được bằng nút, luôn có "Bỏ qua". */
export function questionKeyboard(req: Pick<PermissionRequest, 'id' | 'questions'>) {
  const q = buttonQuestion(req)
  const rows = (q?.options ?? []).map((o, i) => [{ text: clip(o.label, 60), callback_data: callbackData(req.id, `o${i}`) }])
  rows.push([{ text: '⏭ Bỏ qua (Claude tự quyết)', callback_data: callbackData(req.id, 'deny') }])
  for (const r of rows)
    if (Buffer.byteLength(r[0].callback_data) > 64) throw new Error(`callback_data quá 64 byte cho yêu cầu ${req.id}`)
  return { inline_keyboard: rows }
}

/** Bàn phím inline; lệnh rủi ro cao (FR-45) không có nút "Luôn cho phép". */
export function permissionKeyboard(req: Pick<PermissionRequest, 'id' | 'risk'>) {
  const labels: Record<Action, string> = { allow: '✅ Cho phép', always: '♾ Luôn cho phép', deny: '⛔ Từ chối' }
  const actions = ACTIONS.filter((a) => a !== 'always' || req.risk !== 'high')
  for (const a of actions)
    if (Buffer.byteLength(callbackData(req.id, a)) > 64) throw new Error(`callback_data quá 64 byte cho yêu cầu ${req.id}`)
  return { inline_keyboard: [actions.map((a) => ({ text: labels[a], callback_data: callbackData(req.id, a) }))] }
}

const RESULT: Record<Action, string> = { allow: '✅ Đã cho phép', always: '♾ Đã luôn cho phép', deny: '⛔ Đã từ chối' }

/** Dòng kết quả khi yêu cầu được chốt ở nơi khác (web, hết hạn, task dừng). */
export function outsideResultLine(status: PermissionRequest['status'], at: number, question = false) {
  if (question) {
    if (status === 'timeout') return `⌛ Hết thời gian lúc ${hhmm(at)}, Claude tự quyết`
    return `🖥 Đã xử lý trên web lúc ${hhmm(at)} (${status === 'allowed' ? 'đã trả lời' : 'bỏ qua'})`
  }
  if (status === 'timeout') return `⌛ Hết thời gian, đã tự từ chối lúc ${hhmm(at)}`
  return `🖥 Đã xử lý trên web lúc ${hhmm(at)} (${status === 'allowed' ? 'cho phép' : 'từ chối'})`
}

// ---------------------------------------------------------------- gửi và sửa tin theo bus

interface SentMessage {
  chatId: string
  messageId: number
  text: string
}

// ---------------------------------------------------------------- duyệt kế hoạch (SPEC-PLAN-HANDOFF FR-106)

/** Kế hoạch đang chờ duyệt của task (lượt Kế hoạch gần nhất). */
export interface PendingPlan {
  task: Pick<Task, 'id' | 'title' | 'projectId' | 'planMode'>
  /** Id lượt Kế hoạch: mỗi lượt (kể cả sau Góp ý) gửi một tin. */
  runId: string
  plan: string
}

/** Kế hoạch dài hơn mức này thì cắt, kèm link xem đầy đủ trên web (tin Telegram tối đa 4096 ký tự). */
export const PLAN_PREVIEW_MAX = 3500

export const planCallbackData = (taskId: number) => `plan:${taskId}:approve`

export function parsePlanCallback(data: unknown): { taskId: number } | undefined {
  if (typeof data !== 'string') return
  const m = /^plan:(\d+):approve$/.exec(data)
  return m ? { taskId: Number(m[1]) } : undefined
}

export function formatPlanMessage(p: PendingPlan, opts: { projectName?: string; appUrl: string }) {
  const only = p.task.planMode === 'only'
  const lines = [only ? `📝 Kết quả phân tích chờ duyệt: #${p.task.id}` : `📝 Kế hoạch chờ duyệt: #${p.task.id}`, p.task.title]
  if (opts.projectName) lines.push(`Project: ${opts.projectName}`)
  const plan = p.plan.trim()
  lines.push('', plan.length > PLAN_PREVIEW_MAX ? `${plan.slice(0, PLAN_PREVIEW_MAX)}…\n(đã cắt bớt, xem đầy đủ trên web)` : plan || '(agent không trả về nội dung)')
  const link = taskLink(opts.appUrl, p.task.id)
  lines.push('', only ? 'Góp ý hoặc từ chối thì làm trên web.' : 'Muốn sửa kế hoạch, góp ý hoặc từ chối thì làm trên web.')
  if (link) lines.push(`Mở task: ${link}`)
  return lines.join('\n')
}

export function planKeyboard(p: PendingPlan) {
  return { inline_keyboard: [[{ text: p.task.planMode === 'only' ? '✅ Chấp nhận kết quả' : '▶️ Duyệt và thực hiện', callback_data: planCallbackData(p.task.id) }]] }
}

export interface ApproveDeps {
  fetchImpl: FetchLike
  getSettings: () => Settings
  getToken: () => string | undefined
  getTask: (id: number) => Pick<Task, 'id' | 'title' | 'projectId'> | undefined
  projectName: (projectId: string) => string | undefined
  /** decidePermission của permissions.ts; ném lỗi có statusCode khi không hợp lệ */
  decide: (id: string, decision: Action) => unknown
  /** answerQuestion của permissions.ts (FR-40). Không truyền thì nút lựa chọn báo "trả lời trên web". */
  answer?: (id: string, answers: Answers) => unknown
  /** FR-106: kế hoạch đang chờ duyệt của task (undefined = task không ở bước duyệt kế hoạch). */
  pendingPlan?: (taskId: number) => PendingPlan | undefined
  /** FR-106: "Duyệt và thực hiện" (kế hoạch trước) / "Chấp nhận" (chỉ kế hoạch); ném lỗi có statusCode khi không hợp lệ. */
  approvePlan?: (taskId: number) => Promise<unknown>
  now: () => number
  log: (msg: string) => void
}

export interface CallbackQuery {
  id: string
  data?: string
  from?: { id: number }
  message?: { message_id: number; text?: string; chat: { id: number; username?: string } }
}

/** Cấu hình dùng được cho duyệt quyền: bật, có token và chat ID. */
export function activeConfig(s: Settings, token: string | undefined): TelegramConfig | undefined {
  if (!s.telegram?.enabled || !s.telegram.chatId || !token) return
  return { token, chatId: s.telegram.chatId }
}

/** Chat của callback có đúng chat đã cấu hình không (ID số, hoặc @username với kênh/nhóm công khai). */
export function isConfiguredChat(chat: { id: number; username?: string } | undefined, chatId: string) {
  if (!chat) return false
  if (String(chat.id) === chatId) return true
  return chatId.startsWith('@') && !!chat.username && chat.username.toLowerCase() === chatId.slice(1).toLowerCase()
}

export function createTelegramApprover(deps: ApproveDeps) {
  /** requestId → tin đã gửi (để sửa sau). Chỉ trong bộ nhớ: server khởi động lại thì yêu cầu cũ cũng đã bị đóng. */
  const sent = new Map<string, SentMessage>()
  /** Yêu cầu đã/đang gửi tin, tránh gửi trùng khi bus phát lại cùng yêu cầu pending. */
  const announced = new Set<string>()
  /** FR-40: câu hỏi đã gửi (requestId → câu hỏi), để biết nút số i ứng với nhãn nào. */
  const questions = new Map<string, NonNullable<PermissionRequest['questions']>>()
  /** FR-106: taskId → tin kế hoạch đã gửi (kèm id lượt Kế hoạch để không gửi lại cùng một kế hoạch). */
  const planSent = new Map<number, SentMessage & { runId: string }>()

  const api = (token: string, method: string, body: Record<string, unknown>) => callTelegram(token, method, body, deps.fetchImpl)

  async function edit(token: string, m: SentMessage, line: string) {
    try {
      await api(token, 'editMessageText', {
        chat_id: m.chatId,
        message_id: m.messageId,
        text: `${m.text}\n\n${line}`.slice(0, 4000),
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [] },
      })
    } catch {
      // Tin đã bị xoá / quá cũ / mất mạng: bỏ qua theo yêu cầu
    }
  }

  async function announce(req: PermissionRequest) {
    const s = deps.getSettings()
    const cfg = activeConfig(s, deps.getToken())
    if (!cfg || !s.notifyOn.needsInput) return
    announced.add(req.id)
    const task = deps.getTask(req.taskId)
    const text = formatPermissionMessage(req, task, {
      projectName: task ? deps.projectName(task.projectId) : undefined,
      appUrl: s.telegram.appUrl,
      now: deps.now(),
    })
    try {
      const msg = await api(cfg.token, 'sendMessage', {
        chat_id: cfg.chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
        reply_markup: isQuestion(req) ? questionKeyboard(req) : permissionKeyboard(req),
      }) as { message_id: number; chat?: { id: number } }
      sent.set(req.id, { chatId: cfg.chatId, messageId: msg.message_id, text })
      if (isQuestion(req)) questions.set(req.id, req.questions!)
    } catch (e) {
      deps.log(`Gửi Telegram duyệt quyền cho task #${req.taskId} thất bại: ${(e as Error)?.message ?? e}`)
    }
  }

  /** FR-106: task vào bước duyệt kế hoạch → gửi tin có nút; rời bước đó (duyệt trên web, góp ý…) → sửa tin, bỏ nút. */
  async function onPlanTask(task: Task) {
    const prev = planSent.get(task.id)
    const p = deps.pendingPlan?.(task.id)
    if (!p) {
      if (!prev) return
      planSent.delete(task.id)
      const token = deps.getToken()
      if (token) await edit(token, prev, `🖥 Đã xử lý trên web lúc ${hhmm(deps.now())}`)
      return
    }
    if (prev?.runId === p.runId) return
    const s = deps.getSettings()
    const cfg = activeConfig(s, deps.getToken())
    if (!cfg || !s.notifyOn.review) return
    const text = formatPlanMessage(p, { projectName: deps.projectName(p.task.projectId), appUrl: s.telegram.appUrl })
    planSent.set(task.id, { chatId: cfg.chatId, messageId: 0, text, runId: p.runId }) // giữ chỗ: không gửi trùng khi bus phát lại
    try {
      const msg = (await api(cfg.token, 'sendMessage', {
        chat_id: cfg.chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
        reply_markup: planKeyboard(p),
      })) as { message_id: number }
      planSent.set(task.id, { chatId: cfg.chatId, messageId: msg.message_id, text, runId: p.runId })
    } catch (e) {
      deps.log(`Gửi Telegram duyệt kế hoạch cho task #${task.id} thất bại: ${(e as Error)?.message ?? e}`)
    }
  }

  /** Bộ nghe bus: yêu cầu pending mới → gửi tin có nút; yêu cầu được chốt ngoài Telegram → sửa tin, bỏ nút. */
  function onMessage(m: { type: string; permission?: PermissionRequest; task?: Task }): Promise<void> | undefined {
    if (m.type === 'task' && m.task && deps.pendingPlan) {
      return onPlanTask(m.task).catch((e) => deps.log(`Lỗi xử lý duyệt kế hoạch Telegram: ${(e as Error)?.message ?? e}`))
    }
    if (m.type !== 'permission' || !m.permission) return
    const req = m.permission
    try {
      if (req.status === 'pending') {
        if (announced.has(req.id)) return
        return announce(req)
      }
      announced.delete(req.id)
      questions.delete(req.id)
      const msg = sent.get(req.id)
      if (!msg) return
      sent.delete(req.id)
      const token = deps.getToken()
      if (!token) return
      return edit(token, msg, outsideResultLine(req.status, deps.now(), isQuestion(req)))
    } catch (e) {
      deps.log(`Lỗi xử lý duyệt quyền Telegram: ${(e as Error)?.message ?? e}`)
      return
    }
  }

  /** Xử lý một callback_query từ getUpdates. */
  async function handleCallback(cq: CallbackQuery, cfg: TelegramConfig) {
    const answer = (text: string) =>
      api(cfg.token, 'answerCallbackQuery', { callback_query_id: cq.id, text }).catch((e) =>
        deps.log(`answerCallbackQuery lỗi: ${(e as Error)?.message ?? e}`),
      )

    // BẢO MẬT: chỉ nhận nút bấm từ đúng chat đã cấu hình
    if (!isConfiguredChat(cq.message?.chat, cfg.chatId)) {
      deps.log(`Bỏ qua nút duyệt quyền Telegram từ chat lạ ${cq.message?.chat?.id ?? '?'}`)
      return answer('Không có quyền')
    }
    // FR-106: nút "Duyệt và thực hiện" / "Chấp nhận kết quả"
    const plan = parsePlanCallback(cq.data)
    if (plan) {
      const m = cq.message!
      const msg: SentMessage = planSent.get(plan.taskId) ?? { chatId: String(m.chat.id), messageId: m.message_id, text: m.text ?? '' }
      if (!deps.approvePlan) return answer('Hãy duyệt trên web')
      planSent.delete(plan.taskId) // xoá trước: task đổi trạng thái sẽ phát bus, không để onPlanTask sửa thành "trên web"
      try {
        await deps.approvePlan(plan.taskId)
      } catch (e) {
        const code = (e as { statusCode?: number; status?: number })?.statusCode ?? (e as { status?: number })?.status
        if (code === 409 || code === 404) {
          await answer('Kế hoạch đã được xử lý trước đó')
          await edit(cfg.token, msg, 'ℹ️ Kế hoạch đã được xử lý trước đó')
          return
        }
        return answer(code === 400 ? (e as Error).message.slice(0, 190) : 'Lỗi khi xử lý, hãy duyệt trên web')
      }
      const line = '✅ Đã duyệt'
      await answer(line)
      await edit(cfg.token, msg, `${line} lúc ${hhmm(deps.now())}`)
      return
    }
    const parsed = parseCallbackData(cq.data)
    if (!parsed) return answer('Nút không hợp lệ')

    const m = cq.message!
    const msg: SentMessage = sent.get(parsed.id) ?? { chatId: String(m.chat.id), messageId: m.message_id, text: m.text ?? '' }
    const qs = questions.get(parsed.id)
    let resultLine: string
    if (parsed.action === 'option') {
      // FR-40: nút lựa chọn của câu hỏi một đáp án
      const q = qs?.length === 1 && !qs[0].multiSelect ? qs[0] : undefined
      const opt = q?.options[parsed.option]
      if (!q || !opt || !deps.answer) return answer('Hãy trả lời câu hỏi này trên web')
      resultLine = `✅ Đã trả lời: ${clip(opt.label, 100)}`
    } else resultLine = qs && parsed.action === 'deny' ? '⏭ Đã bỏ qua, Claude tự quyết' : RESULT[parsed.action]
    // Xoá trước khi quyết định: settle() phát bus đồng bộ, không để onMessage sửa thành "trên web"
    sent.delete(parsed.id)
    try {
      if (parsed.action === 'option') {
        const q = qs![0]
        deps.answer!(parsed.id, { [q.question]: q.options[parsed.option].label })
      } else deps.decide(parsed.id, parsed.action)
      questions.delete(parsed.id)
    } catch (e) {
      const code = (e as { statusCode?: number })?.statusCode
      if (code === 409 || code === 404) {
        await answer(code === 409 ? 'Yêu cầu đã được xử lý trước đó' : 'Không tìm thấy yêu cầu')
        await edit(cfg.token, msg, code === 409 ? 'ℹ️ Yêu cầu đã được xử lý trước đó' : 'ℹ️ Yêu cầu không còn tồn tại')
        return
      }
      sent.set(parsed.id, msg) // yêu cầu vẫn còn chờ: giữ để sửa tin sau
      return answer(code === 400 ? (e as Error).message.slice(0, 190) : 'Lỗi khi xử lý, hãy duyệt trên web')
    }
    await answer(resultLine)
    await edit(cfg.token, msg, `${resultLine} lúc ${hhmm(deps.now())}`)
  }

  return { onMessage, handleCallback, sent, questions, planSent }
}

// ---------------------------------------------------------------- long polling

export const POLL_TIMEOUT_S = 50
export const BACKOFF_START_MS = 5_000
export const BACKOFF_MAX_MS = 60_000

export const nextBackoff = (prev: number) => (prev ? Math.min(prev * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS)

interface Update {
  update_id: number
  callback_query?: CallbackQuery
}

export interface PollerDeps {
  fetchImpl: FetchLike
  getConfig: () => TelegramConfig | undefined
  getOffset: () => number
  setOffset: (offset: number) => void
  onCallback: (cq: CallbackQuery, cfg: TelegramConfig) => Promise<unknown>
  log: (msg: string) => void
  /** Chờ có thể huỷ; test thay bằng hàm ghi lại thời gian chờ. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

/**
 * Vòng getUpdates. start() khi Telegram bật và có token; refresh() gọi khi settings đổi
 * (đổi token/chat → khởi động lại, tắt → dừng); stop() lúc server tắt.
 */
export function createTelegramPoller(deps: PollerDeps) {
  const sleep = deps.sleep ?? realSleep
  let ctrl: AbortController | undefined
  let loop: Promise<void> | undefined
  let key = ''

  async function run(cfg: TelegramConfig, signal: AbortSignal) {
    let backoff = 0
    while (!signal.aborted) {
      let updates: Update[]
      try {
        updates = await callTelegram<Update[]>(
          cfg.token,
          'getUpdates',
          { offset: deps.getOffset() || undefined, timeout: POLL_TIMEOUT_S, allowed_updates: ['callback_query'] },
          deps.fetchImpl,
          { timeoutMs: (POLL_TIMEOUT_S + 15) * 1000, signal },
        )
        backoff = 0
      } catch (e) {
        if (signal.aborted) return
        const status = e instanceof TelegramApiError ? e.status : 0
        if (status === 409) {
          deps.log(
            'Telegram: bot đang dùng webhook (HTTP 409) nên không thể nhận nút duyệt quyền bằng long polling. ' +
              'Hãy xoá webhook (deleteWebhook) rồi lưu lại cài đặt Telegram. Đã dừng nhận phản hồi.',
          )
          return
        }
        backoff = nextBackoff(backoff)
        deps.log(`Telegram getUpdates lỗi: ${(e as Error)?.message ?? e}. Thử lại sau ${backoff / 1000} giây`)
        await sleep(backoff, signal)
        continue
      }
      for (const u of Array.isArray(updates) ? updates : []) {
        if (signal.aborted) return
        // Ghi offset trước khi xử lý: một update lỗi không bị nhận lại mãi
        if (typeof u.update_id === 'number' && u.update_id + 1 > deps.getOffset()) deps.setOffset(u.update_id + 1)
        if (!u.callback_query) continue
        try {
          await deps.onCallback(u.callback_query, cfg)
        } catch (e) {
          deps.log(`Lỗi xử lý nút Telegram: ${(e as Error)?.message ?? e}`)
        }
      }
    }
  }

  function start() {
    const cfg = deps.getConfig()
    if (!cfg) return false
    key = `${cfg.token}|${cfg.chatId}`
    ctrl = new AbortController()
    const c = ctrl
    loop = run(cfg, c.signal).finally(() => {
      if (ctrl === c) ctrl = undefined
    })
    return true
  }

  async function stop() {
    ctrl?.abort()
    ctrl = undefined
    key = ''
    await loop?.catch(() => {})
    loop = undefined
  }

  /** Gọi khi settings đổi. Đang chạy đúng cấu hình thì giữ nguyên; khác cấu hình hoặc đã dừng (vd. sau 409) thì khởi động lại. */
  async function refresh() {
    const cfg = deps.getConfig()
    const next = cfg ? `${cfg.token}|${cfg.chatId}` : ''
    if (ctrl && next === key) return
    await stop()
    if (cfg) start()
  }

  return { start, stop, refresh, isRunning: () => !!ctrl, done: () => loop ?? Promise.resolve() }
}
