// Script `apiKeyHelper` của Claude Code (chế độ API key, xem apiKeyBroker.ts).
// Claude CLI chạy lệnh này để lấy key: script hỏi backend rồi in key ra stdout.
//   GET http://127.0.0.1:<port>/api/internal/api-key?task=<id>   header x-taskboard-key-token
// Tham số dòng lệnh: --port <n> --task <id> --token <t>. Lỗi: in lý do ra stderr, thoát mã 1 (CLI báo lỗi xác thực).
import { pathToFileURL } from 'node:url'

export interface KeyHelperConfig {
  port: number
  taskId: string | undefined
  token: string | undefined
}

export function parseArgs(argv: string[]): KeyHelperConfig {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const port = Number(get('port'))
  return { port: Number.isInteger(port) && port > 0 ? port : 0, taskId: get('task'), token: get('token') }
}

export async function fetchKey(c: KeyHelperConfig, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!c.port || !c.taskId || !c.token) throw new Error('Thiếu --port, --task hoặc --token')
  const res = await fetchImpl(`http://127.0.0.1:${c.port}/api/internal/api-key?task=${encodeURIComponent(c.taskId)}`, {
    headers: { 'x-taskboard-key-token': c.token },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Task Board từ chối cấp API key (HTTP ${res.status})`)
  const key = (await res.text()).trim()
  if (!key) throw new Error('Task Board trả về key rỗng')
  return key
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fetchKey(parseArgs(process.argv.slice(2))).then(
    (key) => process.stdout.write(key),
    (e: Error) => {
      process.stderr.write(`apiKeyHelper: ${e.message}\n`)
      process.exit(1)
    },
  )
}
