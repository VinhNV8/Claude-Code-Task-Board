import type { Task, TaskStatus } from '../types.ts'
import { sortByDeps } from './deps.ts'

/** Các cột hiển thị trên Bảng công việc. Không còn cột Failed: task lỗi quay về Backlog kèm cờ Fail. */
export type BoardColumn = Exclude<TaskStatus, 'failed'>

export const BOARD_COLUMNS: BoardColumn[] = ['backlog', 'queued', 'running', 'needs_input', 'review', 'done']

const DAY = 24 * 3600_000

/** Task Done cũ hơn 24 giờ bị ẩn khỏi bảng khi `hideOld` (task Fail luôn hiện ở Backlog). */
export function isStale(task: Pick<Task, 'status' | 'updatedAt'>, hideOld: boolean, now = Date.now()): boolean {
  return hideOld && task.status === 'done' && now - task.updatedAt >= DAY
}

/** Task đã thất bại (hiện cờ Fail trên thẻ). */
export function isFailed(task: Pick<Task, 'status'>): boolean {
  return task.status === 'failed'
}

/** Cột chứa task trên bảng: task Failed được đưa về Backlog. */
export function boardColumn(task: Pick<Task, 'status'>): BoardColumn {
  return task.status === 'failed' ? 'backlog' : task.status
}

/** Hành động khi thả task vào một cột khác (kéo thả trên Bảng công việc). */
export type DropAction = 'queue' | 'unqueue' | 'run' | 'retry' | 'stop'

/** Các cột cho phép kéo thả. */
export const DRAG_COLUMNS: BoardColumn[] = ['backlog', 'queued', 'running']

/**
 * Hành động tương ứng khi thả `task` vào cột `target`; `null` nếu không được phép.
 * - Backlog → Queued: đưa vào hàng đợi; task Fail thì chạy lại (Retry).
 * - Backlog/Queued → Running: chạy ngay (hết slot thì vào hàng đợi); task Fail thì chạy lại.
 * - Queued → Backlog: bỏ khỏi hàng đợi.
 * - Running → Backlog: dừng task (task về Backlog kèm cờ Fail).
 */
export function dropAction(task: Pick<Task, 'status'>, target: BoardColumn): DropAction | null {
  const from = task.status
  if (boardColumn(task) === target) return null
  switch (target) {
    case 'queued':
      if (from === 'backlog') return 'queue'
      if (from === 'failed') return 'retry'
      return null
    case 'running':
      if (from === 'backlog' || from === 'queued') return 'run'
      if (from === 'failed') return 'retry'
      return null
    case 'backlog':
      if (from === 'queued') return 'unqueue'
      if (from === 'running') return 'stop'
      return null
    default:
      return null
  }
}

/** Task có kéo được không (chỉ task nằm ở Backlog/Queued/Running). */
export function canDrag(task: Pick<Task, 'status'>): boolean {
  return DRAG_COLUMNS.some((c) => dropAction(task, c) !== null)
}

/** Kiểu dữ liệu riêng của thao tác kéo task, để không nhận nhầm link/văn bản kéo từ nơi khác. */
export const DRAG_MIME = 'application/x-taskboard-task'

/** Các action của store dùng khi thả task (truyền vào để hàm thuần, test được). */
export type DropHandlers = Record<DropAction, (id: number) => unknown>

/**
 * Thực hiện thả `task` vào cột `target`. Trả về action đã chạy, hoặc `null` nếu thả không hợp lệ
 * (không gọi gì cả).
 */
export function applyDrop(task: Pick<Task, 'id' | 'status'>, target: BoardColumn, handlers: DropHandlers): DropAction | null {
  const action = dropAction(task, target)
  if (action) void handlers[action](task.id)
  return action
}

/**
 * Danh sách task của một cột, đã sắp xếp.
 * - Backlog: task bị Fail lên đầu (cần xử lý), sau đó mới nhất trước. Task Fail luôn hiện, không bị ẩn theo 24 giờ.
 * - Queued: theo phụ thuộc rồi thứ tự hàng đợi (sortByDeps).
 * - Done: khi `hideOld` chỉ giữ task cập nhật trong 24 giờ.
 */
type QueueItem = Pick<Task, 'id' | 'priority' | 'createdAt' | 'dependsOn'>
const isQueueItem = (t: object): t is QueueItem => 'id' in t && 'priority' in t && 'createdAt' in t

export function columnTasks<T extends Pick<Task, 'status' | 'updatedAt'>>(
  tasks: T[],
  col: BoardColumn,
  opts: { hideOld: boolean; now?: number },
): T[] {
  const now = opts.now ?? Date.now()
  let list = tasks.filter((t) => boardColumn(t) === col)
  if (col === 'done') list = list.filter((t) => !isStale(t, opts.hideOld, now))
  // Queued (FR-08, R4): task đang chờ đứng sau task nó chờ; còn lại theo đúng thứ tự hàng đợi (ưu tiên → tạo trước).
  if (col === 'queued' && list.every(isQueueItem)) return sortByDeps(list as (T & QueueItem)[])
  return list.sort((a, b) => Number(isFailed(b)) - Number(isFailed(a)) || b.updatedAt - a.updatedAt)
}
