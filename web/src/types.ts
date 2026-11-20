// Mô hình dữ liệu dùng chung, bám theo SPEC Mục 5.2.
// P1 sẽ thay nguồn dữ liệu giả bằng API thật nhưng giữ nguyên các kiểu này.
import type { Answers, Question } from './lib/question.ts'
export type { Answers, Question, QuestionOption } from './lib/question.ts'

export type TaskStatus =
  | 'backlog'
  | 'queued'
  | 'running'
  | 'needs_input'
  | 'review'
  | 'done'
  | 'failed'

export type Priority = 'low' | 'normal' | 'high' | 'urgent'

export type PermissionMode = 'manual' | 'acceptEdits' | 'auto' | 'plan'

/** Agent chạy task (SPEC-MULTI-AGENT). Chọn theo 3 tầng Task → Project → Settings; mặc định `claude`. */
export type AgentId = 'claude' | 'codex' | 'antigravity' | 'cursor'

/** Failover của project: theo hệ thống, chuỗi riêng, hoặc tắt (SPEC-MULTI-AGENT QA6). */
export type FailoverMode = 'inherit' | 'custom' | 'off'

/** Tự chuyển agent khi agent đang dùng hết hạn mức (FR-99). */
export interface FailoverSettings {
  enabled: boolean
  /** Thứ tự agent: agent đầu tiên còn dùng được (khác agent hiện tại) được chọn. */
  chain: AgentId[]
}

/** Trạng thái một agent trên máy chạy server (GET /api/agents). */
export interface AgentInfo {
  id: AgentId
  /** Tên ngắn: "Claude", "Codex"… */
  name: string
  /** Tên đầy đủ: "Claude Code", "OpenAI Codex"… */
  label: string
  /** Task Board đã có adapter cho agent này (chạy được task). */
  supported: boolean
  /** Tìm thấy CLI trên máy. */
  installed: boolean
  version?: string
  /** Nơi tìm thấy CLI: biến môi trường, extension VS Code, PATH… */
  source?: string
  /** Mức quyền agent hỗ trợ (rỗng nếu chưa có adapter). */
  permissionModes: PermissionMode[]
  /** Agent báo chi phí USD (không có: chỉ có token). */
  costUsd: boolean
  /** CLI tự dừng khi vượt budget (chế độ API key): chỉ agent này chạy được ở project có budget cứng. */
  hardBudget: boolean
  /** Đang hết hạn mức gói đến mốc này (epoch ms); không có = còn lượt (FR-99 ngắt mạch). */
  limitedUntil?: number
}

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
  /** Model mặc định cho task của project (alias hoặc ID `claude-…`). Rỗng: kế thừa Settings (PLAN P5, D2). */
  defaultModel?: string
  /** Agent mặc định cho task của project. Rỗng: kế thừa Settings (SPEC-MULTI-AGENT FR-91). */
  defaultAgent?: AgentId
  /** Tự chuyển agent khi gặp sự cố (FR-99): theo hệ thống (mặc định), chuỗi riêng, hoặc tắt. */
  failoverMode?: FailoverMode
  /** Chuỗi dự phòng riêng của project, dùng khi failoverMode = 'custom'. */
  failoverChain?: AgentId[]
  /** Budget tháng (USD, giá niêm yết, ước tính). Không có: không giới hạn (PLAN P6, B1). */
  monthlyBudgetUsd?: number
  /** Khi vượt budget: chỉ cảnh báo, hoặc tạm dừng chạy task mới (B3). */
  budgetAction: BudgetAction
  /**
   * Cách Claude giao output:
   * - `direct`: làm thẳng trong thư mục project (repoPath), thấy file ngay, không cần git. Duyệt = chấp nhận output.
   * - `worktree`: làm trong worktree riêng (nhánh `claude/task-<id>`, giữ ở local). Duyệt = chấp nhận output;
   *   merge vào nhánh chính là thao tác riêng, tuỳ chọn.
   */
  deliveryMode: DeliveryMode
  /** Giá trị planMode mặc định cho task mới của project (FR-100). Không có: `none`. */
  defaultPlanMode?: PlanMode
}

export type DeliveryMode = 'direct' | 'worktree'

/**
 * Duyệt kế hoạch trước khi làm (SPEC-PLAN-HANDOFF FR-100): none = làm luôn · first = lập kế hoạch, duyệt rồi mới làm ·
 * only = chỉ lập kế hoạch (thay cho mức quyền `plan` của task).
 */
export type PlanMode = 'none' | 'first' | 'only'

