// Kênh sự kiện nội bộ: mọi thay đổi trạng thái đều phát ra đây, WebSocket đẩy xuống giao diện.
import { EventEmitter } from 'node:events'
import type { LogEvent, PermissionRequest, Project, PromptTemplate, Run, Schedule, ScheduleRun, Settings, Task, TestRun } from './types.ts'

export type ServerMessage =
  | { type: 'task'; task: Task }
  | { type: 'task_deleted'; id: number }
  | { type: 'run'; run: Run }
  | { type: 'event'; event: LogEvent }
  | { type: 'project'; project: Project }
  | { type: 'project_deleted'; id: string }
  | { type: 'settings'; settings: Settings }
  | { type: 'permission'; permission: PermissionRequest }
  // Hook Notification của Claude (PLAN 3.6): web hiện toast
  | { type: 'notification'; taskId: number; runId: string; message: string; title?: string; notificationType?: string }
  | { type: 'template'; template: PromptTemplate }
  | { type: 'template_deleted'; id: string }
  // Chạy test trên trang Review (FR-34): trạng thái lần chạy và từng đoạn output (offset = vị trí đầu đoạn trong luồng)
  | { type: 'test_run'; testRun: TestRun }
  | { type: 'test_output'; taskId: number; offset: number; chunk: string }
  // Lên lịch theo cron (PLAN 4.6)
  | { type: 'schedule'; schedule: Schedule }
  | { type: 'schedule_deleted'; id: string }
  | { type: 'schedule_run'; run: ScheduleRun }

export const bus = new EventEmitter()
bus.setMaxListeners(100)

export const broadcast = (m: ServerMessage) => bus.emit('message', m)
