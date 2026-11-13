// Approve & Merge (PLAN 2.4) và lịch sử review (PLAN 2.8).
// Merge nhánh claude/task-<id> vào nhánh chính của repo; mỗi project chỉ một lệnh merge chạy tại một thời điểm.
import { broadcast } from './bus.ts'
import { projects, reviews, tasks } from './db.ts'
import { branchChangedFiles, git, mainRepoStatus, mergeBranch, removeWorktree, taskBranch } from './git.ts'
import { isTesting, stopTests } from './testRunner.ts'
import { MIN_FEEDBACK } from '../../web/src/lib/review.ts'
import { formatReviewFeedback, parseComments } from '../../web/src/lib/reviewComments.ts'
import type { MergeCheck, Project, ReviewAction, ReviewComment, Task } from './types.ts'

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

/**
 * Repo chính có merge được nhánh task không (G3, đã kiểm chứng với git):
 * - phải đang ở mainBranch;
 * - không có file đã stage (`git add`): git từ chối merge khi index khác HEAD;
 * - file chưa commit (đã sửa hoặc chưa track) **trùng** với file task sửa thì chặn, vì merge sẽ ghi đè.
 * File chưa commit không liên quan được giữ nguyên, merge vẫn an toàn.
 * `caseInsensitive`: so tên file không phân biệt hoa thường (Windows / macOS).
 */
export function mergeReadiness(
  st: { branch: string; changes: string[]; staged: string[] },
  mainBranch: string,
  taskFiles: string[],
  caseInsensitive = process.platform === 'win32' || process.platform === 'darwin',
): { ready: boolean; overlap: string[]; warning?: string } {
  const norm = (f: string) => (caseInsensitive ? f.toLowerCase() : f)
  const touched = new Set(taskFiles.map(norm))
  const overlap = [...new Set(st.changes)].filter((f) => touched.has(norm(f)))
  const parts: string[] = []
  if (st.branch !== mainBranch) {
    parts.push(
      st.branch === 'HEAD'
        ? `Repo chính đang ở trạng thái detached HEAD, cần checkout nhánh "${mainBranch}"`
        : `Repo chính đang ở nhánh "${st.branch}", cần chuyển về nhánh "${mainBranch}"`,
    )
  }
  if (overlap.length)
    parts.push(`Repo chính có ${overlap.length} file chưa commit trùng với file task đã sửa: ${listFiles(overlap)}. Hãy commit hoặc bỏ thay đổi ở các file này`)
  if (st.staged.length)
    parts.push(`Repo chính có ${st.staged.length} file đã stage (git add) nhưng chưa commit: ${listFiles(st.staged)}. Hãy commit hoặc unstage (git restore --staged)`)
  return { ready: parts.length === 0, overlap, warning: parts.length ? `${parts.join('. ')} trước khi merge.` : undefined }
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

function recordReview(r: Pick<ReviewAction, 'taskId' | 'action' | 'feedback' | 'comments'>) {
  const review = reviews.add(r)
  broadcast({ type: 'review', review })
  return review
}

/**
 * Approve: repo chính phải ở mainBranch, không có file đã stage và không có file chưa commit trùng với task
 * (xem mergeReadiness), sau đó `git merge --no-ff claude/task-<id>`.
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

  // Output không kèm thay đổi code (hoặc nhánh đã mất): duyệt là xong, không có gì để merge.
  if (!(await branchHasChanges(repo, branch, project.mainBranch))) return finishApproved(task, project)

  let check: MergeCheck
  try {
    check = await inspectMerge(project, branch)
  } catch (e) {
    blocked(taskId, `Không đọc được repo chính (${repo}): ${(e as Error).message}`)
  }
  if (check.warning) blocked(taskId, check.warning)

  const m = await mergeBranch(repo, branch, mergeMessage(task))
  if (!m.ok) {
    if (m.conflicts.length) blocked(taskId, conflictWarning(m.conflicts, project.mainBranch))
    const warning = `Merge nhánh "${branch}" thất bại: ${m.error}`
    patchTask(taskId, { reviewWarning: warning })
    throw new ReviewError(500, warning)
  }
  return finishApproved(task, project)
}

/** Trạng thái repo chính so với nhánh task (dùng cho Approve và cho kiểm tra trước trên giao diện). */
async function inspectMerge(project: Project, branch: string): Promise<MergeCheck> {
  const [st, taskFiles] = await Promise.all([mainRepoStatus(project), branchChangedFiles(project.repoPath, branch, project.mainBranch)])
  const r = mergeReadiness(st, project.mainBranch, taskFiles)
  return {
    hasChanges: true,
    ready: r.ready,
    mainBranch: project.mainBranch,
    currentBranch: st.branch,
    dirty: st.changes,
    overlap: r.overlap,
    staged: st.staged,
    warning: r.warning,
    checkedAt: Date.now(),
  }
}

/**
 * Kiểm tra trước khi Approve (không thay đổi gì): có cần merge không, repo chính có sẵn sàng không,
 * file chưa commit nào trùng với task. Task không có thay đổi code thì luôn sẵn sàng.
 */
export async function checkMerge(taskId: number): Promise<MergeCheck> {
  const task = tasks.get(taskId)
  if (!task) throw new ReviewError(404, `Không tìm thấy task #${taskId}`)
  const project = projects.get(task.projectId)
  if (!project) throw new ReviewError(404, `Không tìm thấy project của task #${taskId}`)
  const branch = taskBranch(taskId)
  const base = { mainBranch: project.mainBranch, currentBranch: '', dirty: [], overlap: [], staged: [], checkedAt: Date.now() }
  try {
    if (!(await branchHasChanges(project.repoPath, branch, project.mainBranch))) return { ...base, hasChanges: false, ready: true }
    return await inspectMerge(project, branch)
  } catch (e) {
    return { ...base, hasChanges: true, ready: false, warning: `Không đọc được repo chính (${project.repoPath}): ${(e as Error).message}` }
  }
}

/** Nhánh task còn tồn tại và có commit chưa vào mainBranch. */
export async function branchHasChanges(repo: string, branch: string, mainBranch: string): Promise<boolean> {
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code !== 0) return false
  const r = await git(repo, ['rev-list', '--count', `${mainBranch}..${branch}`])
  if (r.code !== 0) throw new ReviewError(500, `Không đếm được commit của nhánh "${branch}": ${r.stderr.trim()}`)
  return Number(r.stdout.trim()) > 0
}

