// Thông báo qua Telegram (PLAN 4.5, FR-51).
// Phần logic thuần (kiểm tra cấu hình, soạn tin, gửi qua Bot API, phát hiện chuyển trạng thái) không phụ thuộc DB để dễ test.
import type { Settings, Task, TaskStatus, TelegramSettings, TelegramSettingsInput } from './types.ts'

export class TelegramError extends Error {}

export interface TelegramConfig {
  token: string
  chatId: string
}

export const DEFAULT_TELEGRAM: TelegramSettings = { enabled: false, chatId: '', appUrl: '', hasToken: false }

const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/
const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/

export function validateToken(raw: unknown): string {
  if (typeof raw !== 'string') throw new TelegramError('Bot token không hợp lệ')
  const t = raw.trim()
  if (!TOKEN_RE.test(t)) throw new TelegramError('Bot token không đúng định dạng (dạng 123456789:ABC..., lấy từ @BotFather)')
  return t
}

export function validateChatId(raw: unknown): string {
  if (typeof raw !== 'string') throw new TelegramError('Chat ID không hợp lệ')
  const c = raw.trim()
  if (c && !CHAT_RE.test(c)) throw new TelegramError('Chat ID phải là số (ví dụ 123456789 hoặc -100123...) hoặc @tenkenh')
  return c
}

export function validateAppUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new TelegramError('Địa chỉ giao diện không hợp lệ')
  const u = raw.trim().replace(/\/+$/, '')
  if (!u) return ''
  let url: URL
  try {
    url = new URL(u)
  } catch {
    throw new TelegramError('Địa chỉ giao diện phải là URL đầy đủ, ví dụ http://127.0.0.1:3000')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TelegramError('Địa chỉ giao diện phải bắt đầu bằng http:// hoặc https://')
  return u
}

/**
 * Gộp cấu hình mới vào cấu hình hiện tại.
 * Trả về phần công khai (lưu cùng Settings) và token mới: undefined = giữ nguyên, null = xoá.
 */
export function mergeTelegram(
  cur: TelegramSettings,
  input: TelegramSettingsInput | undefined,
): { telegram: Omit<TelegramSettings, 'hasToken'>; token: string | null | undefined } {
  const b = input ?? {}
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') throw new TelegramError('Giá trị bật/tắt Telegram không hợp lệ')
  let token: string | null | undefined
  if (b.botToken === null || (typeof b.botToken === 'string' && !b.botToken.trim())) token = null
  else if (b.botToken !== undefined) token = validateToken(b.botToken)
  return {
    telegram: {
      enabled: b.enabled ?? cur.enabled,
      chatId: b.chatId !== undefined ? validateChatId(b.chatId) : cur.chatId,
      appUrl: b.appUrl !== undefined ? validateAppUrl(b.appUrl) : cur.appUrl,
    },
    token,
  }
}

// ---------------------------------------------------------------- soạn tin

const NOTIFY_KEY: Partial<Record<TaskStatus, keyof Settings['notifyOn']>> = {
  review: 'review',
  needs_input: 'needsInput',
  failed: 'failed',
}

/** Chỉ báo khi trạng thái thực sự đổi sang Review / Needs Input / Failed và loại đó được bật trong notifyOn. */
export function shouldNotify(prev: TaskStatus | undefined, next: TaskStatus, notifyOn: Settings['notifyOn']): boolean {
  if (prev === next) return false
  const key = NOTIFY_KEY[next]
  return !!key && notifyOn[key]
}

export function taskLink(appUrl: string, taskId: number) {
  return appUrl ? `${appUrl.replace(/\/+$/, '')}/tasks/${taskId}` : ''
}

