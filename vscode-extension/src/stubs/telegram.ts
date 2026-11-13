// Bản thay thế server/src/telegram.ts khi build extension với --no-telegram:
// không có mã gọi Telegram Bot API trong bundle. Telegram luôn tắt, gửi thử báo lỗi.
import type { Settings, Task, TelegramSettings, TelegramSettingsInput } from '../../../server/src/types.ts'

export class TelegramError extends Error {}

export interface TelegramConfig {
  token: string
  chatId: string
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

const UNSUPPORTED = 'Thông báo Telegram không có trong bản VS Code extension'

export const DEFAULT_TELEGRAM: TelegramSettings = { enabled: false, chatId: '', appUrl: '', hasToken: false }

const unsupported = (): never => {
  throw new TelegramError(UNSUPPORTED)
}
export const validateToken = (_raw: unknown): string => unsupported()
export const validateChatId = (_raw: unknown): string => unsupported()
export const validateAppUrl = (_raw: unknown): string => unsupported()

export function mergeTelegram(
  cur: TelegramSettings,
  input: TelegramSettingsInput | undefined,
): { telegram: Omit<TelegramSettings, 'hasToken'>; token: string | null | undefined } {
  if (input?.enabled === true || (typeof input?.botToken === 'string' && input.botToken.trim())) unsupported()
  return { telegram: { enabled: false, chatId: cur.chatId, appUrl: cur.appUrl }, token: undefined }
}

export async function sendTelegram(_cfg: TelegramConfig, _text: string): Promise<void> {
  unsupported()
}

export function createTelegramNotifier(_deps: {
  initial: Pick<Task, 'id' | 'status'>[]
  getSettings: () => Settings
  [k: string]: unknown
}) {
  return (_m: { type: string }): Promise<void> | undefined => undefined
}
