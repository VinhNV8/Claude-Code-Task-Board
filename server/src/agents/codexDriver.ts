// Driver cho `codex app-server` (JSON-RPC, mỗi dòng một JSON qua stdio). Giao thức đã kiểm chứng ở P0-SPIKE (Codex C1–C15),
// fixture thật: server/fixtures/codex/*.jsonl. Một run = một lượt (turn): initialize → model/list → thread/start | thread/resume
// → turn/start → nhận notification + yêu cầu duyệt → turn/completed → báo runner `done`.
import { relative, isAbsolute } from 'node:path'
import { BLOCKED_BY_INSTRUCTION } from '../../../web/src/lib/deps.ts'
import { isInside } from '../permissionBroker.ts'
import type { ResultInfo } from '../stream.ts'
import type { LogEventInput, PermissionMode, Question } from '../types.ts'
import type { AgentDriver, DriverContext } from './types.ts'

type Json = Record<string, any>

const MAX_OUTPUT = 4000
const truncate = (s: string, n = MAX_OUTPUT) => (s.length > n ? `${s.slice(0, n)}\n… (đã cắt, tổng ${s.length} ký tự)` : s)

/** Đánh dấu lỗi "không có phiên để resume" trong ResultInfo.text (adapter.isMissingSession đọc lại). */
export const MISSING_THREAD = 'Codex: không tìm thấy phiên (thread) để chạy tiếp'

/**
 * Ánh xạ mức quyền của Task Board sang sandbox + approvalPolicy của Codex (P0-SPIKE CD5, SPEC-MULTI-AGENT 3.3).
 * Mọi mode (trừ plan) chạy `untrusted`: Codex hỏi trước lệnh và sửa file, PermissionBroker quyết theo mode
 * (acceptEdits tự cho sửa file trong thư mục task; manual hỏi người; auto tự duyệt trừ lệnh rủi ro).
 */
export function codexPolicy(mode: PermissionMode): { sandbox: 'read-only' | 'workspace-write'; approvalPolicy: 'untrusted' } {
  return { sandbox: mode === 'plan' ? 'read-only' : 'workspace-write', approvalPolicy: 'untrusted' }
}

/**
 * Codex trên Windows bọc lệnh trong shell: `"C:\…\powershell.exe" -Command 'npm test'`, Linux/macOS: `bash -lc 'npm test'`.
 * Bóc lớp vỏ để allowlist (`Bash(npm test:*)`) và phân loại rủi ro thấy đúng lệnh thật.
 */
export function unwrapShell(cmd: string): string {
  const m = cmd
    .trim()
    .match(/^"?(?:[^"\s]*[\\/])?(?:powershell|pwsh|cmd|bash|zsh|sh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?(?:-Command|-c|-lc|\/c|\/C)\s+([\s\S]+)$/i)
  if (!m) return cmd
  let inner = m[1].trim()
  const q = inner[0]
  if ((q === "'" || q === '"') && inner.endsWith(q) && inner.length >= 2) inner = inner.slice(1, -1)
  return inner
}

/** `codexErrorInfo` là chuỗi (`usageLimitExceeded`) hoặc object một khoá (`{ httpConnectionFailed: {…} }`). */
export const errorCode = (info: unknown): string | undefined =>
  typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined

const RATE_LIMIT_CODES = new Set(['usageLimitExceeded', 'rateLimitExceeded'])

/** Chọn model: model yêu cầu có trong danh sách của tài khoản thì dùng, không thì model mặc định (P0-SPIKE CD2). */
export function pickModel(list: Json[], requested: string | undefined): { model?: string; note?: string } {
  const ids = list.map((m) => (m.id ?? m.model) as string).filter(Boolean)
  const def = (list.find((m) => m.isDefault)?.id as string | undefined) ?? ids[0]
  if (requested && ids.includes(requested)) return { model: requested }
  if (requested) return { model: def, note: `Model "${requested}" không có trong tài khoản Codex, dùng ${def ?? 'mặc định của Codex'}.` }
  return { model: def }
}