/** Giai đoạn của task có lập kế hoạch: plan = lượt Kế hoạch (mode plan) · execute = lượt Thực hiện sau khi duyệt. */
export type PlanPhase = 'plan' | 'execute'

/** Task đang được mở trong agent tương tác (SPEC-PLAN-HANDOFF FR-113): mọi thao tác chạy bị khoá. */
export interface TaskHandoff {
  via: 'extension' | 'copy'
  startedAt: number
  /** Extension VS Code đã mở terminal. */
  claimed: boolean
}

/** Một task trong kế hoạch đổi mức quyền theo project (FR-48). */
export interface PermissionSyncTask {
  id: number
  title: string
  status: TaskStatus
  permissionMode: PermissionMode
}

/**
 * FR-48: các task chưa chạy (Backlog, Queued, Failed) sẽ đổi sang mức quyền mới của project, và các task bị bỏ qua.
 * Lấy từ POST /api/projects/permission-sync; lưu project kèm `syncTaskPermissions: true` để áp dụng.
 */
export interface PermissionSyncPlan {
  mode: PermissionMode
  apply: PermissionSyncTask[]
  /** Task ở mode Plan: không tự nới thành task được sửa code. */
  skippedPlan: PermissionSyncTask[]
  /** Task chọn agent riêng không chạy được ở mức mới. */
  skippedAgent: (PermissionSyncTask & { reason: string })[]
}

export type BudgetAction = 'warn' | 'pause'

/** Bộ rule allowlist có sẵn (PLAN P7-01), lấy từ GET /api/permission-presets. */
export interface PermissionPreset {
  id: string
  name: string
  description: string
  rules: string[]
}

/** Gợi ý thêm rule vào allowlist từ lịch sử duyệt (FR-44, PLAN P7-02). */
export interface RuleSuggestion {
  rule: string
  /** Số lần đã cho phép trong 30 ngày */
  count: number
  lastAt: number
  /** Lệnh/đầu vào gần nhất sinh ra rule này */
  example: string
}

/** none: không đặt budget · ok: < 80% · warn: ≥ 80% · over: ≥ 100% (PLAN P6, B2). */
export type BudgetLevel = 'none' | 'ok' | 'warn' | 'over'

/** Chi tiêu tháng hiện tại của một project (ước tính theo giá niêm yết, B5). */
export interface ProjectBudget {
  spent: number
  budget?: number
  ratio?: number
  level: BudgetLevel
  /** Tháng theo giờ địa phương của server, dạng 'YYYY-MM'. */
  month: string
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
  /** Thư mục Claude làm việc: worktree (mode worktree) hoặc chính repoPath (mode direct). */
  worktreePath?: string
  /** Mode direct: tree snapshot thư mục project trước run đầu tiên, dùng để tính diff khi review. */
  baseRef?: string
  /** Mode direct: snapshot ngay khi run gần nhất xong, để diff khi review không lẫn thay đổi của task chạy sau. */
  headRef?: string
  sessionId?: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  failReason?: string
  /** Cảnh báo gắn với trạng thái Review (conflict, repo chưa sạch...) */
  reviewWarning?: string
  /** Feedback "Yêu cầu sửa" đang chờ slot: lần chạy kế tiếp từ hàng đợi sẽ là resume với feedback này. */
  pendingFeedback?: string
  /** Task Queued chỉ được chạy từ thời điểm này (epoch ms), đặt khi run trước gặp giới hạn sử dụng. */
  notBefore?: number
  /** Số lần đã tự đưa lại hàng đợi do giới hạn sử dụng (reset khi chạy thành công hoặc người dùng chạy lại). */
  rateLimitRetries?: number
  /** Lần chạy kế tiếp từ hàng đợi là "Tiếp tục" (run 'continue'): chạy tiếp phiên cũ trên worktree đang dở. */
  resumeNext?: boolean
  /** Model chọn riêng cho task (alias hoặc ID `claude-…`). Rỗng: kế thừa project → Settings (PLAN P5, D2). */
  model?: string
  /** Agent chọn riêng cho task. Rỗng: kế thừa project → Settings (SPEC-MULTI-AGENT FR-91). */
  agent?: AgentId
  /**
   * Agent dự phòng đang dùng sau khi tự chuyển (FR-99). Request changes / Tiếp tục giữ agent này;
   * Retry và đổi agent bằng tay thì bỏ.
   */
  activeAgent?: AgentId
  /** Giới hạn chi phí mỗi lần chạy (USD, truyền `--max-budget-usd`). Không có: không giới hạn. */
  maxCostUsd?: number
  /** Phạm vi ghi (FR-49): mẫu đường dẫn task được phép sửa, ví dụ `docs/**`. Không có: không giới hạn. */
  writeScope?: string[]
  /** FR-100: làm luôn / kế hoạch trước / chỉ kế hoạch. Không có: `none`. */
  planMode?: PlanMode
  /** Giai đoạn hiện tại (task planMode khác none). Không có: chưa chạy, hoặc task làm luôn. */
  planPhase?: PlanPhase
  /** Kế hoạch người dùng đã duyệt (có thể đã sửa), gửi cho lượt Thực hiện (FR-103, D5). */
  approvedPlan?: string
  /** Đang mở trong Claude Code (FR-113). Chỉ tính lúc gửi, lưu ở bảng task_handoffs. */
  handoff?: TaskHandoff
  /** Lý do task Queued đang bị giữ lại (ví dụ project vượt budget, P6 B3). Chỉ tính lúc chạy, không lưu DB. */
  blockedReason?: string
  /** Các task phải Done trước khi task này được chạy (SPEC FR-08). Lưu ở bảng task_deps. */
  dependsOn?: number[]
}

