// Cấu hình hooks của Claude Code cho mỗi run (PLAN 3.6).
// Mỗi run ghi một file settings tạm `data/runs/<runId>.settings.json` khai báo hook `Notification`
// chạy script node `server/src/hooks/notification.ts`, rồi chạy Claude với `--settings <file>`.
// File được xoá khi run kết thúc; file còn sót (server tắt đột ngột) được dọn khi khởi động.
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveTsxLoader } from './permissionTool.ts'
import { scriptArgs } from './runtime.ts'

export const SETTINGS_SUFFIX = '.settings.json'
export const NOTIFICATION_HOOK_SCRIPT = join(import.meta.dirname, 'hooks', 'notification.ts')

export interface HookOptions {
  port: number
  token: string
  taskId: number
  /** File thực thi node (mặc định process.execPath; bản đóng gói trong VS Code: node shim, xem runtime.ts). */
  nodePath?: string
  /** URL file của loader tsx (mặc định resolve từ node_modules của server). */
  tsxLoader?: string
  /** Đường dẫn tuyệt đối tới script hook. */
  scriptPath?: string
  platform?: NodeJS.Platform
}

/**
 * Quote một tham số cho chuỗi lệnh hook. Claude chạy hook qua shell (Git Bash hoặc cmd trên Windows,
 * sh trên Linux/macOS) nên phải chịu được dấu cách trong đường dẫn.
 * - Windows: đổi `\` thành `/` (node chấp nhận) rồi bọc dấu nháy kép — hợp lệ với cả bash lẫn cmd.
 * - POSIX: bọc nháy đơn, escape nháy đơn bên trong.
 */
export function quoteArg(arg: string, platform: NodeJS.Platform = process.platform) {
  if (platform === 'win32') return `"${arg.replace(/\\/g, '/').replace(/"/g, '')}"`
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function buildNotificationCommand(o: HookOptions) {
  const platform = o.platform ?? process.platform
  const parts = [
    o.nodePath ?? process.execPath,
    ...(o.tsxLoader || o.scriptPath
      ? ['--import', o.tsxLoader ?? resolveTsxLoader(), o.scriptPath ?? NOTIFICATION_HOOK_SCRIPT]
      : scriptArgs({ tsScript: NOTIFICATION_HOOK_SCRIPT, bundled: 'notification.mjs', tsxLoader: resolveTsxLoader })),
    '--port',
    String(o.port),
    '--token',
    o.token,
    '--task',
    String(o.taskId),
  ]
  return parts.map((p) => quoteArg(p, platform)).join(' ')
}

/** Nội dung file `--settings`: chỉ thêm hook, các thiết lập khác của người dùng vẫn được Claude gộp như thường. */
export function buildHookSettings(o: HookOptions) {
  return {
    hooks: {
      Notification: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: buildNotificationCommand(o), timeout: 10 }],
        },
      ],
    },
  }
}

export const hookSettingsPath = (dir: string, runId: string) => join(dir, `${runId}${SETTINGS_SUFFIX}`)

export function writeHookSettings(dir: string, runId: string, o: HookOptions) {
  const file = hookSettingsPath(dir, runId)
  writeFileSync(file, JSON.stringify(buildHookSettings(o), null, 2), { encoding: 'utf8', mode: 0o600 })
  return file
}

export function removeHookSettings(file: string | undefined) {
  if (!file) return
  try {
    rmSync(file, { force: true })
  } catch {
    /* file đang bị khóa: lần khởi động sau sẽ dọn */
  }
}

/** Dọn file settings tạm còn sót (server tắt đột ngột khi task đang chạy). */
export function cleanupHookSettings(dir: string) {
  let n = 0
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(SETTINGS_SUFFIX)) continue
      removeHookSettings(join(dir, f))
      n++
    }
  } catch {
    /* thư mục chưa tồn tại */
  }
  return n
}

/** Nội dung dòng log `system` cho một thông báo từ Claude. */
export function formatNotification(n: { message: string; title?: string }) {
  const title = n.title?.trim()
  return `Thông báo từ Claude${title ? ` (${title})` : ''}: ${n.message.trim()}`
}
