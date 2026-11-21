// Driver cho `agy acp` (Agent Client Protocol, JSON-RPC 2.0, mỗi dòng một JSON qua stdio). Giao thức đã kiểm chứng ở
// P0-SPIKE (Antigravity G1–G14), fixture thật: server/fixtures/antigravity/*.jsonl.
// Một run: initialize → session/new | session/load → [session/set_model] → session/prompt (chờ phản hồi = hết lượt)
// → nếu có thao tác bị từ chối: gửi tiếp lý do bằng session/prompt (agy kết thúc lượt ngay khi bị từ chối, GD4).
import { relative, isAbsolute } from 'node:path'
import { BLOCKED_BY_INSTRUCTION } from '../../../web/src/lib/deps.ts'
import { isInside, type AgentActionKind } from '../permissionBroker.ts'
import type { ResultInfo } from '../stream.ts'
import type { LogEventInput } from '../types.ts'
import type { AgentDriver, DriverContext } from './types.ts'

type Json = Record<string, any>

const MAX_OUTPUT = 4000
const truncate = (s: string, n = MAX_OUTPUT) => (s.length > n ? `${s.slice(0, n)}\n… (đã cắt, tổng ${s.length} ký tự)` : s)

/** Đánh dấu lỗi "không có phiên để resume" trong ResultInfo.text (adapter.isMissingSession đọc lại). */
export const MISSING_SESSION = 'Antigravity: không tìm thấy phiên (session) để chạy tiếp'
/** Số lần tối đa gửi tiếp lý do từ chối trong một run (tránh lặp vô hạn, ví dụ mode Plan từ chối liên tục). */
export const MAX_DENIAL_FOLLOWUPS = 2

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)

/**
 * `toolCall` của ACP (agy) → thao tác chuẩn của PermissionBroker. agy dùng khoá PascalCase trong `rawInput`
 * (`CommandLine`, `Path`, `Content`…); vẫn đọc cả khoá thường để chịu được thay đổi phiên bản.
 */
export function toAction(tc: Json): { kind: AgentActionKind; command?: string; path?: string; url?: string; tool?: string } {
  const raw: Json = tc?.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {}
  const path = str(raw.Path) ?? str(raw.AbsolutePath) ?? str(raw.TargetFile) ?? str(raw.FilePath) ?? str(raw.file_path) ?? str(raw.path)
  const url = str(raw.Url) ?? str(raw.url) ?? str(raw.URL)
  switch (tc?.kind) {
    case 'execute':
      return { kind: 'shell', command: str(raw.CommandLine) ?? str(raw.command) ?? str(tc.title) ?? '' }
    case 'edit':
    case 'delete':
    case 'move':
      return { kind: 'edit', path }
    case 'read':
    case 'search':
      return { kind: 'read', path }
    case 'fetch':
      return { kind: 'web', url: url ?? str(tc.title) }
    default:
      return { kind: 'other', tool: str(tc?.title) ?? str(tc?.kind) ?? 'tool' }
  }
}

/** Tên tool hiển thị trong log (giống Claude để log nhìn quen). */
const TOOL_NAME: Record<string, string> = { execute: 'Bash', edit: 'Edit', delete: 'Edit', move: 'Edit', read: 'Read', search: 'Grep', fetch: 'WebFetch' }