/** Lời nhắc chạy tiếp sau khi watchdog ngắt lượt bị treo (P0-SPIKE CD3). */
export const WATCHDOG_CONTINUE = 'Lần sửa file vừa rồi bị treo nên lượt chạy đã bị ngắt. Kiểm tra lại các file, hoàn tất phần việc còn dở rồi trả lời ngắn gọn.'

export function createCodexDriver(ctx: DriverContext, o: { clientVersion: string; fileChangeTimeoutMs?: number }): AgentDriver {
  const { input } = ctx
  let nextId = 1
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Json) => void }>()
  const items = new Map<string, Json>()
  /** Lúc item bắt đầu (item/started): sự kiện tool_use chỉ ghi khi item xong, FR-64 cần biết lệnh chạy trong khoảng nào. */
  const startedAt = new Map<string, number>()
  const denials: ResultInfo['permissionDenials'] = []
  let threadId: string | undefined
  let finalText = ''
  let lastText = ''
  let lastError: Json | undefined
  let tokenUsage: Json | undefined
  let rateLimits: Json | undefined
  let finished = false
  let turnId: string | undefined
  /** CD3: sửa file đã duyệt mà quá hạn chưa xong → ngắt lượt, chạy tiếp một lần. */
  const watchdogMs = o.fileChangeTimeoutMs ?? 60_000
  const watches = new Map<string, NodeJS.Timeout>()
  let recovering = false
  let recovered = false

  const request = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ctx.send({ id, method, params })
    })
  const reply = (id: number | string, result: object) => ctx.send({ id, result })
  const replyError = (id: number | string, message: string) => ctx.send({ id, error: { code: -32601, message } })
  const emitEvents = (...events: LogEventInput[]) => ctx.emit({ events })
  const rel = (p: string) => (isAbsolute(p) && isInside(p, input.cwd) ? relative(input.cwd, p) || p : p)

  function finish(result: ResultInfo, exitCode: number) {
    if (finished) return
    finished = true
    const reset = rateLimits?.primary?.resetsAt
    const limited = result.apiErrorStatus === 429
    ctx.emit({
      events: [{ type: 'result', isError: result.isError, text: truncate(result.text) }],
      result,
      ...(limited ? { rateLimit: { status: 'rejected', resetsAt: typeof reset === 'number' ? reset * 1000 : undefined } } : {}),
    })
    for (const t of watches.values()) clearTimeout(t)
    watches.clear()
    ctx.done({ exitCode })
  }

  const fail = (text: string, extra: Partial<ResultInfo> = {}) =>
    finish({ isError: true, text, permissionDenials: denials, sessionId: threadId, ...extra }, 1)

  async function start() {
    try {
      await request('initialize', {
        clientInfo: { name: 'agent-task-board', title: 'Agent Task Board', version: o.clientVersion },
        capabilities: { experimentalApi: false, requestAttestation: false },
      })
      ctx.send({ method: 'initialized' })
      const list = await request('model/list', {}).catch(() => ({ data: [] }))
      const { model, note } = pickModel((list?.data ?? []) as Json[], input.model)
      if (note) emitEvents({ type: 'system', text: note })
      const common = { cwd: input.cwd, model, ...codexPolicy(input.task.permissionMode), developerInstructions: BLOCKED_BY_INSTRUCTION }
      let th: Json
      if (input.resume) {
        try {
          th = await request('thread/resume', { threadId: input.sessionId, ...common, excludeTurns: true })
        } catch (e) {
          fail(`${MISSING_THREAD}: ${(e as Json)?.message ?? JSON.stringify(e)}`)
          return
        }
      } else th = await request('thread/start', common)
      threadId = th?.thread?.id
      ctx.emit({ events: [], sessionId: threadId, model: th?.model ?? model })
      const ts = await request('turn/start', { threadId, input: [{ type: 'text', text: input.prompt, text_elements: [] }] })
      turnId = ts?.turn?.id ?? turnId
    } catch (e) {
      fail(`Codex app-server báo lỗi: ${(e as Json)?.message ?? JSON.stringify(e)}`)
    }
  }

  async function onRequest(msg: Json) {
    const p: Json = msg.params ?? {}
    try {
      switch (msg.method) {
        case 'item/commandExecution/requestApproval': {
          const command = unwrapShell(String(p.command ?? ''))
          const d = await ctx.requestPermission({ kind: 'shell', command, reason: p.reason ?? undefined })
          if (!d.allow) {
            denials.push({ tool: 'Bash', input: command })
            emitEvents({ type: 'system', text: `Từ chối lệnh: ${command}${d.message ? ` (${d.message})` : ''}` })
          }
          return reply(msg.id, { decision: d.allow ? 'accept' : 'decline' })
        }
        case 'item/fileChange/requestApproval': {
          const changes: Json[] = items.get(p.itemId)?.changes ?? []
          const paths = changes.map((c) => String(c.path ?? '')).filter(Boolean)
          // Có file ngoài thư mục task thì xin theo file đó (để không được tự cho phép theo acceptEdits)
          const path = paths.find((x) => !isInside(x, input.cwd)) ?? paths[0]
          const allAdd = changes.length > 0 && changes.every((c) => c.kind?.type === 'add')
          const reason = paths.length > 1 ? `Sửa ${paths.length} file: ${paths.map(rel).join(', ')}` : (p.reason ?? undefined)
          const d = await ctx.requestPermission({ kind: allAdd ? 'write' : 'edit', path, paths, reason })
          if (!d.allow) {
            denials.push({ tool: allAdd ? 'Write' : 'Edit', input: paths.map(rel).join(', ') })
            emitEvents({ type: 'system', text: `Từ chối sửa file: ${paths.map(rel).join(', ') || '(không rõ)'}${d.message ? ` (${d.message})` : ''}` })
          }
          if (d.allow && p.itemId) watchFileChange(String(p.itemId))
          return reply(msg.id, { decision: d.allow ? 'accept' : 'decline' })
        }
        case 'item/tool/requestUserInput': {
          // FR-40: hỏi lại người dùng qua luồng câu hỏi chung (thẻ câu hỏi, Telegram).
          const raw: Json[] = Array.isArray(p.questions) ? p.questions : []
          const questions: Question[] = raw.map((q) => ({
            question: String(q.question ?? ''),
            header: q.header ? String(q.header) : undefined,
            options: (Array.isArray(q.options) ? q.options : []).map((x: Json) => ({ label: String(x.label ?? ''), description: x.description ? String(x.description) : undefined })),
          }))
          const answers = await ctx.askUser(questions)
          return reply(msg.id, {
            answers: Object.fromEntries(raw.map((q, i) => [q.id, { answers: answers?.[questions[i].question] ? [answers[questions[i].question]] : [] }])),
          })
        }
        default:
          // Xin thêm quyền sandbox (mạng, ghi ngoài workspace…), MCP elicitation, tool động: chưa hỗ trợ → từ chối (đóng an toàn).
          emitEvents({ type: 'system', text: `Codex yêu cầu "${msg.method}", Task Board chưa hỗ trợ nên đã từ chối.` })
          return replyError(msg.id, 'Not supported by Agent Task Board')
      }
    } catch (e) {
      return replyError(msg.id, `Lỗi khi xử lý yêu cầu: ${(e as Error).message}`)
    }
  }

  /** Sau khi duyệt sửa file: quá hạn mà item chưa completed (lỗi treo của Codex alpha, P0-SPIKE C6) → ngắt lượt. */
  function watchFileChange(itemId: string) {
    const t = setTimeout(() => {
      watches.delete(itemId)
      if (finished || recovering || recovered || !threadId || !turnId) return
      recovering = true
      emitEvents({ type: 'system', text: `Codex sửa file quá ${Math.round(watchdogMs / 1000)} giây chưa xong (có thể bị treo): ngắt lượt và cho chạy tiếp.` })
      request('turn/interrupt', { threadId, turnId }).catch(() => undefined)
    }, watchdogMs)
    t.unref?.()
    watches.set(itemId, t)
  }

  function onItemCompleted(item: Json) {
    if (item.id && watches.has(item.id)) {
      clearTimeout(watches.get(item.id))
      watches.delete(item.id)
    }
    if (item.id) items.set(item.id, item)
    switch (item.type) {
      case 'agentMessage': {
        const text = String(item.text ?? '').trim()
        if (!text) return
        lastText = text
        if (item.phase === 'final_answer') finalText = text
        return emitEvents({ type: 'assistant', text })
      }
      case 'commandExecution': {
        const command = unwrapShell(String(item.command ?? ''))
        const declined = item.status === 'declined'
        const out = declined ? 'Bị từ chối, lệnh không chạy.' : String(item.aggregatedOutput ?? '')
        return emitEvents(
          { type: 'tool_use', tool: 'Bash', input: command, startedAt: startedAt.get(item.id) },
          { type: 'tool_result', tool: 'Bash', output: truncate(out), isError: item.status !== 'completed' || (typeof item.exitCode === 'number' && item.exitCode !== 0) },
        )
      }
      case 'fileChange': {
        const paths = ((item.changes ?? []) as Json[]).map((c) => rel(String(c.path ?? '')))
        return emitEvents(
          { type: 'tool_use', tool: 'Edit', input: paths.join(', ') },
          { type: 'tool_result', tool: 'Edit', output: item.status === 'completed' ? 'Đã áp dụng thay đổi.' : `Trạng thái: ${item.status}`, isError: item.status !== 'completed' },
        )
      }
      case 'mcpToolCall': {
        const tool = `mcp__${item.server}__${item.tool}`
        return emitEvents(
          { type: 'tool_use', tool, input: truncate(JSON.stringify(item.arguments ?? {}), 500), startedAt: startedAt.get(item.id) },
          { type: 'tool_result', tool, output: truncate(JSON.stringify(item.error ?? item.result ?? {})), isError: !!item.error },
        )
      }
      case 'webSearch':
        return emitEvents({ type: 'tool_use', tool: 'WebSearch', input: truncate(String(item.query ?? JSON.stringify(item)), 500) })
      default:
        return
    }
  }

  function onTurnCompleted(turn: Json) {
    const status = turn?.status
    if (status === 'interrupted' && recovering && !recovered) {
      recovering = false
      recovered = true
      request('turn/start', { threadId, input: [{ type: 'text', text: WATCHDOG_CONTINUE, text_elements: [] }] })
        .then((ts) => (turnId = ts?.turn?.id ?? turnId))
        .catch((e) => fail(`Không chạy tiếp được sau khi ngắt lượt bị treo: ${(e as Json)?.message ?? JSON.stringify(e)}`))
      return
    }
    const contextTokens = tokenUsage?.last?.totalTokens
    if (status === 'completed') {
      return finish(
        { isError: false, text: finalText || lastText || '(Codex không trả lời)', numTurns: 1, sessionId: threadId, permissionDenials: denials, contextTokens },
        0,
      )
    }
    const err = turn?.error ?? lastError
    const code = errorCode(err?.codexErrorInfo)
    const text = `${err?.message ?? `Lượt chạy kết thúc với trạng thái ${status ?? 'không rõ'}`}${code ? ` [${code}]` : ''}`
    fail(text, { apiErrorStatus: code && RATE_LIMIT_CODES.has(code) ? 429 : undefined, contextTokens })
  }

  function onLine(line: string) {
    let msg: Json
    try {
      msg = JSON.parse(line)
    } catch {
      return // dòng không phải JSON (log lạc): bỏ qua, vẫn nằm trong log thô
    }
    if (msg.id !== undefined && !msg.method) {
      const w = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) w?.reject(msg.error)
      else w?.resolve(msg.result)
      return
    }
    if (msg.id !== undefined && msg.method) return void onRequest(msg)
    const p: Json = msg.params ?? {}
    switch (msg.method) {
      case 'item/started':
        if (p.item?.id) startedAt.set(p.item.id, Date.now())
        if (p.item?.id && (p.item.type === 'fileChange' || p.item.type === 'commandExecution')) items.set(p.item.id, p.item)
        return
      case 'item/completed':
        return onItemCompleted(p.item ?? {})
      case 'thread/tokenUsage/updated':
        tokenUsage = p.tokenUsage
        return
      case 'account/rateLimits/updated':
        rateLimits = p.rateLimits
        return
      case 'error':
        if (!p.willRetry) lastError = p.error
        return
      case 'turn/started':
        if (p.turn?.id) turnId = p.turn.id
        return
      case 'turn/completed':
        return onTurnCompleted(p.turn)
      default:
        return
    }
  }

  return { start: () => void start(), onLine }
}
