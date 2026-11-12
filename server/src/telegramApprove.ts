// Duyệt quyền qua Telegram (P7-03, FR-46): tin nhắn kèm nút inline + long polling getUpdates.
// Chỉ mở rộng luồng duyệt có sẵn (permissions.ts): quyết định vẫn đi qua decidePermission.
// Mọi phụ thuộc (fetch, DB, đồng hồ, sleep) truyền vào để test không cần mạng/DB.
import type { PermissionRequest, Settings, Task } from './types.ts'
import { taskLink, type FetchLike, type TelegramConfig } from './telegram.ts'

type Action = 'allow' | 'always' | 'deny'
const ACTIONS: Action[] = ['allow', 'always', 'deny']

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

export const callbackData = (requestId: string, action: Action) => `perm:${requestId}:${action}`

export function parseCallbackData(data: unknown): { id: string; action: Action } | undefined {
  if (typeof data !== 'string') return
  const m = /^perm:(.+):(allow|always|deny)$/.exec(data)
  return m ? { id: m[1], action: m[2] as Action } : undefined
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
export function outsideResultLine(status: PermissionRequest['status'], at: number) {
  if (status === 'timeout') return `⌛ Hết thời gian, đã tự từ chối lúc ${hhmm(at)}`
  return `🖥 Đã xử lý trên web lúc ${hhmm(at)} (${status === 'allowed' ? 'cho phép' : 'từ chối'})`
}

// ---------------------------------------------------------------- gửi và sửa tin theo bus

interface SentMessage {
  chatId: string
  messageId: number
  text: string
}

export interface ApproveDeps {
  fetchImpl: FetchLike
  getSettings: () => Settings
  getToken: () => string | undefined
  getTask: (id: number) => Pick<Task, 'id' | 'title' | 'projectId'> | undefined
  projectName: (projectId: string) => string | undefined
  /** decidePermission của permissions.ts; ném lỗi có statusCode khi không hợp lệ */
  decide: (id: string, decision: Action) => unknown
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
        reply_markup: permissionKeyboard(req),
      }) as { message_id: number; chat?: { id: number } }
      sent.set(req.id, { chatId: cfg.chatId, messageId: msg.message_id, text })
    } catch (e) {
      deps.log(`Gửi Telegram duyệt quyền cho task #${req.taskId} thất bại: ${(e as Error)?.message ?? e}`)
    }
  }

  /** Bộ nghe bus: yêu cầu pending mới → gửi tin có nút; yêu cầu được chốt ngoài Telegram → sửa tin, bỏ nút. */
  function onMessage(m: { type: string; permission?: PermissionRequest }): Promise<void> | undefined {
    if (m.type !== 'permission' || !m.permission) return
    const req = m.permission
    try {
      if (req.status === 'pending') {
        if (announced.has(req.id)) return
        return announce(req)
      }
      announced.delete(req.id)
      const msg = sent.get(req.id)
      if (!msg) return
      sent.delete(req.id)
      const token = deps.getToken()
      if (!token) return
      return edit(token, msg, outsideResultLine(req.status, deps.now()))
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
    const parsed = parseCallbackData(cq.data)
    if (!parsed) return answer('Nút không hợp lệ')

    const m = cq.message!
    const msg: SentMessage = sent.get(parsed.id) ?? { chatId: String(m.chat.id), messageId: m.message_id, text: m.text ?? '' }
    // Xoá trước khi quyết định: settle() phát bus đồng bộ, không để onMessage sửa thành "trên web"
    sent.delete(parsed.id)
    try {
      deps.decide(parsed.id, parsed.action)
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
    const line = `${RESULT[parsed.action]} lúc ${hhmm(deps.now())}`
    await answer(RESULT[parsed.action])
    await edit(cfg.token, msg, line)
  }

  return { onMessage, handleCallback, sent }
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
