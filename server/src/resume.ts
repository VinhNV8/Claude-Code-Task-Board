// Resume (Tiếp tục) task bị gián đoạn: tạm dừng, lỗi, hết giới hạn sử dụng, server khởi động lại.
// Khác Retry (retry.ts): KHÔNG reset worktree, giữ nguyên thay đổi dở dang và chạy tiếp đúng phiên Claude cũ
// (`--resume <sessionId>`, run kind 'continue'). Mất phiên thì runner tự chạy tiếp trên phiên mới kèm prompt gốc.
import { existsSync } from 'node:fs'
import { broadcast } from './bus.ts'
import { projects, tasks } from './db.ts'
import { ReviewError, withLock } from './review.ts'
import { isTesting, stopTests } from './testRunner.ts'
import { isWaitingRateLimit, resumeBlocker } from '../../web/src/lib/resume.ts'
import type { Project, Task } from './types.ts'

/** Phụ thuộc vào runner, tách ra để test thay bằng bản giả (không spawn Claude thật). */
export interface ResumeDeps {
  hasSlot: (project: Project) => boolean
  startRun: (task: Task, kind: 'continue') => void
  pump: () => void
}

export interface ResumeResult {
  task: Task
  /** true: đã bắt đầu chạy ngay; false: đã vào hàng đợi, chạy tiếp khi có slot. */
  started: boolean
}

function patchTask(id: number, patch: Parameters<typeof tasks.patch>[1]) {
  const t = tasks.patch(id, patch)!
  broadcast({ type: 'task', task: t })
  return t
}

/**
 * POST /api/tasks/:id/resume
 * - Task Queued đang chờ giới hạn sử dụng: bỏ giờ chờ, chạy ngay khi có slot (giữ ý định resume/continue đã lưu).
 * - Task Failed còn worktree: còn slot → chạy 'continue' ngay; hết slot → Queued với resumeNext để pump() chạy tiếp.
 * Chạy trong khoá của project (chung với Retry/Review): bấm 2 lần liên tiếp thì lần sau nhận 409.
 */
export async function resumeTask(taskId: number, deps: ResumeDeps): Promise<ResumeResult> {
  const first = tasks.get(taskId)
  if (!first) throw new ReviewError(404, `Không tìm thấy task #${taskId}`)
  return withLock(first.projectId, async () => {
    const task = tasks.get(taskId)
    if (!task) throw new ReviewError(404, `Không tìm thấy task #${taskId}`)
    const blocker = resumeBlocker(task)
    if (blocker) throw new ReviewError(409, blocker)
    const project = projects.get(task.projectId)
    if (!project) throw new ReviewError(404, `Không tìm thấy project của task #${taskId}`)

    if (isWaitingRateLimit(task)) {
      // Người dùng chủ động không chờ: bộ đếm tự thử lại về 0, pump() lấy ra chạy theo đúng loại run đã lưu.
      patchTask(taskId, { notBefore: null, rateLimitRetries: 0 })
      deps.pump()
      const now = tasks.get(taskId)!
      return { task: now, started: now.status === 'running' }
    }

    if (!existsSync(task.worktreePath!))
      throw new ReviewError(409, 'Thư mục worktree của task không còn, không thể tiếp tục. Hãy dùng Chạy lại.')
    if (isTesting(taskId)) await stopTests(taskId, 'Đã dừng vì task được tiếp tục.')

    if (deps.hasSlot(project)) {
      // startRun chuyển Running, xoá failReason/notBefore/resumeNext và tạo run 'continue' trên phiên cũ.
      // Người dùng chủ động tiếp tục: bộ đếm tự thử lại do giới hạn sử dụng về 0 (startRun sẽ broadcast task).
      if (task.rateLimitRetries) tasks.patch(taskId, { rateLimitRetries: 0 })
      deps.startRun(tasks.get(taskId)!, 'continue')
      return { task: tasks.get(taskId)!, started: true }
    }
    const queued = patchTask(taskId, {
      status: 'queued',
      resumeNext: true,
      failReason: null,
      reviewWarning: null,
      notBefore: null,
      rateLimitRetries: 0,
    })
    deps.pump()
    return { task: tasks.get(taskId) ?? queued, started: false }
  })
}
