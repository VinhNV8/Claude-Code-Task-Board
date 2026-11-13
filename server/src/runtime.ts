// Môi trường chạy của server: bản dev/npm (tsx + Node của máy) hay bản đóng gói trong extension VS Code.
// Bản đóng gói: server là file .mjs đã bundle, chạy bằng file thực thi của VS Code (Electron) với ELECTRON_RUN_AS_NODE=1,
// nên người dùng không cần cài Node. Các script phụ (MCP permission, hook) cũng chạy bằng chính file đó.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Thư mục chứa các script đã bundle (permission.mjs, notification.mjs). Không đặt: bản dev chạy .ts qua tsx. */
export const bundleDir = (env: NodeJS.ProcessEnv = process.env) => env.TASKBOARD_BUNDLE_DIR || undefined

/** Server đang chạy bằng file thực thi Electron (VS Code, Cursor...) thay vì Node. */
export const isElectron = (versions: NodeJS.ProcessVersions = process.versions) => !!versions.electron

/** Biến môi trường cần cho tiến trình con chạy script bằng chính file thực thi của server. */
export function nodeEnv(versions: NodeJS.ProcessVersions = process.versions): Record<string, string> {
  return isElectron(versions) ? { ELECTRON_RUN_AS_NODE: '1' } : {}
}

/**
 * Tham số để chạy một script phụ: bản đóng gói chạy thẳng `<bundleDir>/<file>.mjs`,
 * bản dev nạp loader tsx rồi chạy file .ts.
 */
export function scriptArgs(o: { tsScript: string; bundled: string; tsxLoader: () => string; env?: NodeJS.ProcessEnv }) {
  const dir = bundleDir(o.env)
  if (dir) return [join(dir, o.bundled)]
  return ['--import', o.tsxLoader(), o.tsScript]
}

/**
 * Nội dung "node shim": file lệnh gọi file thực thi Electron ở chế độ Node.
 * Dùng cho lệnh hook, vì Claude chạy hook qua shell (không truyền được biến môi trường riêng như MCP config).
 */
export function shimContent(execPath: string, platform: NodeJS.Platform = process.platform) {
  if (platform === 'win32') return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" %*\r\n`
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${execPath.replace(/'/g, `'\\''`)}' "$@"\n`
}

let shim: string | undefined

/**
 * Lệnh "node" cho chuỗi lệnh hook. Node thường: chính process.execPath.
 * Electron: ghi shim vào `<dataDir>/bin/` (một lần mỗi tiến trình) rồi trả đường dẫn shim.
 */
export function nodeCommand(dataDir: string) {
  if (!isElectron()) return process.execPath
  if (shim) return shim
  const dir = join(dataDir, 'bin')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, process.platform === 'win32' ? 'node.cmd' : 'node')
  const content = shimContent(process.execPath)
  let cur: string | undefined
  try {
    cur = readFileSync(file, 'utf8')
  } catch {
    /* chưa có */
  }
  if (cur !== content) writeFileSync(file, content, 'utf8')
  if (process.platform !== 'win32') chmodSync(file, 0o755)
  return (shim = file)
}
