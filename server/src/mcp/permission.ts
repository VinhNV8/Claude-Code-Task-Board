// MCP permission server (PLAN 3.1). Claude gọi qua `--permission-prompt-tool mcp__taskboard__approve`.
// Chạy độc lập: `tsx server/src/mcp/permission.ts` với các biến môi trường:
//   TASKBOARD_TASK_ID   (bắt buộc) id task đang chạy
//   TASKBOARD_PORT      (mặc định 3001) cổng backend trên 127.0.0.1
//   TASKBOARD_TOKEN     token nội bộ, gửi qua header x-taskboard-token
//   TASKBOARD_PERMISSION_TIMEOUT_MS  tổng thời gian chờ tối đa (mặc định 30 phút)
//
// Giao thức long-poll với backend:
//   POST /api/internal/permissions  body {taskId, toolName, input, toolUseId?, requestId?}
//   200 {decision:'allow', updatedInput?} | {decision:'deny', message?}  → kết thúc
//   200 {status:'pending', requestId}                                     → gọi lại kèm requestId
// stdout dành riêng cho giao thức MCP, mọi log ghi ra stderr.
import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

export interface ApproveArgs {
  tool_name: string
  input: Record<string, unknown>
  tool_use_id?: string
}

export interface PermissionConfig {
  taskId: string | undefined
  port: number
  token: string | undefined
  /** Tổng thời gian chờ quyết định, quá hạn thì deny. */
  timeoutMs: number
  /** Thời gian tối đa cho một lần gọi HTTP (backend nên trả pending trước mốc này). */
  requestTimeoutMs: number
  /** Số lần lỗi kết nối liên tiếp được phép trước khi deny. */
  maxNetworkErrors: number
  retryDelayMs: number
  fetch?: typeof fetch
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): PermissionConfig {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v)
    return v && Number.isFinite(n) && n > 0 ? n : d
  }
  return {
    taskId: env.TASKBOARD_TASK_ID || undefined,
    port: num(env.TASKBOARD_PORT, 3001),
    token: env.TASKBOARD_TOKEN || undefined,
    timeoutMs: num(env.TASKBOARD_PERMISSION_TIMEOUT_MS, 30 * 60_000),
    requestTimeoutMs: 90_000,
    maxNetworkErrors: 3,
    retryDelayMs: 1_000,
  }
}

const deny = (message: string): PermissionResult => ({ behavior: 'deny', message })

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })

/** Hỏi backend và chờ đến khi có quyết định. Không bao giờ throw, không treo quá timeoutMs. */
export async function requestDecision(
  args: ApproveArgs,
  cfg: PermissionConfig,
  signal?: AbortSignal,
): Promise<PermissionResult> {
  if (!cfg.taskId) return deny('Thiếu TASKBOARD_TASK_ID, không xác định được task để xin quyền.')
  const doFetch = cfg.fetch ?? fetch
  const url = `http://127.0.0.1:${cfg.port}/api/internal/permissions`
  const deadline = Date.now() + cfg.timeoutMs
  let requestId: string | undefined
  let networkErrors = 0
  let lastError = ''

  while (true) {
    if (signal?.aborted) return deny('Yêu cầu xin quyền đã bị hủy.')
    const remaining = deadline - Date.now()
    if (remaining <= 0) return deny(`Hết thời gian chờ duyệt quyền cho ${args.tool_name}.`)

    const timeout = AbortSignal.timeout(Math.min(cfg.requestTimeoutMs, remaining))
    const reqSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (cfg.token) headers['x-taskboard-token'] = cfg.token
      const res = await doFetch(url, {
        method: 'POST',
        headers,
        signal: reqSignal,
        body: JSON.stringify({
          taskId: cfg.taskId,
          toolName: args.tool_name,
          input: args.input,
          toolUseId: args.tool_use_id,
          requestId,
        }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        // 4xx: backend đã từ chối rõ ràng (sai token, task không tồn tại...) → không thử lại.
        if (res.status >= 400 && res.status < 500) {
          return deny(`Backend từ chối yêu cầu xin quyền (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`)
        }
        throw new Error(`HTTP ${res.status}`)
      }
      const body = (await res.json()) as {
        decision?: string
        updatedInput?: Record<string, unknown>
        message?: string
        status?: string
        requestId?: string
      }
      networkErrors = 0
      if (body.decision === 'allow') return { behavior: 'allow', updatedInput: body.updatedInput ?? args.input }
      if (body.decision === 'deny') return deny(body.message || 'Người dùng đã từ chối quyền này.')
      if (body.status === 'pending') {
        if (body.requestId) requestId = body.requestId
        continue
      }
      return deny('Backend trả về phản hồi không hợp lệ cho yêu cầu xin quyền.')
    } catch (err) {
      if (signal?.aborted) return deny('Yêu cầu xin quyền đã bị hủy.')
      // Hết thời gian một lần gọi (backend giữ kết nối quá lâu) không tính là mất kết nối.
      if (timeout.aborted) continue
      networkErrors++
      lastError = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)
      if (networkErrors >= cfg.maxNetworkErrors) {
        return deny(`Mất kết nối tới backend Task Board (${lastError}), từ chối ${args.tool_name} để an toàn.`)
      }
      await sleep(Math.min(cfg.retryDelayMs, Math.max(0, deadline - Date.now())), signal)
    }
  }
}

export function createPermissionServer(cfg: PermissionConfig): McpServer {
  const server = new McpServer({ name: 'taskboard', version: '0.1.0' })
  server.registerTool(
    'approve',
    {
      description: 'Xin quyền chạy tool từ người dùng qua Claude Task Board',
      inputSchema: {
        tool_name: z.string(),
        input: z.record(z.string(), z.unknown()),
        tool_use_id: z.string().optional(),
      },
    },
    async (args, extra) => {
      const result = await requestDecision(args, cfg, extra.signal)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  )
  return server
}

async function main() {
  const cfg = configFromEnv()
  if (!cfg.taskId) process.stderr.write('[taskboard-mcp] Cảnh báo: thiếu TASKBOARD_TASK_ID, mọi yêu cầu sẽ bị từ chối\n')
  await createPermissionServer(cfg).connect(new StdioServerTransport())
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`[taskboard-mcp] ${err instanceof Error ? err.stack : String(err)}\n`)
    process.exit(1)
  })
}
