// Logic thuần cho trang Công việc với 3 cách xem (Bảng / Điều phối / Phân luồng) và khung chi tiết task.
// Không phụ thuộc React/DOM để test được (server/src/workView.test.ts).
import type { PermissionRequest, Task, TaskStatus } from '../types.ts'
import { fold } from './taskFilter.ts'

export type WorkView = 'board' | 'ops' | 'triage'

export const WORK_VIEWS: WorkView[] = ['board', 'ops', 'triage']

export const VIEW_META: Record<WorkView, { label: string; key: string; hint: string }> = {
  board: { label: 'Bảng', key: '1', hint: 'Lên kế hoạch, kéo thả task giữa các cột' },
  ops: { label: 'Điều phối', key: '2', hint: 'Việc cần bạn, agent đang chạy và pipeline' },
  triage: { label: 'Phân luồng', key: '3', hint: 'Danh sách bên trái, chi tiết bên phải, J/K để chuyển task' },
}

/** Khoá localStorage nhớ cách xem gần nhất. */
export const VIEW_STORAGE_KEY = 'work-view'

export function parseView(raw: string | null | undefined): WorkView | undefined {
  return (WORK_VIEWS as string[]).includes(raw ?? '') ? (raw as WorkView) : undefined
}

/**
 * Cách xem khi mở trang: theo URL, rồi theo lần dùng trước, cuối cùng theo kích thước màn hình
 * (điện thoại mặc định Điều phối vì "Cần bạn" là việc hay làm nhất khi ở xa máy).
 */
export function initialView(param: string | null | undefined, stored: string | null | undefined, narrow: boolean): WorkView {
  return parseView(param) ?? parseView(stored) ?? (narrow ? 'ops' : 'board')
}

/** `?task=` hợp lệ: số nguyên dương. */
export function parseTaskParam(raw: string | null | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined
  const n = Number(raw)
  return n > 0 ? n : undefined
}

/** Sao chép query rồi đặt/xoá từng khoá (null hoặc '' là xoá). Không sửa `current`. */
export function withParams(current: URLSearchParams, patch: Record<string, string | null | undefined>): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') next.delete(k)
    else next.set(k, v)
  }
  return next
}

// ------------------------------------------------------------ phím tắt

export type WorkShortcut = WorkView | 'next' | 'prev' | 'close'

/** 1/2/3: đổi cách xem · J/K: task kế/trước · Esc: đóng khung chi tiết. Bỏ qua khi đang gõ hoặc có phím bổ trợ. */
export function workShortcut(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; targetTag?: string; isContentEditable?: boolean }): WorkShortcut | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isContentEditable) return null
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.targetTag ?? '').toUpperCase())) return null
  if (e.key === 'Escape') return 'close'
  if (e.key === 'j' || e.key === 'J') return 'next'
  if (e.key === 'k' || e.key === 'K') return 'prev'
  return WORK_VIEWS.find((v) => VIEW_META[v].key === e.key) ?? null
}

/** Task kế tiếp/trước trong danh sách; chưa chọn thì lấy đầu (J) hoặc cuối (K). */
export function stepSelection(ids: number[], current: number | undefined, dir: 1 | -1): number | undefined {
  if (!ids.length) return undefined
  const i = current === undefined ? -1 : ids.indexOf(current)
  if (i < 0) return dir === 1 ? ids[0] : ids[ids.length - 1]
  return ids[Math.max(0, Math.min(ids.length - 1, i + dir))]
}

// ------------------------------------------------------------ Phân luồng

/** Thứ tự nhóm: việc cần bạn trước, rồi việc đang chạy, cuối cùng là việc đã xong. */
export const TRIAGE_ORDER: TaskStatus[] = ['needs_input', 'review', 'failed', 'running', 'queued', 'backlog', 'done']

type TriageItem = Pick<Task, 'id' | 'status' | 'updatedAt' | 'createdAt'>

/**
 * Nhóm task theo trạng thái cho view Phân luồng. Chờ bạn / Chờ duyệt: chờ lâu nhất trước.
 * Hàng đợi: tạo trước chạy trước. Các nhóm còn lại: mới cập nhật trước. Bỏ nhóm rỗng.
 */
export function triageGroups<T extends TriageItem>(tasks: T[]): { status: TaskStatus; tasks: T[] }[] {
  return TRIAGE_ORDER.map((status) => {
    const list = tasks.filter((t) => t.status === status)
    if (status === 'needs_input' || status === 'review') list.sort((a, b) => a.updatedAt - b.updatedAt || a.id - b.id)
    else if (status === 'queued') list.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
    else list.sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)
    return { status, tasks: list }
  }).filter((g) => g.tasks.length > 0)
}

// ------------------------------------------------------------ Cần bạn

