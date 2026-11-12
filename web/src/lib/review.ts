// Logic thuần cho màn hình review (PLAN 2.9–2.12): không phụ thuộc React/DOM để test được.
import type { FileDiff, PermissionRequest, ReviewAction, Run, Task } from '../types.ts'

/** Feedback "Request changes" tối thiểu (khớp kiểm tra ở server/src/review.ts). */
export const MIN_FEEDBACK = 5

/** Đếm cho badge: cột Review và mục "Cần xử lý" trên menu. */
export function attentionCounts(tasks: Pick<Task, 'id' | 'status'>[], permissions: Pick<PermissionRequest, 'taskId' | 'status'>[]) {
  const ids = new Set(tasks.map((t) => t.id))
  const waiting = new Set(tasks.filter((t) => t.status === 'needs_input').map((t) => t.id))
  // Yêu cầu quyền đang chờ cũng là việc cần xử lý, kể cả khi trạng thái task chưa kịp đổi
  for (const p of permissions) if (p.status === 'pending' && ids.has(p.taskId)) waiting.add(p.taskId)
  const review = tasks.filter((t) => t.status === 'review').length
  // Mỗi task chỉ đếm một lần dù vừa Review vừa có yêu cầu quyền
  const total = new Set([...waiting, ...tasks.filter((t) => t.status === 'review').map((t) => t.id)]).size
  return { review, needsInput: waiting.size, total }
}

/**
 * Có cần gọi `GET /api/tasks/:id/diff` không: state chưa có diff của task, và task còn nhánh
 * (đang Review hoặc chưa dọn worktree). Task đã merge/reject thì nhánh bị xoá, không còn diff để lấy.
 */
export function needsDiffFetch(task: Pick<Task, 'id' | 'status' | 'branch'>, diffs: Record<number, FileDiff[] | undefined>) {
  return diffs[task.id] === undefined && (task.status === 'review' || !!task.branch)
}

export type HistoryItem =
  | { kind: 'run'; at: number; run: Run; index: number; review?: ReviewAction }
  | { kind: 'review'; at: number; review: ReviewAction; pending?: boolean }

/**
 * Dòng thời gian tab Lịch sử: các run (initial/resume/retry) xen với các lần review theo thời gian.
 * Mỗi run 'resume' được ghép với lần "Request changes" đã sinh ra nó; feedback chưa có run tương ứng
 * (đang chờ slot) hiện riêng với `pending: true`.
 */
export function buildHistory(runs: Run[], reviews: ReviewAction[]): HistoryItem[] {
  const sortedRuns = [...runs].sort((a, b) => a.startedAt - b.startedAt)
  const sortedReviews = [...reviews].sort((a, b) => a.createdAt - b.createdAt)
  const used = new Set<string>()
  const items: HistoryItem[] = []

  sortedRuns.forEach((run, index) => {
    let review: ReviewAction | undefined
    if (run.kind === 'resume') {
      const before = sortedReviews.filter((r) => r.action === 'request_changes' && !used.has(r.id) && r.createdAt <= run.startedAt)
      review = before.find((r) => r.feedback === run.feedback) ?? before[0]
      if (review) used.add(review.id)
    }
    items.push({ kind: 'run', at: run.startedAt, run, index, review })
  })
  for (const r of sortedReviews) {
    if (used.has(r.id)) continue
    items.push({ kind: 'review', at: r.createdAt, review: r, pending: r.action === 'request_changes' ? true : undefined })
  }
  // Ổn định: cùng thời điểm thì review (nguyên nhân) đứng trước run (kết quả)
  return items.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'review' ? -1 : 1))
}
