// Quy tắc xoá task, dùng chung cho server (API 409) và UI (hiện nút Xoá).
// Chỉ xoá được task chưa chạy (backlog, queued) hoặc đã kết thúc không thành công
// (failed — gồm cả task bị người dùng dừng/huỷ). Task đang chạy, chờ trả lời, chờ review
// hoặc đã hoàn thành thì không xoá để tránh mất output/lịch sử.
import type { TaskStatus } from '../types.ts'

export const DELETABLE_STATUSES: readonly TaskStatus[] = ['backlog', 'queued', 'failed']

export function canDeleteTask(status: TaskStatus): boolean {
  return DELETABLE_STATUSES.includes(status)
}
