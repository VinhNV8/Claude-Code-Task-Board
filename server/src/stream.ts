// Chuyển từng dòng stream-json của Claude Code thành LogEvent cho giao diện.
// Schema đã kiểm chứng ở docs/P0-SPIKE.md (S6).
import { relative, isAbsolute } from 'node:path'
import type { LogEventInput } from './types.ts'

export interface ResultInfo {
  isError: boolean
  text: string
  numTurns?: number
  costUsd?: number
  sessionId?: string
  permissionDenials: { tool: string; input: string }[]
  apiErrorStatus?: number | null
}

export interface Parsed {
  events: LogEventInput[]
  result?: ResultInfo
  sessionId?: string
}

const MAX_OUTPUT = 4000

function truncate(s: string, n = MAX_OUTPUT) {
  return s.length > n ? s.slice(0, n) + `\n… (đã cắt, tổng ${s.length} ký tự)` : s
}

type Json = Record<string, any>

export class StreamParser {
  private toolNames = new Map<string, string>()
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
      out.events.push({
        type: 'system',
        text: `Khởi tạo phiên • model ${j.model} • mode ${j.permissionMode} • Claude Code ${j.claude_code_version ?? ''}`.trim(),
      })
      return out
    }

    if (j.type === 'assistant' && j.message?.content) {
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
      }
      out.events.push({ type: 'result', isError: out.result.isError, text: truncate(text) })
      for (const d of denials)
        out.events.push({ type: 'system', text: `Quyền bị từ chối: ${d.tool}(${d.input})` })
      return out
    }

    // system/thinking_tokens, rate_limit_event, stream_event...: bỏ qua
    return out
  }
}
