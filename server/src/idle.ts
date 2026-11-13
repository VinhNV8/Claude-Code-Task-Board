// Tự tắt server khi rảnh (bản đóng gói trong extension VS Code).
// Server chạy tách khỏi cửa sổ VS Code để task vẫn chạy khi đóng cửa sổ; khi không còn giao diện nào mở
// và không còn việc gì đang chạy/chờ chạy/lên lịch thì tự tắt sau TASKBOARD_IDLE_EXIT_MIN phút.
// Không đặt biến này (chạy bằng npm): không bao giờ tự tắt.

export interface IdleState {
  /** Số giao diện đang kết nối WebSocket. */
  clients: number
  /** Có task đang chạy, chờ duyệt, xếp hàng, đang chạy test, hoặc có lịch cron đang bật. */
  busy: boolean
}

/** Số phút rảnh trước khi tắt; undefined: tắt tính năng. */
export function idleExitMinutes(env: NodeJS.ProcessEnv = process.env) {
  const n = Number(env.TASKBOARD_IDLE_EXIT_MIN)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Bộ đếm rảnh: gọi tick() định kỳ; trả true khi đã rảnh liên tục đủ `limitMs`.
 * Có giao diện mở hoặc có việc thì đặt lại mốc.
 */
export function createIdleTracker(limitMs: number, now: () => number = Date.now) {
  let idleSince: number | undefined
  return {
    tick(s: IdleState) {
      if (s.clients > 0 || s.busy) {
        idleSince = undefined
        return false
      }
      idleSince ??= now()
      return now() - idleSince >= limitMs
    },
  }
}

/** Kiểm tra mỗi phút; khi đủ thời gian rảnh thì gọi onIdle (một lần). */
export function startIdleExit(o: { minutes: number; state: () => IdleState; onIdle: () => void; intervalMs?: number }) {
  const tracker = createIdleTracker(o.minutes * 60_000)
  const timer = setInterval(() => {
    if (!tracker.tick(o.state())) return
    clearInterval(timer)
    o.onIdle()
  }, o.intervalMs ?? 60_000)
  timer.unref()
  return () => clearInterval(timer)
}
