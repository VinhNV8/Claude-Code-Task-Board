// Cổng duyệt quyền chung cho agent khác Claude (SPEC-MULTI-AGENT mục 3.3a).
// Claude vẫn đi đường cũ: MCP `--permission-prompt-tool` → POST /api/internal/permissions → requestPermission.
// Agent khác (Codex app-server, Antigravity ACP…) gửi yêu cầu duyệt về adapter trong tiến trình server; adapter gọi
// awaitPermission(). Yêu cầu được đổi sang dạng tool của Claude (Bash/Edit/Write/Read/WebFetch/mcp__…) để dùng lại
// nguyên vẹn allowlist (FR-42/43), phân loại rủi ro (FR-45), mode Auto (FR-47), Needs Input, Inbox, Telegram, timeout.
import { posix } from 'node:path'
import { toPosixPath } from './permissionRules.ts'
import { requestPermission as realRequestPermission, type PermissionAsk, type PollResponse } from './permissions.ts'
import { QUESTION_TOOL } from '../../web/src/lib/question.ts'
import type { Answers, PermissionMode, Question } from './types.ts'

type Input = Record<string, unknown>

export type AgentActionKind = 'shell' | 'edit' | 'write' | 'read' | 'web' | 'mcp' | 'other'

/** Yêu cầu duyệt đã chuẩn hoá từ phía agent. */
export interface AgentPermissionRequest {
  taskId: number
  kind: AgentActionKind
  /** shell: lệnh đầy đủ */
  command?: string
  /** edit/write/read: đường dẫn (tuyệt đối hoặc tương đối với cwd) */
  path?: string
  /** web: URL */
  url?: string
  /** mcp: `server/tool`; other: tên tool của agent */
  tool?: string
  /** Mô tả ngắn từ agent (lý do xin quyền), chỉ để hiển thị. */
  reason?: string
}

export type BrokerDecision = { allow: true } | { allow: false; message: string }

/** Đổi yêu cầu của agent sang tên tool + input kiểu Claude để so allowlist, phân loại rủi ro và hiển thị. */
export function toClaudeTool(r: AgentPermissionRequest): { toolName: string; input: Input } {
  const extra: Input = r.reason ? { description: r.reason } : {}
  switch (r.kind) {
    case 'shell':
      return { toolName: 'Bash', input: { command: r.command ?? '', ...extra } }
    case 'edit':
      return { toolName: 'Edit', input: { file_path: r.path ?? '', ...extra } }
    case 'write':
      return { toolName: 'Write', input: { file_path: r.path ?? '', ...extra } }
    case 'read':
      return { toolName: 'Read', input: { file_path: r.path ?? '', ...extra } }
    case 'web':
      return { toolName: 'WebFetch', input: { url: r.url ?? '', ...extra } }
    case 'mcp': {
      const [server, tool] = (r.tool ?? '').split('/', 2)
      return { toolName: `mcp__${server || 'unknown'}__${tool || '*'}`, input: { ...extra } }
    }
    default:
      return { toolName: r.tool || 'Unknown', input: { ...extra } }
  }
}

/** Đường dẫn nằm trong thư mục làm việc của task (so theo POSIX, không phân biệt hoa thường trên Windows). */
export function isInside(path: string | undefined, cwd: string | undefined, caseInsensitive = process.platform === 'win32'): boolean {
  if (!path || !cwd) return false
  const base = toPosixPath(cwd)
  const p0 = toPosixPath(path)
  let target = p0.startsWith('/') ? p0 : toPosixPath(posix.join(base, p0))
  let root = base
  if (caseInsensitive) {
    target = target.toLowerCase()
    root = root.toLowerCase()
  }
  return target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/**
 * Quyết định theo mode trước khi hỏi backend. Agent khác chạy ở chế độ "hỏi mọi thứ" (agy `strict`, Codex `untrusted`),
 * nên phần mà Claude CLI tự xử lý theo `--permission-mode` phải làm ở đây:
 * - đọc file trong thư mục task: luôn cho phép (Claude cũng tự cho phép đọc trong workspace);
 * - `plan`: từ chối mọi sửa file, lệnh, MCP (chỉ phân tích);
 * - `acceptEdits`: tự cho phép sửa/tạo file trong thư mục task.
 * Còn lại (`undefined`) → backend: allowlist, rủi ro, mode Auto, hoặc chờ người duyệt.
 */
export function modeDecision(mode: PermissionMode, r: AgentPermissionRequest, cwd: string | undefined): BrokerDecision | undefined {
  if (r.kind === 'read' && isInside(r.path, cwd)) return { allow: true }
  if (mode === 'plan') {
    if (r.kind === 'read' || r.kind === 'web') return undefined
    return { allow: false, message: 'Mode Plan chỉ cho phép đọc và phân tích, không sửa file hay chạy lệnh.' }
  }
  if (mode === 'acceptEdits' && (r.kind === 'edit' || r.kind === 'write') && isInside(r.path, cwd)) return { allow: true }
  return undefined
}

export interface BrokerDeps {
  requestPermission: (a: PermissionAsk) => Promise<PollResponse>
}

const defaultDeps: BrokerDeps = { requestPermission: (a) => realRequestPermission(a) }

/** Hỏi đi tiếp bằng requestId cho tới khi có quyết định (requestPermission trả `pending` sau mỗi chặng long-poll). */
async function settle(deps: BrokerDeps, a: PermissionAsk): Promise<PollResponse> {
  let res = await deps.requestPermission(a)
  while ('status' in res && res.status === 'pending') res = await deps.requestPermission({ ...a, requestId: res.requestId })
  return res
}

/**
 * FR-40 cho agent khác Claude: hỏi lại người dùng qua đúng luồng câu hỏi của Claude (`AskUserQuestion`: thẻ câu hỏi,
 * Telegram, luôn chờ người trả lời). Trả đáp án (khoá = nguyên văn câu hỏi); undefined = bỏ qua / hết giờ / task dừng / lỗi.
 */
export async function awaitQuestion(taskId: number, questions: Question[], deps: BrokerDeps = defaultDeps): Promise<Answers | undefined> {
  try {
    const res = await settle(deps, { taskId, toolName: QUESTION_TOOL, input: { questions } })
    if ('decision' in res && res.decision === 'allow') return (res.updatedInput as { answers?: Answers }).answers
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Xin quyền cho một thao tác của agent và chờ đến khi có quyết định (người duyệt, allowlist, mode Auto, timeout,
 * hoặc task bị dừng → các yêu cầu treo bị huỷ). Lỗi bất kỳ → từ chối (đóng an toàn).
 */
export async function awaitPermission(
  r: AgentPermissionRequest,
  ctx: { mode: PermissionMode; cwd?: string },
  deps: BrokerDeps = defaultDeps,
): Promise<BrokerDecision> {
  const pre = modeDecision(ctx.mode, r, ctx.cwd)
  if (pre) return pre
  const { toolName, input } = toClaudeTool(r)
  try {
    const res = await settle(deps, { taskId: r.taskId, toolName, input })
    if ('decision' in res && res.decision === 'allow') return { allow: true }
    if ('decision' in res && res.decision === 'deny') return { allow: false, message: res.message }
    return { allow: false, message: 'Không nhận được quyết định duyệt quyền.' }
  } catch (err) {
    return { allow: false, message: `Không xin được quyền: ${(err as Error).message}` }
  }
}