const DAY = 24 * 3600_000

export type AttentionItem =
  | { kind: 'permission'; taskId: number; at: number; req: PermissionRequest }
  /** Task ở Needs Input nhưng chưa nhận được yêu cầu quyền (WS chậm, tải lại trang) */
  | { kind: 'waiting'; taskId: number; at: number }
  | { kind: 'review'; taskId: number; at: number }
  | { kind: 'failed'; taskId: number; at: number }

/**
 * Danh sách "Cần bạn": yêu cầu quyền (cũ nhất trước), task chờ duyệt (nếu `includeReview`, cũ nhất trước),
 * task lỗi trong 24 giờ (mới nhất trước). Chỉ tính task có trong `tasks` (đã qua bộ lọc).
 */
export function attentionItems(
  tasks: Pick<Task, 'id' | 'status' | 'updatedAt'>[],
  permissions: PermissionRequest[],
  opts: { includeReview: boolean; now: number },
): AttentionItem[] {
  const ids = new Set(tasks.map((t) => t.id))
  const perms = permissions
    .filter((p) => p.status === 'pending' && ids.has(p.taskId))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((req): AttentionItem => ({ kind: 'permission', taskId: req.taskId, at: req.createdAt, req }))
  const asked = new Set(perms.map((p) => p.taskId))
  const waiting = tasks
    .filter((t) => t.status === 'needs_input' && !asked.has(t.id))
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .map((t): AttentionItem => ({ kind: 'waiting', taskId: t.id, at: t.updatedAt }))
  const review = opts.includeReview
    ? tasks
        .filter((t) => t.status === 'review')
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .map((t): AttentionItem => ({ kind: 'review', taskId: t.id, at: t.updatedAt }))
    : []
  const failed = tasks
    .filter((t) => t.status === 'failed' && opts.now - t.updatedAt < DAY)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((t): AttentionItem => ({ kind: 'failed', taskId: t.id, at: t.updatedAt }))
  return [...perms, ...waiting, ...review, ...failed]
}

// ------------------------------------------------------------ Điều phối

/**
 * Task đang giữ slot chạy (Running và Needs Input), sắp theo giờ bắt đầu, độn `undefined` cho slot trống.
 * Có nhiều task hơn số slot (đổi cài đặt khi đang chạy) thì vẫn hiện đủ.
 */
export function slotAssignments<T extends Pick<Task, 'id' | 'status' | 'startedAt'>>(tasks: T[], maxParallel: number): (T | undefined)[] {
  const holders = tasks
    .filter((t) => t.status === 'running' || t.status === 'needs_input')
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id - b.id)
  const n = Math.max(Math.max(1, maxParallel), holders.length)
  return Array.from({ length: n }, (_, i) => holders[i])
}

// ------------------------------------------------------------ Bảng lệnh (Ctrl K)

/** Task khớp từ khoá: `#12` hoặc `12` theo id, còn lại theo tiêu đề (không phân biệt dấu, hoa thường). */
export function searchTasks<T extends Pick<Task, 'id' | 'title' | 'updatedAt'>>(tasks: T[], query: string, limit = 8): T[] {
  const q = query.trim()
  if (!q) return [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
  const idMatch = /^#?(\d+)$/.exec(q)
  const needle = fold(q).toLowerCase()
  const scored = tasks
    .map((t) => {
      if (idMatch && String(t.id) === idMatch[1]) return { t, score: 0 }
      const title = fold(t.title).toLowerCase()
      const at = title.indexOf(needle)
      if (at < 0) return null
      return { t, score: at === 0 ? 1 : 2 }
    })
    .filter((x): x is { t: T; score: number } => x !== null)
  return scored.sort((a, b) => a.score - b.score || b.t.updatedAt - a.t.updatedAt).slice(0, limit).map((x) => x.t)
}

/** Dòng log một câu cho ô Agent đang chạy. */
export function logLine(e: { type: string; text?: string; tool?: string; input?: string; isError?: boolean }): { kind: 'tool' | 'ok' | 'error' | 'text'; text: string } {
  const first = (s = '') => s.trim().split('\n')[0].slice(0, 200)
  switch (e.type) {
    case 'tool_use':
      return { kind: 'tool', text: `${e.tool ?? ''} ${first(e.input)}`.trim() }
    case 'tool_result':
      return e.isError ? { kind: 'error', text: `✗ ${e.tool ?? ''} lỗi` } : { kind: 'ok', text: `✓ ${e.tool ?? ''} xong` }
    case 'result':
      return { kind: e.isError ? 'error' : 'ok', text: first(e.text) || (e.isError ? 'Kết thúc với lỗi' : 'Hoàn thành') }
    default:
      return { kind: 'text', text: first(e.text) }
  }
}
