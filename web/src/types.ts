// Mô hình dữ liệu dùng chung, bám theo SPEC Mục 5.2.
// P1 sẽ thay nguồn dữ liệu giả bằng API thật nhưng giữ nguyên các kiểu này.

export type TaskStatus =
  | 'backlog'
  | 'queued'
  | 'running'
  | 'needs_input'
  | 'review'
  | 'done'
  | 'failed'

export type Priority = 'low' | 'normal' | 'high' | 'urgent'

export type PermissionMode = 'manual' | 'acceptEdits' | 'plan'

export interface Project {
  id: string
  name: string
  repoPath: string
  mainBranch: string
  permissionMode: PermissionMode
  allowedTools: string[]
  maxParallel: number
  /** Lệnh kiểm tra chạy trong worktree từ trang Review (FR-34), ví dụ `npm test`. Không có: tắt tính năng. */
  testCommand?: string
}

export interface Task {
  id: number
  projectId: string
  title: string
  prompt: string
  status: TaskStatus
  priority: Priority
  permissionMode: PermissionMode
  tags: string[]
  branch?: string
  worktreePath?: string
  sessionId?: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  failReason?: string
  /** Cảnh báo gắn với trạng thái Review (conflict, repo chưa sạch...) */
  reviewWarning?: string
}

export type RunKind = 'initial' | 'resume' | 'retry'

export interface Run {
  id: string
  taskId: number
  kind: RunKind
  feedback?: string
  sessionId?: string
  startedAt: number
  endedAt?: number
  exitCode?: number
  numTurns?: number
  costUsd?: number
  summary?: string
}

export type LogEvent =
  | { id: string; runId: string; ts: number; type: 'system'; text: string }
  | { id: string; runId: string; ts: number; type: 'assistant'; text: string }
  | { id: string; runId: string; ts: number; type: 'tool_use'; tool: string; input: string }
  | { id: string; runId: string; ts: number; type: 'tool_result'; tool: string; output: string; isError?: boolean }
  | { id: string; runId: string; ts: number; type: 'result'; text: string; isError?: boolean }