export function createAntigravityDriver(ctx: DriverContext, o: { clientVersion: string }): AgentDriver {
  const { input } = ctx
  let nextId = 1
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Json) => void }>()
  const calls = new Map<string, Json>()
  const denials: ResultInfo['permissionDenials'] = []
  /** Lý do từ chối trong lượt hiện tại, gửi lại cho agy ở lượt kế tiếp. */
  let turnDenials: string[] = []
  let sessionId: string | undefined
  let chunk = ''
  let lastText = ''
  let contextTokens: number | undefined
  let finished = false

  const request = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ctx.send({ jsonrpc: '2.0', id, method, params })
    })
  const reply = (id: number | string, result: object) => ctx.send({ jsonrpc: '2.0', id, result })
  const replyError = (id: number | string, message: string) => ctx.send({ jsonrpc: '2.0', id, error: { code: -32601, message } })
  const emitEvents = (...events: LogEventInput[]) => ctx.emit({ events })
  const rel = (p: string) => (isAbsolute(p) && isInside(p, input.cwd) ? relative(input.cwd, p) || p : p)
  /** Mô tả ngắn của thao tác cho log: lệnh, đường dẫn (tương đối với thư mục task), URL hoặc tên tool. */
  const shownOf = (a: ReturnType<typeof toAction>) => a.command || (a.path ? rel(a.path) : '') || a.url || a.tool || ''

  /** Đoạn trả lời đang gom (agent_message_chunk) → một event assistant. */
  function flushText() {
    const text = chunk.trim()
    chunk = ''
    if (!text) return
    // agy báo lỗi API tạm thời (agy tự thử lại) lẫn trong lời trả lời: tách thành thông báo hệ thống
    if (/^⚠\s*API error/i.test(text)) return emitEvents({ type: 'system', text })
    lastText = text
    emitEvents({ type: 'assistant', text })
  }

  function finish(result: ResultInfo, exitCode: number) {
    if (finished) return
    finished = true
    flushText()
    ctx.emit({ events: [{ type: 'result', isError: result.isError, text: truncate(result.text) }], result })
    ctx.done({ exitCode })
  }
  const fail = (text: string) => finish({ isError: true, text, permissionDenials: denials, sessionId }, 1)

  async function prompt(text: string): Promise<Json> {
    return request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
  }

  async function start() {
    try {
      await request('initialize', {
        protocolVersion: 1,
        // Không cho agy đọc/ghi file hay mở terminal qua client: agy tự làm trong cwd, mọi thao tác đều xin quyền.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'agent-task-board', version: o.clientVersion },
      })
      let sess: Json
      if (input.resume) {
        try {
          sess = await request('session/load', { sessionId: input.sessionId, cwd: input.cwd, mcpServers: [] })
          sessionId = input.sessionId
        } catch (e) {
          fail(`${MISSING_SESSION}: ${(e as Json)?.message ?? JSON.stringify(e)}`)
          return
        }
      } else {
        sess = await request('session/new', { cwd: input.cwd, mcpServers: [] })
        sessionId = sess?.sessionId
      }
      let model: string | undefined = sess?.models?.currentModelId
      const available: string[] = (sess?.models?.availableModels ?? []).map((m: Json) => m.modelId).filter(Boolean)
      if (input.model && input.model !== model) {
        if (available.includes(input.model)) {
          await request('session/set_model', { sessionId, modelId: input.model }).catch(() => undefined)
          model = input.model
        } else emitEvents({ type: 'system', text: `Model "${input.model}" không có trong Antigravity, dùng ${model ?? 'mặc định'}.` })
      }
      ctx.emit({ events: [], sessionId, model })

      // Lời dặn BLOCKED_BY (FR-08) đi kèm prompt: chưa kiểm chứng _meta.systemPrompt của agy (G11).
      let res = await prompt(`${BLOCKED_BY_INSTRUCTION}\n\n${input.prompt}`)
      for (let i = 0; i < MAX_DENIAL_FOLLOWUPS && turnDenials.length && res?.stopReason === 'end_turn'; i++) {
        flushText()
        const why = turnDenials.join('\n')
        turnDenials = []
        emitEvents({ type: 'system', text: 'Gửi lý do từ chối cho Antigravity và yêu cầu làm tiếp theo cách khác.' })
        res = await prompt(`Các thao tác sau đã bị từ chối:\n${why}\nHãy làm tiếp theo cách khác, không thử lại đúng thao tác đó.`)
      }
      const stop = res?.stopReason
      if (stop === 'end_turn') {
        flushText()
        return finish({ isError: false, text: lastText || '(Antigravity không trả lời)', numTurns: 1, sessionId, permissionDenials: denials, contextTokens }, 0)
      }
      fail(`Antigravity dừng lượt chạy: ${stop ?? 'không rõ lý do'}`)
    } catch (e) {
      fail(`Antigravity ACP báo lỗi: ${(e as Json)?.message ?? JSON.stringify(e)}`)
    }
  }

  async function onRequest(msg: Json) {
    const p: Json = msg.params ?? {}
    try {
      if (msg.method !== 'session/request_permission') {
        emitEvents({ type: 'system', text: `Antigravity yêu cầu "${msg.method}", Task Board chưa hỗ trợ nên đã từ chối.` })
        return replyError(msg.id, 'Not supported by Agent Task Board')
      }
      const tc: Json = p.toolCall ?? {}
      const a = toAction(tc)
      const d = await ctx.requestPermission({ ...a, reason: str(tc.rawInput?.toolSummary) })
      const options: Json[] = Array.isArray(p.options) ? p.options : []
      const want = d.allow ? 'allow_once' : 'reject_once'
      const opt = options.find((x) => x.kind === want) ?? options.find((x) => String(x.kind ?? '').startsWith(d.allow ? 'allow' : 'reject'))
      if (!d.allow) {
        const what = shownOf(a) || String(tc.title ?? '')
        denials.push({ tool: TOOL_NAME[tc.kind] ?? String(tc.kind ?? 'tool'), input: what })
        turnDenials.push(`- ${tc.title ?? what}: ${d.message}`)
        emitEvents({ type: 'system', text: `Từ chối: ${tc.title ?? what} (${d.message})` })
      }
      // Không có lựa chọn phù hợp → huỷ (đóng an toàn)
      return reply(msg.id, opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } })
    } catch (e) {
      return reply(msg.id, { outcome: { outcome: 'cancelled' } })
    }
  }

  function onUpdate(u: Json) {
    switch (u?.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content?.type === 'text') chunk += String(u.content.text ?? '')
        return
      case 'tool_call':
        flushText()
        // _startedAt: tool_use chỉ được ghi lúc tool xong; FR-64 cần biết lệnh chạy trong khoảng nào
        if (u.toolCallId) calls.set(u.toolCallId, { ...u, _startedAt: Date.now() })
        return
      case 'tool_call_update': {
        const c = { ...(calls.get(u.toolCallId) ?? {}), ...u }
        calls.set(u.toolCallId, c)
        if (c.status !== 'completed' && c.status !== 'failed') return
        if (c.done) return
        c.done = true
        const tool = TOOL_NAME[c.kind] ?? String(c.title ?? c.kind ?? 'tool')
        const a = toAction(c)
        const shown = shownOf(a) || String(c.title ?? '')
        const out = Array.isArray(c.content)
          ? c.content.map((x: Json) => x?.content?.text ?? x?.text ?? '').filter(Boolean).join('\n')
          : typeof c.rawOutput === 'string'
            ? c.rawOutput
            : c.rawOutput
              ? JSON.stringify(c.rawOutput)
              : ''
        return emitEvents(
          { type: 'tool_use', tool, input: truncate(shown, 500), startedAt: typeof c._startedAt === 'number' ? c._startedAt : undefined },
          { type: 'tool_result', tool, output: truncate(out || (c.status === 'completed' ? 'Xong.' : 'Thất bại.')), isError: c.status === 'failed' },
        )
      }
      case 'usage_update':
        if (typeof u.used === 'number') contextTokens = u.used
        return
      default:
        return
    }
  }

  function onLine(line: string) {
    let msg: Json
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id !== undefined && !msg.method) {
      const w = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) w?.reject(msg.error)
      else w?.resolve(msg.result)
      return
    }
    if (msg.id !== undefined && msg.method) return void onRequest(msg)
    if (msg.method === 'session/update') onUpdate(msg.params?.update)
  }

  return { start: () => void start(), onLine }
}
