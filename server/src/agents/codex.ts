// Adapter OpenAI Codex qua `codex app-server` (SPEC-MULTI-AGENT M3, P0-SPIKE Codex C1–C15).
// Dò CLI: CODEX_BIN → bản mới nhất trong extension `openai.chatgpt` (VS Code / Cursor / Windsurf) → `codex` trong PATH.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { detectRateLimit } from '../rateLimit.ts'
import { MISSING_THREAD, createCodexDriver } from './codexDriver.ts'
import { clearAgentLimit, setAgentLimit } from './limits.ts'
import type { AgentAdapter, AgentBin, PreparedRun } from './types.ts'

const EXE = process.platform === 'win32' ? 'codex.exe' : 'codex'

function compareVersions(a: string, b: string) {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** `openai.chatgpt-<version>[-<platform>]/bin/<platform>/codex(.exe)` trong thư mục extensions của các editor. */
export function codexFromExtensions(home = homedir()): string | undefined {
  const roots = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf'].map((d) => join(home, d, 'extensions'))
  const found: { version: string; path: string }[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const dir of readdirSync(root)) {
      const m = dir.match(/^openai\.chatgpt-(\d+\.\d+\.\d+)/)
      if (!m) continue
      const bin = join(root, dir, 'bin')
      if (!existsSync(bin)) continue
      for (const plat of readdirSync(bin)) {
        const p = join(bin, plat, EXE)
        if (existsSync(p)) found.push({ version: m[1], path: p })
      }
    }
  }
  found.sort((a, b) => compareVersions(b.version, a.version))
  return found[0]?.path
}

function fromPath(): string | undefined {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split(/\r?\n/).find(Boolean)
  } catch {
    return undefined
  }
}

let cached: AgentBin | null | undefined
let checkedAt = 0
const RECHECK_MISSING_MS = 10_000

export function findCodexBin(refresh = false): AgentBin | null {
  const fresh = cached ? existsSync(cached.path) : cached === null && Date.now() - checkedAt < RECHECK_MISSING_MS
  if (cached !== undefined && !refresh && fresh) return cached
  checkedAt = Date.now()
  let bin: AgentBin | null = null
  if (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)) bin = { path: process.env.CODEX_BIN, source: 'env' }
  else {
    const ext = codexFromExtensions()
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
 * Môi trường cho Codex: chỉ dùng phiên đăng nhập của CLI (`codex login`, SPEC-MULTI-AGENT QA3).
 * Bỏ key của mọi nhà cung cấp để không tính tiền nhầm tài khoản và không lộ key cho lệnh Codex chạy (R4).
 */
export function codexEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'TASKBOARD_ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'CURSOR_API_KEY'])
    delete env[k]
  return env
}

const AUTH_RE = /\b(not (logged|signed) in|log ?in required|unauthori[sz]ed|401|authentication|codex login)\b/i

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  name: 'Codex',
  label: 'OpenAI Codex',
  capabilities: {
    interactivePermission: true,
    askUser: true,
    resume: true,
    costUsd: false,
    hardBudget: false,
    permissionModes: ['manual', 'acceptEdits', 'auto', 'plan'],
  },
  findBin: (refresh) => findCodexBin(refresh),
  missingBinReason:
    'Không tìm thấy Codex CLI. Cài extension "Codex – OpenAI" cho VS Code (có sẵn CLI) hoặc cài `codex`, rồi chạy `codex login`; có thể chỉ định đường dẫn bằng biến môi trường CODEX_BIN.',
  prepare: (o): PreparedRun => ({
    ok: true,
    args: ['app-server'],
    env: codexEnv({ TASKBOARD_TASK_ID: String(o.task.id) }),
    cleanup: () => {},
  }),
  // Không dùng: Codex chạy qua driver hai chiều
  createParser: () => ({ parseLine: () => ({ events: [] }) }),
  createDriver: (ctx) =>
    createCodexDriver(ctx, {
      clientVersion: '0.1',
      // Chỉ để test rút ngắn thời gian chờ watchdog
      fileChangeTimeoutMs: Number(process.env.TASKBOARD_CODEX_WATCHDOG_MS) || undefined,
    }),
  isMissingSession: (o) => !!o.result?.isError && (o.result.text ?? '').startsWith(MISSING_THREAD),
  detectRateLimit: (o) => detectRateLimit(o),
  // Ngắt mạch (FR-99): Codex hết lượt → task kế tiếp đi thẳng sang agent dự phòng tới giờ reset.
  onSuccess: () => clearAgentLimit('codex'),
  onRateLimit: (hit) => setAgentLimit('codex', hit),
  failureHint: (o) =>
    AUTH_RE.test(`${o.result?.text ?? ''} ${o.stderr ?? ''}`) ? 'Codex chưa đăng nhập hoặc phiên đăng nhập đã hết hạn: chạy `codex login`.' : undefined,
}
