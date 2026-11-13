// Chế độ xác thực của Claude Code khi chạy task.
// - subscription: phiên đăng nhập Claude Code (gói Pro/Max) trên máy. Chỉ dành cho cá nhân tự dùng.
// - apiKey: API key của Claude Console, trả tiền theo token. Đây là cách được phép dùng trong sản phẩm.
// Key lấy từ biến môi trường TASKBOARD_ANTHROPIC_API_KEY (ưu tiên) hoặc key đã lưu (mã hoá) trong DB.
// Key không bao giờ trả ra API, không ghi vào log hay thông báo lỗi.
import Anthropic from '@anthropic-ai/sdk'
import type { ClaudeAuthInput, ClaudeAuthMode, ClaudeAuthSettings } from './types.ts'

export class ClaudeAuthError extends Error {}

export const AUTH_MODES: ClaudeAuthMode[] = ['subscription', 'apiKey']
export const ENV_API_KEY = 'TASKBOARD_ANTHROPIC_API_KEY'

/** Chế độ mặc định khi chưa lưu cài đặt. Bản thương mại đặt TASKBOARD_DEFAULT_AUTH_MODE=apiKey. */
export function defaultAuthMode(env: NodeJS.ProcessEnv = process.env): ClaudeAuthMode {
  return env.TASKBOARD_DEFAULT_AUTH_MODE?.trim() === 'apiKey' ? 'apiKey' : 'subscription'
}

const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,}$/

export function validateApiKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new ClaudeAuthError('API key không hợp lệ')
  const key = raw.trim()
  if (!KEY_RE.test(key)) throw new ClaudeAuthError('API key không đúng định dạng (dạng sk-ant-..., tạo trong Claude Console → API keys)')
  return key
}

export const keyHint = (key: string) => key.slice(-4)

/**
 * Gộp dữ liệu gửi lên với chế độ hiện tại.
 * apiKey trả về: undefined = giữ nguyên key đã lưu, null = xoá, chuỗi = lưu key mới (đã kiểm tra định dạng).
 */
export function mergeAuth(curMode: ClaudeAuthMode, input?: ClaudeAuthInput): { mode: ClaudeAuthMode; apiKey: string | null | undefined } {
  if (!input) return { mode: curMode, apiKey: undefined }
  let mode = curMode
  if (input.mode !== undefined) {
    if (!AUTH_MODES.includes(input.mode)) throw new ClaudeAuthError(`Chế độ xác thực không hợp lệ: ${String(input.mode)}`)
    mode = input.mode
  }
  let apiKey: string | null | undefined
  if (input.apiKey === null || (typeof input.apiKey === 'string' && !input.apiKey.trim())) apiKey = null
  else if (input.apiKey !== undefined) apiKey = validateApiKey(input.apiKey)
  return { mode, apiKey }
}

/** Key dùng thực tế: biến môi trường ưu tiên hơn key đã lưu. */
export function effectiveApiKey(stored: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[ENV_API_KEY]?.trim() || stored || undefined
}

/** Phần công khai gửi ra web (không chứa key). */
export function publicAuth(mode: ClaudeAuthMode, stored: string | undefined, env: NodeJS.ProcessEnv = process.env): ClaudeAuthSettings {
  const envKey = !!env[ENV_API_KEY]?.trim()
  const key = effectiveApiKey(stored, env)
  return { mode, hasApiKey: !!stored, envApiKey: envKey, ...(key ? { apiKeyHint: keyHint(key) } : {}) }
}

export type Credentials = { ok: true; apiKey?: string } | { ok: false; reason: string }

/** Thông tin xác thực cho một lần chạy. Chế độ API key mà chưa có key thì không chạy (không lặng lẽ dùng gói). */
export function resolveCredentials(mode: ClaudeAuthMode, apiKey: string | undefined): Credentials {
  if (mode === 'subscription') return { ok: true }
  if (!apiKey)
    return {
      ok: false,
      reason: `Đang dùng chế độ API key nhưng chưa có key. Vào Cài đặt → Xác thực Claude để nhập key, hoặc đặt biến môi trường ${ENV_API_KEY}.`,
    }
  return { ok: true, apiKey }
}

/** Gợi ý tiếng Việt cho các lỗi thường gặp ở chế độ API key (dò trên thông báo lỗi của CLI). */
export function authFailureHint(text: string | undefined): string | undefined {
  if (!text) return undefined
  if (/credit balance is too low/i.test(text)) return 'Tài khoản API đã hết credit. Nạp thêm trong Claude Console (Billing) rồi chạy lại.'
  if (/invalid (x-)?api[ -]?key|authentication_error/i.test(text))
    return 'API key không hợp lệ hoặc đã bị thu hồi. Kiểm tra lại trong Cài đặt → Xác thực Claude.'
  return undefined
}

/** Tạo client cho việc kiểm tra key; test thay bằng hàm giả để không gọi mạng. */
export type MakeClient = (apiKey: string) => Pick<Anthropic, 'models'>
const defaultClient: MakeClient = (apiKey) => new Anthropic({ apiKey, maxRetries: 0, timeout: 15_000 })

/**
 * Kiểm tra key bằng cách liệt kê model: không tốn token, không tốn tiền.
 * Chỉ xác nhận key hợp lệ, không kiểm tra số dư credit.
 */
export async function testApiKey(apiKey: string, makeClient: MakeClient = defaultClient): Promise<void> {
  try {
    await makeClient(apiKey).models.list({ limit: 1 })
  } catch (e) {
    // Thông báo lỗi tự viết, không dùng message của SDK, để chắc chắn không lộ key.
    if (e instanceof Anthropic.AuthenticationError) throw new ClaudeAuthError('API key không hợp lệ hoặc đã bị thu hồi')
    if (e instanceof Anthropic.PermissionDeniedError) throw new ClaudeAuthError('API key không có quyền truy cập API')
    if (e instanceof Anthropic.RateLimitError) return // key hợp lệ, chỉ đang bị giới hạn tốc độ
    if (e instanceof Anthropic.APIConnectionError) throw new ClaudeAuthError('Không kết nối được tới API của Anthropic. Kiểm tra mạng rồi thử lại.')
    if (e instanceof Anthropic.APIError) throw new ClaudeAuthError(`API của Anthropic trả lỗi ${e.status ?? 'không xác định'}`)
    throw new ClaudeAuthError('Kiểm tra API key thất bại')
  }
}
