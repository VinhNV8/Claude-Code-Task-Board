// Phần logic thuần của extension (không import 'vscode') để test được bằng node:test.
import { createServer } from 'node:net'
import { resolve } from 'node:path'

/** Thông tin server đang chạy, lưu ở `<globalStorage>/server.json` để các cửa sổ VS Code dùng chung một server. */
export interface ServerInfo {
  pid: number
  port: number
  previewPort: number
  /** Phiên bản extension đã khởi động server; khác phiên bản hiện tại thì khởi động lại. */
  version: string
  startedAt: number
}

export function parseServerInfo(text: string | undefined): ServerInfo | undefined {
  if (!text) return undefined
  try {
    const v = JSON.parse(text) as Partial<ServerInfo>
    const okPort = (n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) < 65536
    if (!Number.isInteger(v.pid) || !okPort(v.port) || !okPort(v.previewPort) || typeof v.version !== 'string') return undefined
    return { pid: v.pid!, port: v.port!, previewPort: v.previewPort!, version: v.version, startedAt: Number(v.startedAt) || 0 }
  } catch {
    return undefined
  }
}

export interface ServerEnvOptions {
  port: number
  previewPort: number
  dataDir: string
  webDist: string
  bundleDir: string
  version: string
  idleMinutes: number
  claudePath?: string
  /** Có chạy bằng file thực thi Electron (VS Code) không: cần ELECTRON_RUN_AS_NODE=1. */
  electron: boolean
}

/**
 * Môi trường cho tiến trình server. Bỏ biến nội bộ của VS Code/Electron (IPC, cờ chế độ) để server
 * và Claude không bị lẫn với tiến trình của VS Code; giữ PATH, HOME... để tìm được git và Claude.
 */
export function serverEnv(base: NodeJS.ProcessEnv, o: ServerEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (/^(VSCODE_|ELECTRON_)/i.test(k)) continue
    if (/^(PORT|PREVIEW_PORT|NODE_ENV|CLAUDE_BIN)$/i.test(k) || /^TASKBOARD_/i.test(k)) continue
    env[k] = v
  }
  if (o.electron) env.ELECTRON_RUN_AS_NODE = '1'
  env.NODE_ENV = 'production'
  env.PORT = String(o.port)
  env.PREVIEW_PORT = String(o.previewPort)
  env.TASKBOARD_DATA = o.dataDir
  env.TASKBOARD_WEB_DIST = o.webDist
  env.TASKBOARD_BUNDLE_DIR = o.bundleDir
  env.TASKBOARD_VERSION = o.version
  if (o.idleMinutes > 0) env.TASKBOARD_IDLE_EXIT_MIN = String(o.idleMinutes)
  if (o.claudePath?.trim()) env.CLAUDE_BIN = o.claudePath.trim()
  return env
}

/** So sánh đường dẫn thư mục (Windows: không phân biệt hoa thường, chấp nhận cả / và \). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform) {
  const norm = (p: string) => {
    let r = (platform === 'win32' ? resolve(p).replace(/\//g, '\\') : resolve(p)).replace(/[\\/]+$/, '')
    if (platform === 'win32') r = r.toLowerCase()
    return r
  }
  return norm(a) === norm(b)
}

export interface ClaudeAuthStatus {
  loggedIn: boolean
  authMethod?: string
}

/** Đọc kết quả `claude auth status` (JSON). Không đọc được: undefined (CLI cũ không có lệnh này). */
export function parseAuthStatus(stdout: string): ClaudeAuthStatus | undefined {
  const start = stdout.indexOf('{')
  if (start < 0) return undefined
  try {
    const v = JSON.parse(stdout.slice(start)) as { loggedIn?: unknown; authMethod?: unknown }
    if (typeof v.loggedIn !== 'boolean') return undefined
    return { loggedIn: v.loggedIn, authMethod: typeof v.authMethod === 'string' ? v.authMethod : undefined }
  } catch {
    return undefined
  }
}

/** Nhánh chính khi tự thêm project: ưu tiên main, master, rồi nhánh đang checkout. */
export function pickMainBranch(branches: string[], current?: string) {
  const set = new Set(branches.map((b) => b.trim()).filter(Boolean))
  for (const b of ['main', 'master', 'trunk', 'develop']) if (set.has(b)) return b
  return current?.trim() || [...set][0] || 'main'
}

/** Đường dẫn trong giao diện (HashRouter): bảng công việc, lọc theo project nếu có. */
export function boardHash(projectId?: string, page?: 'settings') {
  if (page === 'settings') return '#/settings'
  return projectId ? `#/?project=${encodeURIComponent(projectId)}` : '#/'
}

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** HTML của webview: một iframe chiếm toàn bộ khung, trỏ tới server cục bộ. Không chạy script nào trong webview. */
export function webviewHtml(src: string) {
  const origin = new URL(src).origin
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escAttr(origin)}; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
  iframe { border: 0; width: 100%; height: 100vh; display: block; }
</style>
</head>
<body>
<iframe src="${escAttr(src)}" title="Task Board" allow="clipboard-read; clipboard-write"></iframe>
</body>
</html>`
}

/** Hỏi hệ điều hành một cổng TCP trống trên 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? res(port) : rej(new Error('Không lấy được cổng trống'))))
    })
  })
}

/** Phần cuối file log để kèm vào thông báo lỗi khởi động. */
export function tail(text: string, lines = 15) {
  return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n')
}
