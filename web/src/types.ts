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

export interface Settings {
  maxParallel: number
  browserNotifications: boolean
  notifyOn: { review: boolean; needsInput: boolean; failed: boolean }
  permissionTimeoutMin: number
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
