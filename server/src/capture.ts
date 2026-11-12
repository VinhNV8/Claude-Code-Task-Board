// Review flow (PLAN 2.1, 2.2): chuẩn bị worktree trước khi chạy và chụp thay đổi sau khi run thành công.
import { existsSync } from 'node:fs'
import { commitAll, commitsAhead, createWorktree, removeWorktree, type Worktree } from './git.ts'
import type { Project, Task } from './types.ts'

type WtProject = Pick<Project, 'id' | 'repoPath' | 'mainBranch'>

/**
 * Worktree để Claude làm việc. Task chưa có worktree (hoặc thư mục đã mất) thì tạo mới
 * (tái sử dụng nhánh claude/task-<id> nếu còn). Trả `created = true` khi cần lưu lại branch/worktreePath.
 */
export async function ensureWorktree(
  task: Pick<Task, 'id' | 'branch' | 'worktreePath'>,
  project: WtProject,
): Promise<Worktree & { created: boolean }> {
  if (task.worktreePath && task.branch && existsSync(task.worktreePath))
    return { branch: task.branch, path: task.worktreePath, created: false }
  const wt = await createWorktree(project, task.id)
  return { ...wt, created: true }
}

export const commitMessage = (task: Pick<Task, 'id' | 'title'>, runNo: number) => `task #${task.id}: ${task.title} (run ${runNo})`

/** Số thứ tự (bắt đầu từ 1) của run trong danh sách run của task (đã sắp theo started_at). */
export function runNumber(taskRuns: { id: string }[], runId: string) {
  const i = taskRuns.findIndex((r) => r.id === runId)
  return i < 0 ? taskRuns.length + 1 : i + 1
}

/**
 * Commit mọi thay đổi trong worktree. Nhánh task có commit so với mainBranch (do mình commit hoặc
 * Claude tự commit) → 'review'. Không có gì → 'done' và dọn worktree + nhánh.
 */
export async function captureChanges(
  task: Pick<Task, 'id' | 'title'> & { worktreePath: string },
  project: WtProject,
  runNo: number,
): Promise<'review' | 'done'> {
  const committed = await commitAll(task.worktreePath, commitMessage(task, runNo))
  if (committed || (await commitsAhead(task.worktreePath, project.mainBranch)) > 0) return 'review'
  await removeWorktree(project, task.id)
  return 'done'
}
