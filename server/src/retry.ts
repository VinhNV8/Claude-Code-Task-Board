// Retry task Failed (PLAN mục 2.7): lần chạy lại phải bắt đầu trên code sạch của mainBranch,
// không mang theo thay đổi dở dang (đã commit hay chưa) của lần chạy trước.
import { existsSync } from 'node:fs'
import { removeWorktree, resetWorktree } from './git.ts'
import type { Project, Task } from './types.ts'

/** Các cột của task cần cập nhật trước khi đưa lại vào hàng đợi. `null` = xoá giá trị. */
export interface RetryPatch {
  branch: string | null
  worktreePath: string | null
  /** Retry luôn dùng session mới, không resume phiên cũ. */
  sessionId: null
}

/**
 * Chuẩn bị worktree cho Retry:
 * - Task còn worktree: reset cứng nhánh task về mainBranch hiện tại + `git clean -fd`.
 * - Task không còn worktree (bị Reject, thư mục bị xoá): dọn nhánh còn sót (nếu có) và xoá branch/worktreePath
 *   khỏi task để startRun tạo worktree mới từ mainBranch.
 * Throw nếu không đưa được worktree về trạng thái sạch.
 */
export async function prepareRetry(task: Pick<Task, 'id' | 'branch' | 'worktreePath'>, project: Project): Promise<RetryPatch> {
  if (task.worktreePath && existsSync(task.worktreePath)) {
    const wt = await resetWorktree(project, task.id)
    return { branch: wt.branch, worktreePath: wt.path, sessionId: null }
  }
  // Nhánh claude/task-<id> có thể còn (thư mục worktree mất nhưng nhánh chưa xoá): xoá để worktree mới
  // không checkout lại commit cũ. Task chưa từng có worktree thì không đụng vào repo.
  if (task.branch || task.worktreePath) await removeWorktree(project, task.id)
  return { branch: null, worktreePath: null, sessionId: null }
}
