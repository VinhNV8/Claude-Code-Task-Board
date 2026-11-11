// Dò file chạy Claude Code CLI (xem docs/P0-SPIKE.md, D1).
// Thứ tự: biến CLAUDE_BIN → bản extension VSCode mới nhất → `claude` trong PATH.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ClaudeBin {
  path: string
  source: 'env' | 'vscode-extension' | 'path'
  version?: string
}

function compareVersions(a: string, b: string) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

function fromVscodeExtensions(): string | undefined {
  const exeName = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const roots = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf'].map((d) => join(homedir(), d, 'extensions'))
  const found: { version: string; path: string }[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const dir of readdirSync(root)) {
      const m = dir.match(/^anthropic\.claude-code-(\d+\.\d+\.\d+)/)
      if (!m) continue
      const p = join(root, dir, 'resources', 'native-binary', exeName)
      if (existsSync(p)) found.push({ version: m[1], path: p })
    }
  }
  found.sort((a, b) => compareVersions(b.version, a.version))
  return found[0]?.path
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

export function findClaudeBin(refresh = false): ClaudeBin | null {
  if (cached !== undefined && !refresh) return cached
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

/** Môi trường cho tiến trình con: bỏ API key để luôn dùng phiên đăng nhập Claude Code (ràng buộc C1). */
export function claudeEnv(extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}
