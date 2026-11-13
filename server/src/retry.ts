// Retry task Failed (PLAN mục 2.7): lần chạy lại phải bắt đầu trên code sạch của mainBranch,
// không mang theo thay đổi dở dang (đã commit hay chưa) của lần chạy trước.
import { existsSync } from 'node:fs'
import { broadcast } from './bus.ts'
import { projects, tasks } from './db.ts'
import { removeWorktree, resetWorktree } from './git.ts'
import { ReviewError, withLock } from './review.ts'
import { isTesting, stopTests } from './testRunner.ts'
import type { Project, Task } from './types.ts'

/** Các cột của task cần cập nhật trước khi đưa lại vào hàng đợi. `null` = xoá giá trị. */
export interface RetryPatch {
  branch: string | null
  worktreePath: string | null
  /** Retry luôn dùng session mới, không resume phiên cũ. */
  sessionId: null
  /** Mode direct: bỏ snapshot "sau" của run cũ (diff tính lại khi run mới xong). */
  headRef?: null
}

/**
 * Chuẩn bị worktree cho Retry:
 * - Task còn worktree: reset cứng nhánh task về mainBranch hiện tại + `git clean -fd`.
 * - Task không còn worktree (bị Reject, thư mục bị xoá): dọn nhánh còn sót (nếu có) và xoá branch/worktreePath
 *   khỏi task để startRun tạo worktree mới từ mainBranch.
 * Throw nếu không đưa được worktree về trạng thái sạch.
 */
export async function prepareRetry(
  task: Pick<Task, 'id' | 'branch' | 'worktreePath' | 'baseRef'>,
  project: Pick<Project, 'id' | 'repoPath' | 'mainBranch'>,
): Promise<RetryPatch> {
  // Mode direct: Claude làm thẳng trong thư mục của người dùng, KHÔNG reset/xoá file ở đó.
  // Giữ snapshot gốc (baseRef) để diff khi review vẫn là toàn bộ thay đổi so với trước khi giao task.
  if (task.baseRef) return { branch: null, worktreePath: task.worktreePath ?? null, sessionId: null, headRef: null }
  if (task.worktreePath && existsSync(task.worktreePath)) {
    const wt = await resetWorktree(project, task.id)
    return { branch: wt.branch, worktreePath: wt.path, sessionId: null }
  }
  // Nhánh claude/task-<id> có thể còn (thư mục worktree mất nhưng nhánh chưa xoá): xoá để worktree mới
  // không checkout lại commit cũ. Task chưa từng có worktree thì không đụng vào repo.
  if (task.branch || task.worktreePath) await removeWorktree(project, task.id)
  return { branch: null, worktreePath: null, sessionId: null }
}

/**
 * POST /api/tasks/:id/retry: đưa worktree về code sạch rồi đưa task Failed về Queued.
 * pump() sẽ tạo run `kind='retry'` với session mới (task đã có run trước đó, không có pendingFeedback).
 * Chạy trong khoá của project: bấm Retry 2 lần liên tiếp thì lần sau thấy task đã Queued → 409,
 * không reset đè lên worktree của run vừa bắt đầu.
 */
export async function retryTask(taskId: number, deps: { pump: () => void }): Promise<Task> {
  const first = tasks.get(taskId)
  if (!first) throw new ReviewError(404, `Không tìm thấy task #${taskId}`)
  return withLock(first.projectId, async () => {
    const task = tasks.get(taskId)
    if (!task) throw new ReviewError(404, `Không tìm thấy task #${taskId}`)
    if (task.status !== 'failed') throw new ReviewError(409, 'Chỉ chạy lại task ở Failed')
    const project = projects.get(task.projectId)
    if (!project) throw new ReviewError(404, `Không tìm thấy project của task #${taskId}`)

    if (isTesting(taskId)) await stopTests(taskId, 'Đã dừng vì task được chạy lại.')
    let patch: RetryPatch
    try {
      patch = await prepareRetry(task, project)
    } catch (err) {
      throw new ReviewError(500, `Không đưa được worktree về nhánh "${project.mainBranch}": ${(err as Error).message}`)
    }
    // Retry luôn là phiên mới, không mang feedback "Yêu cầu sửa" còn sót.
    const queued = tasks.patch(taskId, {
      ...patch,
      status: 'queued',
      failReason: null,
      reviewWarning: null,
      pendingFeedback: null,
      resumeNext: null,
      notBefore: null,
      rateLimitRetries: 0,
    })!
    broadcast({ type: 'task', task: queued })
    deps.pump()
    return queued
  })
}