/** Đã duyệt (đã merge, hoặc không có gì để merge): dừng test đang chạy, dọn worktree + nhánh, task Done. */
async function finishApproved(task: Task, project: Project) {
  if (isTesting(task.id)) await stopTests(task.id, 'Task đã được duyệt.')
  await removeWorktree(project, task.id)
  const review = recordReview({ taskId: task.id, action: 'approve' })
  const done = patchTask(task.id, { status: 'done', reviewWarning: null, branch: null, worktreePath: null })!
  return { task: done, review }
}

// ---------------------------------------------------------------- request changes (PLAN 2.5)

// Dùng chung với giao diện (nút "Gửi feedback" bị vô hiệu khi chưa đủ độ dài)
export { MIN_FEEDBACK }

/**
 * Feedback + nhận xét theo file/dòng của "Request changes". Có ít nhất một nhận xét thì feedback chung
 * được bỏ trống; nếu nhập thì vẫn phải đủ MIN_FEEDBACK ký tự.
 */
export function validateRequest(rawFeedback: unknown, rawComments: unknown): { feedback?: string; comments: ReviewComment[] } {
  const parsed = parseComments(rawComments)
  if (parsed.error !== undefined) throw new ReviewError(400, parsed.error)
  const { comments } = parsed
  const text = typeof rawFeedback === 'string' ? rawFeedback.trim() : ''
  if (comments.length && !text) return { comments }
  return { feedback: validateFeedback(text), comments }
}

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
  rawComments?: unknown,
): Promise<{ task: Task; review: ReviewAction; queued: boolean }> {
  const { feedback, comments } = validateRequest(rawFeedback, rawComments)
  // Nội dung Claude nhận: feedback chung + từng nhận xét kèm file:dòng và nội dung dòng
  const prompt = formatReviewFeedback(feedback, comments)
  const first = tasks.get(taskId)
  if (!first) throw new ReviewError(404, `Không tìm thấy task #${taskId}`)
  // Cùng khoá với approve: không thể vừa merge vừa yêu cầu sửa một task.
  return withLock(first.projectId, async () => {
    const task = tasks.get(taskId)
    if (!task) throw new ReviewError(404, `Không tìm thấy task #${taskId}`)
    if (task.status !== 'review') throw new ReviewError(409, `Task #${taskId} không ở trạng thái Review`)
    const project = projects.get(task.projectId)
    if (!project) throw new ReviewError(404, `Không tìm thấy project của task #${taskId}`)

    const review = recordReview({ taskId, action: 'request_changes', feedback, comments })
    const queued = !deps.hasSlot(project)
    if (queued) {
      if (isTesting(taskId)) await stopTests(taskId, 'Đã dừng vì task được yêu cầu sửa.')
      patchTask(taskId, { status: 'queued', pendingFeedback: prompt, reviewWarning: null })
    } else {
      deps.startRun(task, 'resume', prompt) // tự dừng test, chuyển Running và xoá pendingFeedback
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
