// Kênh sự kiện nội bộ: mọi thay đổi trạng thái đều phát ra đây, WebSocket đẩy xuống giao diện.
import { EventEmitter } from 'node:events'
import type { LogEvent, PermissionRequest, Project, Run, Settings, Task } from './types.ts'

export type ServerMessage =
  | { type: 'task'; task: Task }
  | { type: 'task_deleted'; id: number }
  | { type: 'run'; run: Run }
  | { type: 'event'; event: LogEvent }
  | { type: 'project'; project: Project }
  | { type: 'project_deleted'; id: string }
  | { type: 'settings'; settings: Settings }
  | { type: 'permission'; permission: PermissionRequest }

export const bus = new EventEmitter()
bus.setMaxListeners(100)

export const broadcast = (m: ServerMessage) => bus.emit('message', m)