export interface FileDiff {
  path: string
  status: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  hunks: DiffHunk[]
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffLine {
  type: 'ctx' | 'add' | 'del'
  oldNo?: number
  newNo?: number
  text: string
}

export interface PermissionRequest {
  id: string
  taskId: number
  tool: string
  input: string
  /** Quy tắc sẽ thêm vào project nếu chọn "Luôn cho phép" */
  rules?: string[]
  createdAt: number
  timeoutAt: number
  status: 'pending' | 'allowed' | 'denied' | 'timeout'
}

export interface ReviewAction {
  id: string
  taskId: number
  action: 'approve' | 'request_changes' | 'reject'
  feedback?: string
  createdAt: number
}

export interface Toast {
  id: string
  kind: 'info' | 'success' | 'warning' | 'error'
  title: string
  body?: string
  taskId?: number
}

/** Template prompt dùng lại khi tạo task (FR-06). */
export interface PromptTemplate {
  id: string
  /** Tên ngắn hiện trên nút chọn template */
  name: string
  /** Tiêu đề task gợi ý (có thể rỗng) */
  title: string
  prompt: string
  tags: string[]
  /** Không có: dùng cho mọi project */
  projectId?: string
}

/** Lịch tạo task tự động theo cron (PLAN 4.6). Đến giờ, backend tạo task mới ở Queued từ mẫu này. */
export interface Schedule {
  id: string
  /** Biểu thức cron 5 trường (phút giờ ngày tháng thứ), tính theo giờ của máy chạy server */
  cron: string
  projectId: string
  title: string
  prompt: string
  priority: Priority
  enabled: boolean
  /** Lần chạy kế tiếp (epoch ms); không có khi lịch đang tắt */
  nextRunAt?: number
  /** Lần gần nhất đã tạo task */
  lastRunAt?: number
  createdAt: number
}

/** Một lần lịch đã tạo task (lịch sử). taskId không có nếu task đã bị xoá. */
export interface ScheduleRun {
  id: number
  scheduleId: string
  taskId?: number
  /** Tiêu đề task lúc tạo */
  title: string
  /** Thời điểm theo lịch */
  scheduledFor: number
  /** Thời điểm thực tế tạo task */
  firedAt: number
  /** Tạo bù khi server khởi động lại sau khi lỡ giờ */
  catchUp: boolean
}

export type TestStatus ='running' | 'passed' | 'failed' | 'stopped' | 'error'

/** Lần chạy lệnh test gần nhất của một task (FR-34). Output tải riêng (GET /api/tasks/:id/test) và stream qua WS. */
export interface TestRun {
  taskId: number
  command: string
  status: TestStatus
  startedAt: number
  endedAt?: number
  exitCode?: number
  /** Lý do khi status là error/stopped hoặc quá thời gian */
  error?: string
}

/** Output đã nhận của lần chạy test; `end` là vị trí (số ký tự) cuối cùng trong toàn bộ luồng output. */
export interface TestOutput {
  text: string
  end: number
}

/** Khoảng thời gian chọn được trên trang Thống kê (PLAN 4.4). */
export type StatsRange = 7 | 30 | 90

/** Số liệu cộng dồn của các lần chạy (runs) bắt đầu trong khoảng thời gian. */
export interface RunTotals {
  runs: number
  costUsd: number
  turns: number
  /** Tổng thời gian chạy (ms) của các lần chạy đã kết thúc */
  durationMs: number
}

export interface StatsDay extends RunTotals {
  /** Ngày theo giờ địa phương của người xem, dạng YYYY-MM-DD */
  date: string
  /** Task tạo trong ngày */
  created: number
  /** Task đang ở Done/Failed có lần cập nhật cuối trong ngày (xấp xỉ thời điểm kết thúc) */
  done: number
  failed: number
}

export interface StatsProject extends RunTotals {
  projectId: string
  name: string
  /** Task tạo trong khoảng thời gian */
  tasks: number
  byStatus: Record<TaskStatus, number>
}

export interface Stats {
  days: StatsRange
  /** Mốc bắt đầu (đầu ngày địa phương) và kết thúc của khoảng thời gian, epoch ms */
  from: number
  to: number
  projectId?: string
  totals: RunTotals & { tasks: number; byStatus: Record<TaskStatus, number> }
  daily: StatsDay[]
  projects: StatsProject[]
}

export interface Settings {
  maxParallel: number
  browserNotifications: boolean
  notifyOn: { review: boolean; needsInput: boolean; failed: boolean }
  permissionTimeoutMin: number
  /** Thông báo Telegram (FR-51). Bot token không bao giờ trả ra API, chỉ có cờ hasToken. */
  telegram: TelegramSettings
}

export interface TelegramSettings {
  enabled: boolean
  chatId: string
  /** Địa chỉ giao diện dùng để tạo liên kết mở task, ví dụ http://127.0.0.1:3000 */
  appUrl: string
  hasToken: boolean
}

/** Dữ liệu gửi lên khi lưu cấu hình Telegram. botToken: chuỗi = đặt mới, '' hoặc null = xoá, bỏ trống = giữ nguyên. */
export interface TelegramSettingsInput {
  enabled?: boolean
  chatId?: string
  appUrl?: string
  botToken?: string | null
}

export interface DemoFlags {
  /** Tốc độ giả lập: 1 = bình thường */
  speed: number
  /** Lần Approve tiếp theo sẽ bị conflict */
  mergeConflict: boolean
  /** Repo chính đang có thay đổi chưa commit */
  dirtyMainRepo: boolean
  /** Lần chạy tiếp theo sẽ thất bại */
  nextRunFails: boolean
  /** Lần chạy tiếp theo sẽ xin quyền */
  nextRunAsksPermission: boolean
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** LogEvent chưa có id/runId/ts (dùng khi tạo event mới). */
export type LogEventInput = DistributiveOmit<LogEvent, 'id' | 'runId' | 'ts'>
