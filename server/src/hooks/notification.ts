// Hook `Notification` của Claude Code (PLAN 3.6). Claude chạy lệnh này khi muốn báo cho người dùng
// (ví dụ chờ cấp quyền, chờ nhập liệu lâu). Script đọc JSON hook từ stdin rồi POST về backend:
//   POST http://127.0.0.1:<port>/api/hooks/notification   header x-taskboard-token
//   body {taskId, message, title?, notificationType?, sessionId?}
// Tham số dòng lệnh: --port <n> --token <t> [--task <id>]; task id mặc định lấy từ TASKBOARD_TASK_ID.
// Dùng node thuần (fetch) thay vì curl để chạy được trên Windows. Không bao giờ làm hỏng run:
// mọi lỗi chỉ ghi ra stderr và thoát mã 0.
import { pathToFileURL } from 'node:url'

export interface HookConfig {
  taskId: string | undefined
  port: number
  token: string | undefined
  timeoutMs: number
}

export interface NotificationPayload {
  taskId: string
  message: string
  title?: string
  notificationType?: string
  sessionId?: string
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): HookConfig {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const port = Number(get('port') ?? env.TASKBOARD_PORT)
  return {
    taskId: get('task') || env.TASKBOARD_TASK_ID || undefined,
    port: Number.isInteger(port) && port > 0 ? port : 3001,
    token: get('token') || env.TASKBOARD_TOKEN || undefined,
    timeoutMs: 5_000,
  }
}

/** Chuyển JSON hook (stdin) thành payload gửi backend. Trả undefined nếu không có nội dung. */
export function toPayload(raw: string, taskId: string): NotificationPayload | undefined {
  let data: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') data = parsed
  } catch {
    // Không phải JSON: coi toàn bộ là nội dung thông báo
    data = { message: raw }
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const message = str(data.message)
  if (!message) return undefined
  return {
    taskId,
    message,
    title: str(data.title),
    notificationType: str(data.notification_type),
    sessionId: str(data.session_id),
  }
}

/** Gửi thông báo về backend. Không throw; trả về mô tả lỗi (nếu có) để ghi stderr. */
export async function sendNotification(
  p: NotificationPayload,
  cfg: HookConfig,
  doFetch: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (cfg.token) headers['x-taskboard-token'] = cfg.token
    const res = await doFetch(`http://127.0.0.1:${cfg.port}/api/hooks/notification`, {
      method: 'POST',
      headers,
      body: JSON.stringify(p),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    })
    if (!res.ok) return `Backend trả về HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`
    return undefined
  } catch (err) {
    return `Không gửi được thông báo về Task Board: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function readStdin() {
  let raw = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) raw += chunk
  return raw
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2))
  if (!cfg.taskId) {
    process.stderr.write('[taskboard-hook] Thiếu TASKBOARD_TASK_ID, bỏ qua thông báo\n')
    return
  }
  const payload = toPayload(await readStdin(), cfg.taskId)
  if (!payload) return
  const error = await sendNotification(payload, cfg)
  if (error) process.stderr.write(`[taskboard-hook] ${error}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((err) => process.stderr.write(`[taskboard-hook] ${err instanceof Error ? err.message : String(err)}\n`))
    .finally(() => process.exit(0))
}
