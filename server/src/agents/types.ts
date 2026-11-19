// Interface chung cho mọi agent chạy task (SPEC-MULTI-AGENT mục 3.1).
// Runner chỉ gọi qua interface này; phần riêng của từng CLI nằm trong agents/<id>.ts.
import type { Parsed, ResultInfo } from '../stream.ts'
import type { RateLimitEvent, RateLimitHit } from '../rateLimit.ts'
import type { AgentId, Answers, PermissionMode, Project, Question, RunKind, Task } from '../types.ts'
import type { AgentPermissionRequest, BrokerDecision } from '../permissionBroker.ts'

export type { AgentId } from '../types.ts'

export interface AgentCapabilities {
  /** Hỏi người duyệt giữa lúc chạy (Needs Input) → hỗ trợ mode manual/auto. */
  interactivePermission: boolean
  /** Hỏi lại người dùng kiểu nhiều lựa chọn (FR-40). */
  askUser: boolean
  /** Chạy tiếp đúng phiên cũ. */
  resume: boolean
  /** CLI báo chi phí USD. */
  costUsd: boolean
  /** CLI tự dừng khi vượt budget (chế độ API key, FR-80..83). */
  hardBudget: boolean
  /** Mức quyền hỗ trợ được (sau khi ánh xạ, SPEC-MULTI-AGENT mục 3.3). */
  permissionModes: readonly PermissionMode[]
}

export interface AgentBin {
  path: string
  source: string
  version?: string
}

/** Thông tin một lần chạy mà runner đã chuẩn bị xong (worktree, session, model, prompt). */
export interface RunInput {
  task: Task
  project: Project
  bin: string
  runId: string
  kind: RunKind
  feedback?: string
  sessionId: string
  resume: boolean
  cwd: string
  model?: string
  prompt: string
  /** Thư mục chứa log thô và file cấu hình tạm của run. */
  runLogDir: string
}

/** Kết quả chuẩn bị tiến trình: tham số, môi trường, dữ liệu stdin, và hàm dọn file tạm. */
export type PreparedRun =
  | { ok: true; args: string[]; env: NodeJS.ProcessEnv; stdin?: string; cleanup: () => void }
  | { ok: false; error: string }

/** Thông tin cuối run để nhận diện lỗi. */
export interface RunOutcome {
  result?: ResultInfo
  stderr?: string
  rateLimitEvent?: RateLimitEvent
}

/**
 * Ngữ cảnh runner đưa cho driver của agent giao tiếp hai chiều (Codex app-server, Antigravity ACP).
 * Driver tự gửi lệnh qua stdin, đọc phản hồi, xin quyền qua cổng chung, rồi báo `done` khi lượt chạy kết thúc.
 */
export interface DriverContext {
  input: RunInput
  /** Ghi một thông điệp JSON (một dòng) vào stdin của tiến trình. */
  send(msg: object): void
  /** Event log / kết quả / session / model, xử lý y như dòng stream-json của Claude. */
  emit(p: Parsed): void
  /** Xin quyền qua PermissionBroker (allowlist, rủi ro, mode, Needs Input). Lỗi bất kỳ → từ chối. */
  requestPermission(r: Omit<AgentPermissionRequest, 'taskId'>): Promise<BrokerDecision>
  /** Hỏi lại người dùng (FR-40). undefined = bỏ qua / hết giờ / task dừng. */
  askUser(questions: Question[]): Promise<Answers | undefined>
  /** Lượt chạy đã xong: runner đóng stdin và dừng tiến trình, exitCode dùng thay mã thoát thật. */
  done(o: { exitCode: number }): void
}

export interface AgentDriver {
  /** Gửi các lệnh mở đầu (initialize, thread/start, turn/start…). */
  start(): void
  /** Một dòng stdout của tiến trình. */
  onLine(line: string): void
}

/**
 * Adapter cho một agent CLI. Kiểu "spawn rồi đọc từng dòng stdout" (Claude Code) dùng `createParser`;
 * kiểu hai chiều (Codex app-server) dùng thêm `createDriver`, khi đó runner không tự ghi/đóng stdin.
 */
export interface AgentAdapter {
  id: AgentId
  /** Tên ngắn trong thông báo cho người dùng: "Claude", "Codex"… */
  name: string
  /** Tên đầy đủ trên giao diện: "Claude Code", "OpenAI Codex"… */
  label: string
  capabilities: AgentCapabilities
  findBin(refresh?: boolean): AgentBin | null
  /** Lý do khi không tìm thấy CLI (kèm hướng dẫn cài). */
  missingBinReason: string
  prepare(o: RunInput): PreparedRun
  createParser(cwd: string): { parseLine(line: string): Parsed }
  /** Có: agent giao tiếp hai chiều qua stdin/stdout; runner chuyển mọi dòng stdout cho driver thay vì parser. */
  createDriver?(ctx: DriverContext): AgentDriver
  /** CLI báo không tìm thấy phiên khi resume. */
  isMissingSession(o: RunOutcome): boolean
  detectRateLimit(o: RunOutcome): RateLimitHit | undefined
  /** Run chạy được trọn vẹn: agent có lượt lại (bỏ banner hết lượt...). */
  onSuccess(): void
  /** Run gặp giới hạn sử dụng: ghi nhận trạng thái chung (banner...). */
  onRateLimit(hit: RateLimitHit, o: RunOutcome): void
  /** Gợi ý thêm cho lý do thất bại (ví dụ key sai, hết credit). */
  failureHint(o: RunOutcome): string | undefined
}
