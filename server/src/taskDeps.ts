// Phụ thuộc giữa task (SPEC FR-08, PLAN C-02): kiểm tra khi lưu, gợi ý từ văn bản, xử lý BLOCKED_BY của Claude.
import { taskDeps, tasks } from './db.ts'
import { findCycle, parseBlockedBy, parseRefs, resolveRefs, taskCode, unmetDeps } from '../../web/src/lib/deps.ts'
import type { Task } from './types.ts'

export class DepsError extends Error {}

export const MAX_DEPS = 20

const label = (t: Pick<Task, 'id' | 'title'>) => {
  const code = taskCode(t.title)
  return code ? `#${t.id} [${code}]` : `#${t.id}`
}

/**
 * Kiểm tra danh sách chờ trước khi lưu (R1, R7): số nguyên dương, tồn tại, cùng project, không chờ chính nó,
 * không tạo vòng tròn. Trả về danh sách đã bỏ trùng, tăng dần.
 */
export function validateDeps(raw: unknown, o: { taskId?: number; projectId: string }): number[] {
  if (raw === null || raw === undefined) return []
  if (!Array.isArray(raw)) throw new DepsError('Danh sách task chờ không hợp lệ')
  const ids = [...new Set(raw.map((v) => Number(v)))]
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new DepsError('Danh sách task chờ chỉ gồm id task (số nguyên dương)')
  if (ids.length > MAX_DEPS) throw new DepsError(`Một task chờ tối đa ${MAX_DEPS} task`)
  for (const id of ids) {
    if (id === o.taskId) throw new DepsError('Task không thể chờ chính nó')
    const t = tasks.get(id)
    if (!t) throw new DepsError(`Không tìm thấy task #${id}`)
    if (t.projectId !== o.projectId) throw new DepsError(`Task #${id} thuộc project khác, chỉ chờ được task cùng project`)
  }
  if (o.taskId !== undefined) {
    const cycle = findCycle(o.taskId, ids, taskDeps.of)
    if (cycle) throw new DepsError(`Phụ thuộc vòng tròn: ${cycle.map((id) => `#${id}`).join(' → ')}`)
  }
  return ids.sort((a, b) => a - b)
}

const statusOf = (id: number) => tasks.get(id)?.status

/** Task được chờ chưa Done (R2). */
export const pendingDeps = (task: Pick<Task, 'dependsOn'>) => unmetDeps(task, statusOf)

export interface DepSuggestion {
  id: number
  title: string
  status: Task['status']
}

/**
 * Nguồn ③ (R5): tìm `#id` / mã task trong tiêu đề + prompt, gợi ý các task cùng project chưa Done
 * và chưa có trong danh sách chờ. Không tự thêm, giao diện cho người dùng bấm.
 */
export function suggestDeps(o: { projectId: string; text: string; taskId?: number; current?: number[] }): DepSuggestion[] {
  const all = tasks.all()
  const ids = resolveRefs(parseRefs(o.text), all, o.projectId, o.taskId)
  const current = new Set(o.current ?? [])
  return ids
    .map((id) => all.find((t) => t.id === id)!)
    .filter((t) => t.status !== 'done' && !current.has(t.id))
    .map((t) => ({ id: t.id, title: t.title, status: t.status }))
}

export type BlockedDecision =
  | { action: 'requeue'; deps: number[]; added: number[]; note: string }
  | { action: 'fail'; reason: string }

/**
 * Nguồn ④ (R6): Claude kết thúc run bằng `BLOCKED_BY: …`. Trả về null nếu không có dòng này.
 * - Tìm được task chưa Done, cùng project, không tạo vòng tròn → thêm phụ thuộc, task về Queued.
 * - Không tìm được, hoặc mọi task được nhắc đã Done → Failed kèm lý do (tránh lặp chạy → bị chặn → chạy).
 */
export function decideBlocked(task: Pick<Task, 'id' | 'projectId' | 'dependsOn'>, resultText: string | undefined): BlockedDecision | null {
  const parsed = parseBlockedBy(resultText)
  if (!parsed) return null
  const reasonText = parsed.reason ? ` (${parsed.reason})` : ''
  const refText = [...parsed.refs.ids.map((i) => `#${i}`), ...parsed.refs.codes].join(', ')
  const all = tasks.all()
  const found = resolveRefs(parsed.refs, all, task.projectId, task.id).map((id) => all.find((t) => t.id === id)!)
  if (!found.length)
    return { action: 'fail', reason: `Claude báo cần chờ ${refText}${reasonText} nhưng không tìm thấy task tương ứng trong project. Hãy tạo task đó hoặc kiểm tra lại.` }
  const open = found.filter((t) => t.status !== 'done')
  if (!open.length)
    return {
      action: 'fail',
      reason:
        `Claude báo cần chờ ${found.map(label).join(', ')}${reasonText}, nhưng task đó đã Done. ` +
        'Có thể task đó làm chưa đủ: hãy kiểm tra, tạo task bổ sung rồi đặt phụ thuộc và Chạy lại.',
    }
  const current = task.dependsOn ?? []
  const deps = [...new Set([...current, ...open.map((t) => t.id)])].sort((a, b) => a - b)
  const cycle = findCycle(task.id, deps, taskDeps.of)
  if (cycle)
    return { action: 'fail', reason: `Claude báo cần chờ ${open.map(label).join(', ')} nhưng sẽ tạo phụ thuộc vòng tròn: ${cycle.map((i) => `#${i}`).join(' → ')}.` }
  const added = open.map((t) => t.id).filter((id) => !current.includes(id))
  const note =
    `Claude báo bị chặn bởi ${open.map(label).join(', ')}${reasonText}. ` +
    'Đã thêm phụ thuộc, bỏ thay đổi dở và đưa task về hàng đợi: task sẽ chạy lại từ đầu khi các task đó Done.'
  return { action: 'requeue', deps, added, note }
}
