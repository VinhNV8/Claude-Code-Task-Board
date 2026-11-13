// Tìm Claude Code CLI đi kèm extension Claude Code của VS Code / Cursor / Windsurf (thư mục extensions trong home).
// Bản VS Code extension của Task Board thay module này bằng vscode-extension/src/stubs/claudeEditorScan.ts:
// ở đó extension tự lấy đường dẫn qua API vscode.extensions rồi truyền CLAUDE_BIN cho server.
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function compareVersions(a: string, b: string) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

export function fromVscodeExtensions(): string | undefined {
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
