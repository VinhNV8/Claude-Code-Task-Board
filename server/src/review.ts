// Approve & Merge (PLAN 2.4) và lịch sử review (PLAN 2.8).
// Merge nhánh claude/task-<id> vào nhánh chính của repo; mỗi project chỉ một lệnh merge chạy tại một thời điểm.
import { broadcast } from './bus.ts'
import { projects, reviews, tasks } from './db.ts'
import { git, mainRepoStatus, mergeBranch, removeWorktree, taskBranch } from './git.ts'
import { isTesting, stopTests } from './testRunner.ts'
import { MIN_FEEDBACK } from '../../web/src/lib/review.ts'
import type { Project, ReviewAction, Task } from './types.ts'

/** Lỗi có mã HTTP (Fastify dùng `statusCode`). */
export class ReviewError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------- khoá theo project

const locks = new Map<string, Promise<unknown>>()

/** Chạy `fn` tuần tự với các lệnh khác cùng `key`: lệnh sau chờ lệnh trước xong (dù thành công hay lỗi). */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.catch(() => {})
  locks.set(key, tail)
  // Dọn khoá khi không còn ai xếp hàng sau
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })
  return next
}

// ---------------------------------------------------------------- thông báo

/** Liệt kê tối đa `max` mục, phần còn lại ghi "và N file khác". */
export function listFiles(files: string[], max = 5) {
  const shown = files.slice(0, max).join(', ')
  return files.length > max ? `${shown} và ${files.length - max} file khác` : shown
}

/** Lý do repo chính chưa sẵn sàng để merge; `undefined` nếu đã sẵn sàng. */
export function repoNotReadyWarning(st: { branch: string; changes: string[] }, mainBranch: string): string | undefined {
  const parts: string[] = []
  if (st.branch !== mainBranch) {
    parts.push(
      st.branch === 'HEAD'
        ? `Repo chính đang ở trạng thái detached HEAD, cần checkout nhánh "${mainBranch}"`
        : `Repo chính đang ở nhánh "${st.branch}", cần chuyển về nhánh "${mainBranch}"`,
    )
  }
  if (st.changes.length)
    parts.push(`Repo chính có ${st.changes.length} file chưa commit: ${listFiles(st.changes)}. Hãy commit hoặc stash`)
  return parts.length ? `${parts.join('. ')} trước khi merge.` : undefined
}

export function conflictWarning(conflicts: string[], mainBranch: string) {
  const files = conflicts.length ? ` ở ${conflicts.length} file: ${listFiles(conflicts)}` : ''
  return (
    `Merge vào "${mainBranch}" bị conflict${files}. Đã huỷ merge, repo chính giữ nguyên. ` +
    'Hãy yêu cầu Claude sửa lại trên nhánh task hoặc tự xử lý conflict rồi duyệt lại.'
  )
}

export const mergeMessage = (task: Pick<Task, 'id' | 'title'>) => `Merge task #${task.id}: ${task.title}`

// ---------------------------------------------------------------- approve

function patchTask(id: number, patch: Parameters<typeof tasks.patch>[1]) {
  const t = tasks.patch(id, patch)
  if (t) broadcast({ type: 'task', task: t })
  return t
}

/** Đặt cảnh báo cho task rồi báo lỗi 409 với cùng nội dung. */
function blocked(taskId: number, warning: string): never {
  patchTask(taskId, { reviewWarning: warning })
  throw new ReviewError(409, warning)
}

function recordReview(r: Pick<ReviewAction, 'taskId' | 'action' | 'feedback'>) {
  const review = reviews.add(r)
  broadcast({ type: 'review', review })
  return review
}

/**
 * Approve: repo chính phải ở mainBranch và sạch, sau đó `git merge --no-ff claude/task-<id>`.
 * Thành công → task Done, xoá worktree + nhánh. Conflict → `git merge --abort`, task giữ Review kèm cảnh báo.
 */
export async function approveTask(taskId: number): Promise<{ task: Task; review: ReviewAction }> {
  const first = tasks.get(taskId)
  if (!first) throw new ReviewError(404, `Không tìm thấy task #${taskId}`)
  return withLock(first.projectId, () => approveLocked(taskId))
}

