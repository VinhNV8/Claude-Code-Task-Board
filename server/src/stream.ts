// Chuyển từng dòng stream-json của Claude Code thành LogEvent cho giao diện.
// Schema đã kiểm chứng ở docs/P0-SPIKE.md (S6).
import { relative, isAbsolute } from 'node:path'
import type { LogEventInput, ModelUsage } from './types.ts'

export interface ResultInfo {
  isError: boolean
  text: string
  numTurns?: number
  costUsd?: number
  sessionId?: string
  permissionDenials: { tool: string; input: string }[]
  apiErrorStatus?: number | null
  /** Token và chi phí theo từng model (`modelUsage` của event result), undefined nếu CLI không gửi. */
  modelUsage?: Record<string, ModelUsage>
  /** Kích thước ngữ cảnh của message assistant cuối cùng của phiên chính. */
  contextTokens?: number
}

export interface Parsed {
  events: LogEventInput[]
  result?: ResultInfo
  sessionId?: string
  /** ID model thực tế từ event `system/init`. */
  model?: string
  /** Dòng `rate_limit_event`: status ('allowed', 'allowed_warning', 'rejected'...) và giờ reset (epoch ms). */
  rateLimit?: { status: string; resetsAt?: number }
}

const MAX_OUTPUT = 4000

function truncate(s: string, n = MAX_OUTPUT) {
  return s.length > n ? s.slice(0, n) + `\n… (đã cắt, tổng ${s.length} ký tự)` : s
}

type Json = Record<string, any>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** `j.modelUsage` của event result → Record<model, ModelUsage> (costUSD → costUsd, thiếu số thì 0). */
export function toModelUsage(raw: unknown): Record<string, ModelUsage> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, ModelUsage> = {}
  for (const [model, u] of Object.entries(raw as Json)) {
    const x: Json = u && typeof u === 'object' ? u : {}
    out[model] = {
      inputTokens: num(x.inputTokens),
      outputTokens: num(x.outputTokens),
      cacheReadInputTokens: num(x.cacheReadInputTokens),
      cacheCreationInputTokens: num(x.cacheCreationInputTokens),
      costUsd: num(x.costUSD ?? x.costUsd),
    }
  }
  return out
}

export class StreamParser {
  private toolNames = new Map<string, string>()
  private lastContextTokens: number | undefined
  constructor(private cwd: string) {}

  private rel(p: unknown) {
    if (typeof p !== 'string') return ''
    if (!isAbsolute(p)) return p
    const r = relative(this.cwd, p)
    return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : p
  }

  /** Tóm tắt input của tool thành 1 dòng dễ đọc. */
  summarizeInput(name: string, input: Json): string {
    if (!input || typeof input !== 'object') return ''
    switch (name) {
      case 'Bash':
      case 'PowerShell':
        return String(input.command ?? '')
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookEdit':
        return this.rel(input.file_path ?? input.notebook_path)
      case 'Glob':
        return String(input.pattern ?? '')
      case 'Grep':
        return `${input.pattern ?? ''}${input.path ? ` (trong ${this.rel(input.path)})` : ''}`
      case 'WebFetch':
        return String(input.url ?? '')
      case 'WebSearch':
        return String(input.query ?? '')
      case 'Task':
      case 'Agent':
        return String(input.description ?? '')
      case 'TodoWrite':
        return `${Array.isArray(input.todos) ? input.todos.length : 0} mục`
      default: {
        const s = JSON.stringify(input)
        return s.length > 200 ? s.slice(0, 200) + '…' : s
      }
    }
  }

  private resultText(content: unknown): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content))
      return content
        .map((c: Json) => (c.type === 'text' ? c.text : c.type === 'image' ? '[ảnh]' : ''))
        .filter(Boolean)
        .join('\n')
    return content == null ? '' : JSON.stringify(content)
  }

  parseLine(line: string): Parsed {
    const out: Parsed = { events: [] }
    let j: Json
    try {
      j = JSON.parse(line)
    } catch {
      if (line.trim()) out.events.push({ type: 'system', text: truncate(line.trim(), 500) })
      return out
    }

    if (j.type === 'system' && j.subtype === 'init') {
      out.sessionId = j.session_id
      if (typeof j.model === 'string' && j.model) out.model = j.model
      out.events.push({
        type: 'system',
        text: `Khởi tạo phiên • model ${j.model} • mode ${j.permissionMode} • Claude Code ${j.claude_code_version ?? ''}`.trim(),
      })
      return out
    }

    if (j.type === 'assistant' && j.message?.content) {
      // Ngữ cảnh của phiên chính (bỏ qua message của subagent: parent_tool_use_id khác null).
      const u = j.message.usage as Json | undefined
      if (u && typeof u === 'object' && !j.parent_tool_use_id)
        this.lastContextTokens = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens)
      for (const c of j.message.content as Json[]) {
        if (c.type === 'text' && c.text?.trim()) out.events.push({ type: 'assistant', text: c.text.trim() })
        if (c.type === 'tool_use') {
          this.toolNames.set(c.id, c.name)
          out.events.push({ type: 'tool_use', tool: c.name, input: this.summarizeInput(c.name, c.input) })
        }
      }
      return out
    }

    if (j.type === 'user' && Array.isArray(j.message?.content)) {
      for (const c of j.message.content as Json[]) {
        if (c.type !== 'tool_result') continue
        const tool = this.toolNames.get(c.tool_use_id) ?? 'tool'
        const text = this.resultText(c.content)
        out.events.push({
          type: 'tool_result',
          tool,
          isError: !!c.is_error,
          output: truncate(tool === 'Read' && !c.is_error ? `${text.split('\n').length} dòng` : text),
        })
      }
      return out
    }

    if (j.type === 'result') {
      const denials = (j.permission_denials ?? []).map((d: Json) => ({
        tool: d.tool_name,
        input: this.summarizeInput(d.tool_name, d.tool_input),
      }))
      const text = typeof j.result === 'string' && j.result ? j.result : j.is_error ? `Kết thúc với lỗi (${j.subtype})` : 'Hoàn thành'
      out.result = {
        isError: !!j.is_error || j.subtype !== 'success',
        text,
        numTurns: j.num_turns,
        costUsd: j.total_cost_usd,
        sessionId: j.session_id,
        permissionDenials: denials,
        apiErrorStatus: j.api_error_status,
        modelUsage: toModelUsage(j.modelUsage),
        contextTokens: this.lastContextTokens,
      }
      out.events.push({ type: 'result', isError: out.result.isError, text: truncate(text) })
      for (const d of denials)
        out.events.push({ type: 'system', text: `Quyền bị từ chối: ${d.tool}(${d.input})` })
      return out
    }

    // Trạng thái hạn mức của gói: runner dùng để nhận diện lỗi giới hạn sử dụng (status 'rejected') và giờ reset.
    if (j.type === 'rate_limit_event' && j.rate_limit_info) {
      const info = j.rate_limit_info as Json
      out.rateLimit = {
        status: String(info.status ?? ''),
        resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : undefined,
      }
      return out
    }

    // system/thinking_tokens, stream_event...: bỏ qua
    return out
  }
}