export function formatTaskMessage(task: Pick<Task, 'id' | 'title' | 'status' | 'failReason'>, opts: { projectName?: string; appUrl: string }) {
  const head =
    task.status === 'review'
      ? `✅ Cần review: #${task.id}`
      : task.status === 'needs_input'
        ? `✋ Claude cần bạn: #${task.id}`
        : `❌ Task lỗi: #${task.id}`
  const lines = [head, task.title]
  if (opts.projectName) lines.push(`Project: ${opts.projectName}`)
  if (task.status === 'failed' && task.failReason) lines.push(`Lý do: ${task.failReason.slice(0, 500)}`)
  const link = taskLink(opts.appUrl, task.id)
  if (link) lines.push('', `Mở task: ${link}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- gửi

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

/** Gửi tin qua Bot API. Lỗi ném TelegramError với thông báo tiếng Việt, không bao giờ chứa token. */
export async function sendTelegram(cfg: TelegramConfig, text: string, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = 10_000) {
  if (!cfg.token) throw new TelegramError('Chưa nhập bot token')
  if (!cfg.chatId) throw new TelegramError('Chưa nhập chat ID')
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await fetchImpl(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    const name = (e as Error)?.name
    throw new TelegramError(name === 'TimeoutError' || name === 'AbortError' ? 'Telegram không phản hồi (quá thời gian chờ)' : 'Không kết nối được tới Telegram')
  }
  if (res.ok) return
  const data = (await res.json().catch(() => ({}))) as { description?: string }
  const desc = typeof data.description === 'string' ? data.description.replaceAll(cfg.token, '***').slice(0, 200) : ''
  if (res.status === 401 || res.status === 404) throw new TelegramError('Bot token không hợp lệ hoặc đã bị thu hồi')
  if (res.status === 400 && /chat not found/i.test(desc)) throw new TelegramError('Không tìm thấy chat. Hãy nhắn /start cho bot (hoặc thêm bot vào nhóm) rồi kiểm tra lại chat ID')
  if (res.status === 403) throw new TelegramError('Bot không được phép gửi tin vào chat này (bị chặn hoặc chưa được thêm vào nhóm)')
  if (res.status === 429) throw new TelegramError('Telegram đang giới hạn tần suất gửi, hãy thử lại sau')
  throw new TelegramError(`Telegram từ chối gửi tin (HTTP ${res.status}${desc ? `: ${desc}` : ''})`)
}

// ---------------------------------------------------------------- theo dõi chuyển trạng thái

export interface NotifierDeps {
  /** Trạng thái hiện có lúc khởi động, để không báo lại các task đang ở sẵn Review/Failed. */
  initial: Pick<Task, 'id' | 'status'>[]
  getSettings: () => Settings
  getToken: () => string | undefined
  projectName: (projectId: string) => string | undefined
  send: (cfg: TelegramConfig, text: string) => Promise<void>
  log: (msg: string) => void
}

/**
 * Tạo bộ xử lý tin nhắn bus: nhận mọi cập nhật task, gửi Telegram khi chuyển sang trạng thái cần báo.
 * Không bao giờ ném lỗi ra ngoài (lỗi gửi chỉ ghi log), không chờ gửi xong.
 */
export function createTelegramNotifier(deps: NotifierDeps) {
  const last = new Map<number, TaskStatus>(deps.initial.map((t) => [t.id, t.status]))
  return (m: { type: string; task?: Task; id?: unknown }): Promise<void> | undefined => {
    try {
      if (m.type === 'task_deleted' && typeof m.id === 'number') {
        last.delete(m.id)
        return
      }
      if (m.type !== 'task' || !m.task) return
      const task = m.task
      const prev = last.get(task.id)
      last.set(task.id, task.status)
      const s = deps.getSettings()
      const tg = s.telegram
      if (!tg?.enabled || !tg.chatId) return
      if (!shouldNotify(prev, task.status, s.notifyOn)) return
      const token = deps.getToken()
      if (!token) return
      const text = formatTaskMessage(task, { projectName: deps.projectName(task.projectId), appUrl: tg.appUrl })
      return deps.send({ token, chatId: tg.chatId }, text).catch((e) => {
        deps.log(`Gửi Telegram cho task #${task.id} thất bại: ${e instanceof TelegramError ? e.message : 'lỗi không xác định'}`)
      })
    } catch (e) {
      deps.log(`Lỗi xử lý thông báo Telegram: ${(e as Error)?.message ?? e}`)
      return
    }
  }
}
