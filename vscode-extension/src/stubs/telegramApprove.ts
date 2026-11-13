// Bản thay thế server/src/telegramApprove.ts khi build extension với --no-telegram:
// không gửi tin duyệt quyền, không chạy long polling.
import type { Settings } from '../../../server/src/types.ts'
import type { TelegramConfig } from './telegram.ts'

export function activeConfig(_s: Settings, _token: string | undefined): TelegramConfig | undefined {
  return undefined
}

export function createTelegramApprover(_deps: unknown) {
  return {
    onMessage: (_m: { type: string }): Promise<void> | undefined => undefined,
    handleCallback: async (_cq: unknown, _cfg: TelegramConfig) => {},
    sent: new Map<string, unknown>(),
  }
}

export function createTelegramPoller(_deps: unknown) {
  return {
    start: () => false,
    stop: async () => {},
    refresh: async () => {},
    isRunning: () => false,
    done: () => Promise.resolve(),
  }
}
