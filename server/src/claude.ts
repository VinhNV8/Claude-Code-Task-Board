// Dò file chạy Claude Code CLI (xem docs/P0-SPIKE.md, D1).
// Thứ tự: biến CLAUDE_BIN → bản extension VSCode mới nhất → `claude` trong PATH.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fromVscodeExtensions } from './claudeEditorScan.ts'

export interface ClaudeBin {
  path: string
  source: 'env' | 'vscode-extension' | 'path'
  version?: string
}

function fromPath(): string | undefined {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(cmd, ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split(/\r?\n/).find(Boolean)
  } catch {
    return undefined
  }
}

let cached: ClaudeBin | null | undefined
let checkedAt = 0
/** Chưa tìm thấy CLI: dò lại sau khoảng này (người dùng có thể vừa cài extension Claude Code). */
const RECHECK_MISSING_MS = 10_000

export function findClaudeBin(refresh = false): ClaudeBin | null {
  // Bản cũ của extension Claude Code bị gỡ khi cập nhật: đường dẫn đã lưu không còn thì dò lại
  const fresh = cached ? existsSync(cached.path) : cached === null && Date.now() - checkedAt < RECHECK_MISSING_MS
  if (cached !== undefined && !refresh && fresh) return cached
  checkedAt = Date.now()
  let bin: ClaudeBin | null = null
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) bin = { path: process.env.CLAUDE_BIN, source: 'env' }
  else {
    const ext = fromVscodeExtensions()
    if (ext) bin = { path: ext, source: 'vscode-extension' }
    else {
      const p = fromPath()
      if (p) bin = { path: p, source: 'path' }
    }
  }
  if (bin) {
    try {
      bin.version = execFileSync(bin.path, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim()
    } catch {
      /* để trống version */
    }
  }
  cached = bin
  return bin
}

/**
 * Môi trường cho tiến trình con.
 * Không có apiKey (chế độ subscription): bỏ mọi API key/token để CLI dùng phiên đăng nhập Claude Code trên máy.
 * Có apiKey (chế độ API key): CLI dùng đúng key này. Key/token khác có sẵn trong môi trường luôn bị bỏ,
 * để không vô tình tính tiền vào một tài khoản khác.
 */
export function claudeEnv(extra: Record<string, string> = {}, o: { apiKey?: string } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.TASKBOARD_ANTHROPIC_API_KEY // không lộ key của Task Board sang tiến trình Claude và các lệnh nó chạy
  if (o.apiKey) env.ANTHROPIC_API_KEY = o.apiKey
  return env
}