/**
 * initial: lần đầu · resume: sửa theo feedback review · retry: chạy lại từ đầu · continue: tiếp tục phiên bị gián đoạn ·
 * manual: người dùng làm tay trong Claude Code (FR-115, không có tiến trình của Task Board, chi phí không rõ)
 */
export type RunKind = 'initial' | 'resume' | 'retry' | 'continue' | 'manual'

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
  /** Agent đã chạy lần này (SPEC-MULTI-AGENT FR-95). Run cũ trước khi có nhiều agent: không có = Claude. */
  agent?: AgentId
  /** ID model thực tế lấy từ event `init` (P5, D1/D8). */
  model?: string
  /** Token và chi phí theo từng model, từ `modelUsage` của event `result`. */
  modelUsage?: Record<string, ModelUsage>
  modelSource?: ModelSource
  modelReason?: string
  /** Giá trị đã truyền vào `--model` (alias hoặc ID). Không có: không truyền `--model`. Run resume/continue dùng lại (D3). */
  requestedModel?: string
  /** Kích thước ngữ cảnh của message assistant cuối (input + cache read + cache creation). */
  contextTokens?: number
  /** P5-06: loại thất bại; chỉ 'claude' mới khiến Retry tự nâng model (D6). */
  failKind?: RunFailKind
  /** FR-105: giai đoạn của lượt chạy (task có lập kế hoạch). */
  phase?: PlanPhase
}

/** Run lỗi do Claude / bị người dùng dừng / gặp giới hạn sử dụng / lỗi hạ tầng (không phải lỗi của model). */
export type RunFailKind = 'claude' | 'stopped' | 'rate_limit' | 'infra'

/** Nguồn chọn model của một run (PLAN P5, D8). */
export type ModelSource = 'auto' | 'manual' | 'default' | 'escalated'

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUsd: number
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
  /** Tên cũ khi file bị đổi tên (status vẫn là 'modified') */
  oldPath?: string
  additions: number
  deletions: number
  hunks: DiffHunk[]
  /** Git coi là file nhị phân (ảnh PNG/JPG…): không có hunk để hiển thị */
  binary?: boolean
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
  /** Mức rủi ro (FR-45): 'high' → luôn duyệt tay, không có "Luôn cho phép". Server tính lúc đọc. */
  risk?: 'high' | 'normal'
  /** Lý do xếp rủi ro cao, tiếng Việt */
  riskReasons?: string[]
  createdAt: number
  timeoutAt: number
  status: 'pending' | 'allowed' | 'denied' | 'timeout'
  /** Lý do người dùng nhập khi Từ chối (FR-46), gửi kèm cho Claude */
  denyReason?: string
  /** FR-40: có khi `tool` là AskUserQuestion. Thẻ hiện câu hỏi + lựa chọn thay cho Cho phép/Từ chối */
  questions?: Question[]
  /** FR-40: đáp án người dùng đã gửi (khoá là nguyên văn câu hỏi) */
  answers?: Answers
}

export interface ReviewAction {
  id: string
  taskId: number
  /** approve: chấp nhận output · merge: chấp nhận và merge nhánh task vào nhánh chính (mode worktree) · approve_plan: duyệt kế hoạch (FR-103) */
  action: 'approve' | 'merge' | 'request_changes' | 'reject' | 'approve_plan'
  feedback?: string
  /** Nhận xét theo file/dòng gửi kèm "Request changes" */
  comments?: ReviewComment[]
  createdAt: number
}

