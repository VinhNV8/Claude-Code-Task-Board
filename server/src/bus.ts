// Kênh sự kiện nội bộ: mọi thay đổi trạng thái đều phát ra đây, WebSocket đẩy xuống giao diện.
import { EventEmitter } from 'node:events'
import type { ClaudeLimit } from '../../web/src/lib/claudeLimit.ts'
import type { AgentId, FileDiff, LogEvent, PermissionRequest, Project, ProjectBudget, PromptTemplate, ReviewAction, RuleSuggestion, Run, Schedule, ScheduleRun, Settings, Task, TestRun } from './types.ts'

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
  // Diff của task so với nhánh chính (PLAN 2.3), gửi khi task chuyển sang Review
  | { type: 'diff'; taskId: number; files: FileDiff[] }
  // Lịch sử review (PLAN 2.8): approve / request_changes / reject
  | { type: 'review'; review: ReviewAction }
  // Budget tháng theo project (PLAN P6): toàn bộ bảng budget, và cảnh báo khi lên mức warn/over (web hiện toast)
  | { type: 'budgets'; budgets: Record<string, ProjectBudget> }
  | { type: 'budget_alert'; projectId: string; level: 'warn' | 'over'; month: string; message: string }
  // Gợi ý rule allowlist của project đã đổi (FR-44): web cập nhật khối gợi ý
  | { type: 'rule_suggestions'; projectId: string; suggestions: RuleSuggestion[] }
  // Gói Claude hết lượt (5 giờ / tuần): web hiện banner trên mọi trang; null = đã có lượt lại
  | { type: 'claude_limit'; limit: ClaudeLimit | null }
  // FR-99: task chuyển sang agent dự phòng vì agent đang dùng hết hạn mức (Telegram gom theo đợt). until = giờ agent cũ có lượt lại
  | { type: 'agent_failover'; taskId: number; from: AgentId; to: AgentId; until?: number }

export const bus = new EventEmitter()
bus.setMaxListeners(100)

/**
 * Gắn thông tin chỉ tính lúc chạy vào task trước khi gửi: blockedReason (P6, budgetService.ts),
 * handoff (SPEC-PLAN-HANDOFF FR-113, handoffRoutes.ts). Mỗi module đăng ký một lần; chạy theo thứ tự đăng ký.
 */
const decorators: ((t: Task) => Task)[] = []

export function setTaskDecorator(fn: (t: Task) => Task) {
  if (!decorators.includes(fn)) decorators.push(fn)
}

export const decorateTask = (t: Task): Task => decorators.reduce((acc, fn) => fn(acc), t)

export const broadcast = (m: ServerMessage) => bus.emit('message', m.type === 'task' ? { ...m, task: decorateTask(m.task) } : m)