async function approveLocked(taskId: number) {
  // Đọc lại trong khoá: lệnh approve trước có thể vừa đổi trạng thái task
  const task = tasks.get(taskId)
  if (!task) throw new ReviewError(404, `Không tìm thấy task #${taskId}`)
  if (task.status !== 'review') throw new ReviewError(409, `Task #${taskId} không ở trạng thái Review`)
  const project: Project | undefined = projects.get(task.projectId)
  if (!project) throw new ReviewError(404, `Không tìm thấy project của task #${taskId}`)

  const branch = taskBranch(taskId)
  const repo = project.repoPath

  let st: Awaited<ReturnType<typeof mainRepoStatus>>
  try {
    st = await mainRepoStatus(project)
  } catch (e) {
    blocked(taskId, `Không đọc được repo chính (${repo}): ${(e as Error).message}`)
  }
  const notReady = repoNotReadyWarning(st, project.mainBranch)
  if (notReady) blocked(taskId, notReady)

  if ((await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code !== 0)
    blocked(taskId, `Không tìm thấy nhánh "${branch}" trong repo chính, không có gì để merge.`)

  const m = await mergeBranch(repo, branch, mergeMessage(task))
  if (!m.ok) {
    if (m.conflicts.length) blocked(taskId, conflictWarning(m.conflicts, project.mainBranch))
    const warning = `Merge nhánh "${branch}" thất bại: ${m.error}`
    patchTask(taskId, { reviewWarning: warning })
    throw new ReviewError(500, warning)
  }

  // Đã merge: dừng test đang chạy trong worktree (nếu có) rồi dọn worktree + nhánh
  if (isTesting(taskId)) await stopTests(taskId, 'Task đã được merge.')
  await removeWorktree(project, taskId)

  const review = recordReview({ taskId, action: 'approve' })
  const done = patchTask(taskId, { status: 'done', reviewWarning: null, branch: null, worktreePath: null })!
  return { task: done, review }
}

// ---------------------------------------------------------------- request changes (PLAN 2.5)

// Dùng chung với giao diện (nút "Gửi feedback" bị vô hiệu khi chưa đủ độ dài)
export { MIN_FEEDBACK }

/** Kiểm tra feedback "Yêu cầu sửa": bắt buộc, tối thiểu MIN_FEEDBACK ký tự (sau khi bỏ khoảng trắng hai đầu). */
export function validateFeedback(feedback: unknown): string {
  const f = typeof feedback === 'string' ? feedback.trim() : ''
  if (!f) throw new ReviewError(400, 'Vui lòng nhập nội dung yêu cầu sửa')
  if (f.length < MIN_FEEDBACK) throw new ReviewError(400, `Nội dung yêu cầu sửa phải có ít nhất ${MIN_FEEDBACK} ký tự`)
  return f
}

/** Phụ thuộc vào runner, tách ra để test thay bằng bản giả (không spawn Claude thật). */
export interface RunnerDeps {
  hasSlot: (project: Project) => boolean
  startRun: (task: Task, kind: 'resume', feedback: string) => void
}

/**
 * Request changes: ghi review rồi chạy tiếp đúng phiên Claude cũ (`--resume <sessionId>`) trong cùng worktree.
 * Còn slot → startRun ngay (task Running). Hết slot → task Queued, feedback lưu ở `tasks.pending_feedback`
 * để pump() chạy resume khi có slot. Run kết thúc thành công → commit mới trên nhánh, task về Review, diff tính lại.
 */
export async function requestChanges(
  taskId: number,
  rawFeedback: unknown,
  deps: RunnerDeps,
): Promise<{ task: Task; review: ReviewAction; queued: boolean }> {
  const feedback = validateFeedback(rawFeedback)
  const first = tasks.get(taskId)
  if (!first) throw new ReviewError(404, `Không tìm thấy task #${taskId}`)
  // Cùng khoá với approve: không thể vừa merge vừa yêu cầu sửa một task.
  return withLock(first.projectId, async () => {
    const task = tasks.get(taskId)
    if (!task) throw new ReviewError(404, `Không tìm thấy task #${taskId}`)
    if (task.status !== 'review') throw new ReviewError(409, `Task #${taskId} không ở trạng thái Review`)
    const project = projects.get(task.projectId)
    if (!project) throw new ReviewError(404, `Không tìm thấy project của task #${taskId}`)

    const review = recordReview({ taskId, action: 'request_changes', feedback })
    const queued = !deps.hasSlot(project)
    if (queued) {
      if (isTesting(taskId)) await stopTests(taskId, 'Đã dừng vì task được yêu cầu sửa.')
      patchTask(taskId, { status: 'queued', pendingFeedback: feedback, reviewWarning: null })
    } else {
      deps.startRun(task, 'resume', feedback) // tự dừng test, chuyển Running và xoá pendingFeedback
    }
    return { task: tasks.get(taskId)!, review, queued }
  })
}

// ---------------------------------------------------------------- reject (PLAN 2.6)

export const REJECT_REASON = 'Bị từ chối khi review'

/** Reject: ghi review, xoá worktree + nhánh claude/task-<id>, task Failed. */
export async function rejectTask(taskId: number, feedback?: unknown): Promise<{ task: Task; review: ReviewAction }> {
  const first = tasks.get(taskId)
  if (!first) throw new ReviewError(404, `Không tìm thấy task #${taskId}`)
  return withLock(first.projectId, async () => {
    const task = tasks.get(taskId)
    if (!task) throw new ReviewError(404, `Không tìm thấy task #${taskId}`)
    if (task.status !== 'review') throw new ReviewError(409, `Task #${taskId} không ở trạng thái Review`)
    const project = projects.get(task.projectId)
    if (!project) throw new ReviewError(404, `Không tìm thấy project của task #${taskId}`)

    if (isTesting(taskId)) await stopTests(taskId, 'Task đã bị từ chối.')
    await removeWorktree(project, taskId)

    const note = typeof feedback === 'string' ? feedback.trim() : ''
    const review = recordReview({ taskId, action: 'reject', feedback: note || undefined })
    const failed = patchTask(taskId, {
      status: 'failed',
      failReason: REJECT_REASON,
      reviewWarning: null,
      pendingFeedback: null,
      branch: null,
      worktreePath: null,
    })!
    return { task: failed, review }
  })
}