/** Kiểm tra trước khi Merge (tuỳ chọn) (GET /api/tasks/:id/merge-check). */
export interface MergeCheck {
  /** Nhánh task có commit cần merge; false thì Approve chỉ chuyển Done */
  hasChanges: boolean
  /** Merge được ngay */
  ready: boolean
  mainBranch: string
  /** Nhánh repo chính đang checkout */
  currentBranch: string
  /** Mọi file chưa commit trong repo chính */
  dirty: string[]
  /** File chưa commit trùng với file task đã sửa (chặn merge) */
  overlap: string[]
  /** File đã stage nhưng chưa commit (chặn merge) */
  staged: string[]
  /** Lý do chưa merge được */
  warning?: string
  checkedAt: number
}

/** Nhận xét khi review: cho một dòng của diff, hoặc cả file khi không có `line`. */
export interface ReviewComment {
  id: string
  path: string
  /** Số dòng; `side` cho biết theo bản cũ (dòng bị xoá) hay bản mới */
  line?: number
  side?: 'old' | 'new'
  /** Nội dung dòng được nhận xét, gửi kèm để Claude định vị dù số dòng đã lệch */
  snippet?: string
  text: string
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
  /** Agent gợi ý khi dùng template. Không có: theo project/hệ thống */
  agent?: AgentId
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
  /** P5-07 (FR-76): hiệu quả theo loại task (tag) × model của run đầu tiên. */
  byTagModel: StatsTagModel[]
}

/** Một dòng bảng tag × model: mẫu là task đã approve/reject hoặc Failed có kết quả trong khoảng thời gian. */
export interface StatsTagModel {
  /** Tag (chữ thường); "(không tag)" cho task không có tag */
  tag: string
  tier: 'haiku' | 'sonnet' | 'opus'
  n: number
  /** Tỉ lệ được duyệt ngay (0..1) */
  approvalRate: number
  /** Chi phí trung bình mỗi task (tổng các run) */
  avgCost: number
}

export interface Settings {
  maxParallel: number
  browserNotifications: boolean
  notifyOn: { review: boolean; needsInput: boolean; failed: boolean }
  permissionTimeoutMin: number
  /** Model mặc định hệ thống (tầng cuối, D2). '' = không truyền `--model`, dùng mặc định của Claude CLI. */
  defaultModel: string
  /** Agent mặc định hệ thống (tầng cuối, SPEC-MULTI-AGENT FR-91). Mặc định `claude`. */
  defaultAgent: AgentId
  /** Tự chuyển agent khi gặp sự cố (FR-99). Mặc định tắt. */
  failover: FailoverSettings
  /** P5-06 (D6): tự nâng model một bậc khi task thất bại / bị yêu cầu sửa nhiều lần. Mặc định bật. */
  autoEscalate: boolean
  /** Thông báo Telegram (FR-51). Bot token không bao giờ trả ra API, chỉ có cờ hasToken. */
  telegram: TelegramSettings
  /** Cách Claude Code xác thực khi chạy task. API key không bao giờ trả ra API. */
  auth: ClaudeAuthSettings
}

/**
 * subscription: phiên đăng nhập Claude Code (gói Pro/Max) trên máy, chỉ dành cho cá nhân tự dùng.
 * apiKey: API key của Claude Console, trả tiền theo token; budget project trở thành giới hạn cứng.
 */
export type ClaudeAuthMode = 'subscription' | 'apiKey'

export interface ClaudeAuthSettings {
  mode: ClaudeAuthMode
  /** Đã lưu API key (mã hoá) trong DB */
  hasApiKey: boolean
  /** 4 ký tự cuối của key đang dùng, để nhận diện */
  apiKeyHint?: string
  /** Đang dùng key từ biến môi trường TASKBOARD_ANTHROPIC_API_KEY (ưu tiên hơn key đã lưu) */
  envApiKey: boolean
}

/** Dữ liệu gửi lên khi lưu xác thực. apiKey: chuỗi = đặt mới, null hoặc '' = xoá, bỏ trống = giữ nguyên. */
export interface ClaudeAuthInput {
  mode?: ClaudeAuthMode
  apiKey?: string | null
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
  /** Giả lập gói Claude hết lượt (banner trên mọi trang) */
  claudeLimited?: boolean
  /** Lần chạy tiếp theo sẽ xin quyền */
  nextRunAsksPermission: boolean
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** LogEvent chưa có id/runId/ts (dùng khi tạo event mới). */
export type LogEventInput = DistributiveOmit<LogEvent, 'id' | 'runId' | 'ts'>
