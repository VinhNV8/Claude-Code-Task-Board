// Resume (Tiếp tục) task bị gián đoạn: khác với Retry (Chạy lại), Resume giữ nguyên worktree đang làm dở
// và chạy tiếp đúng phiên Claude cũ (`--resume <sessionId>`). Dùng chung cho server và giao diện.
import type { Task } from '../types.ts'

/** failReason khi người dùng bấm Tạm dừng (Dừng) một task đang chạy. */
export const STOP_REASON = 'Đã dừng bởi người dùng'

/** Prompt gửi cho Claude khi chạy tiếp đúng phiên cũ (Claude đã nhớ yêu cầu và những gì đã làm). */
export const CONTINUE_PROMPT =
  'Phiên làm việc trước đã bị gián đoạn (tạm dừng, hết giới hạn sử dụng hoặc lỗi). ' +
  'Hãy kiểm tra lại trạng thái hiện tại của các file trong thư mục làm việc rồi tiếp tục hoàn thành yêu cầu ban đầu từ chỗ đang dở. ' +
  'Không làm lại những phần đã xong.'

/** Ghi chú kèm prompt gốc khi không còn phiên cũ để resume (phiên mới, nhưng worktree vẫn còn thay đổi dở dang). */
export const CONTINUE_NOTE =
  'Lưu ý: đây là lần chạy tiếp sau khi bị gián đoạn. Thư mục làm việc có thể đã chứa một phần thay đổi từ lần chạy trước; ' +
  'hãy kiểm tra và tiếp tục từ đó thay vì làm lại từ đầu.'

/** Task Queued đang chờ giờ reset của gói do gặp giới hạn sử dụng. */
export function isWaitingRateLimit(task: Pick<Task, 'status' | 'notBefore'>, now = Date.now()): boolean {
  return task.status === 'queued' && !!task.notBefore && task.notBefore > now
}

/**
 * Lý do task không Tiếp tục được (hiển thị cho người dùng); `undefined` nếu được.
 * - Failed (tạm dừng, lỗi, hết lượt tự thử lại do giới hạn sử dụng, server khởi động lại): cần còn worktree.
 * - Queued đang chờ giới hạn sử dụng: Tiếp tục = chạy ngay, không chờ tới giờ reset.
 */
export function resumeBlocker(task: Pick<Task, 'status' | 'worktreePath' | 'notBefore'>, now = Date.now()): string | undefined {
  if (isWaitingRateLimit(task, now)) return undefined
  if (task.status !== 'failed') return 'Chỉ tiếp tục được task đã tạm dừng, thất bại hoặc đang chờ giới hạn sử dụng'
  if (!task.worktreePath) return 'Task không còn worktree của lần chạy trước, hãy dùng Chạy lại'
  return undefined
}

export const canResume = (task: Pick<Task, 'status' | 'worktreePath' | 'notBefore'>, now = Date.now()) =>
  resumeBlocker(task, now) === undefined
