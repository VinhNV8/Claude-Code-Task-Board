// Review flow (PLAN 2.1, 2.2): chuẩn bị worktree trước khi chạy và chụp thay đổi sau khi run thành công.
import { existsSync } from 'node:fs'
import { commitAll, commitsAhead, createWorktree, snapshotTree } from './git.ts'
import type { Project, Task } from './types.ts'

type WtProject = Pick<Project, 'id' | 'repoPath' | 'mainBranch'> & { deliveryMode?: Project['deliveryMode'] }

/**
 * Mode giao output của một task, chốt ở lần chạy đầu tiên: task đã có snapshot (baseRef) là direct,
 * đã có nhánh là worktree; chưa chạy lần nào thì theo cấu hình hiện tại của project.
 * Nhờ vậy đổi mode của project không làm hỏng task đang dở.
 */
export function taskMode(task: Pick<Task, 'branch' | 'baseRef'>, project: { deliveryMode?: Project['deliveryMode'] }): Project['deliveryMode'] {
  if (task.baseRef) return 'direct'
  if (task.branch) return 'worktree'
  return project.deliveryMode === 'direct' ? 'direct' : 'worktree'
}

export interface Workspace {
  /** Nhánh claude/task-<id> (mode worktree); null ở mode direct */
  branch: string | null
  /** Thư mục Claude làm việc */
  path: string
  /** Mode direct: snapshot thư mục project trước run đầu tiên */
  baseRef?: string
  /** true khi cần lưu branch/worktreePath/baseRef vào task */
  created: boolean
}

/**
 * Worktree để Claude làm việc. Task chưa có worktree (hoặc thư mục đã mất) thì tạo mới
 * (tái sử dụng nhánh claude/task-<id> nếu còn). Trả `created = true` khi cần lưu lại branch/worktreePath.
 */
export async function ensureWorktree(
  task: Pick<Task, 'id' | 'branch' | 'worktreePath' | 'baseRef'>,
  project: WtProject,
): Promise<Workspace> {
  if (taskMode(task, project) === 'direct') {
    // Mode direct: Claude làm thẳng trong thư mục project. Chụp snapshot một lần (trước run đầu tiên)
    // để diff khi review luôn là toàn bộ thay đổi của task qua mọi lần chạy.
    if (!existsSync(project.repoPath)) throw new Error(`Không tìm thấy thư mục project: ${project.repoPath}`)
    if (task.baseRef && task.worktreePath) return { branch: null, path: task.worktreePath, baseRef: task.baseRef, created: false }
    const baseRef = task.baseRef ?? (await snapshotTree(project))
    return { branch: null, path: project.repoPath, baseRef, created: true }
  }
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
 * Commit mọi thay đổi trong worktree. Mọi run thành công đều lên Review để người dùng duyệt output (G3),
 * kể cả khi Claude không sửa file nào (task phân tích, trả lời câu hỏi...). Worktree được giữ lại để
 * "Request changes" chạy tiếp đúng phiên Claude trong cùng thư mục. Trả về nhánh task có thay đổi so với
 * mainBranch hay không (do mình commit hoặc Claude tự commit).
 */
export async function captureChanges(
  task: Pick<Task, 'id' | 'title' | 'baseRef'> & { worktreePath: string },
  project: WtProject,
  runNo: number,
): Promise<{ hasChanges: boolean; headRef?: string }> {
  // Mode direct: không commit gì vào repo của người dùng; chụp snapshot "sau" để review.
  if (task.baseRef) {
    const headRef = await snapshotTree(project)
    return { hasChanges: headRef !== task.baseRef, headRef }
  }
  const committed = await commitAll(task.worktreePath, commitMessage(task, runNo))
  return { hasChanges: committed || (await commitsAhead(task.worktreePath, project.mainBranch)) > 0 }
}
