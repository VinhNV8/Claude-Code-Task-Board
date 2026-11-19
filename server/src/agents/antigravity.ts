// Adapter Google Antigravity qua `agy acp` (SPEC-MULTI-AGENT M5, P0-SPIKE Antigravity G1–G14).
// Dò CLI: AGY_BIN → ~/.gemini/bin/agy(.exe) → `agy` trong PATH.
// Cấu hình riêng của Task Board ở ~/.gemini/taskboard-agy/ (GD3): `toolPermission: strict` để agy hỏi trước mọi thao tác
// (mode `default` không hỏi trước khi sửa file trong workspace, G6); thư mục cố định để resume được (lịch sử hội thoại nằm ở đó).
// Không đụng ~/.gemini/antigravity-cli/ (cấu hình của người dùng).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { detectRateLimit } from '../rateLimit.ts'
import { MISSING_SESSION, createAntigravityDriver } from './antigravityDriver.ts'
import { clearAgentLimit, setAgentLimit } from './limits.ts'
import type { AgentAdapter, AgentBin, PreparedRun } from './types.ts'

const EXE = process.platform === 'win32' ? 'agy.exe' : 'agy'
/** Tên thư mục dữ liệu riêng, truyền cho `--app-data-dir` (agy chỉ nhận đường dẫn tương đối, tính từ ~/.gemini, G7). */
export const AGY_APP_DIR = 'taskboard-agy'
export const AGY_SETTINGS = { toolPermission: 'strict' }

function fromPath(): string | undefined {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['agy'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split(/\r?\n/).find(Boolean)
  } catch {
    return undefined
  }
}

let cached: AgentBin | null | undefined
let checkedAt = 0
const RECHECK_MISSING_MS = 10_000

export function findAgyBin(refresh = false, home = homedir()): AgentBin | null {
  const fresh = cached ? existsSync(cached.path) : cached === null && Date.now() - checkedAt < RECHECK_MISSING_MS
  if (cached !== undefined && !refresh && fresh) return cached
  checkedAt = Date.now()
  let bin: AgentBin | null = null
  const local = join(home, '.gemini', 'bin', EXE)
  if (process.env.AGY_BIN && existsSync(process.env.AGY_BIN)) bin = { path: process.env.AGY_BIN, source: 'env' }
  else if (existsSync(local)) bin = { path: local, source: 'gemini-bin' }
  else {
    const p = fromPath()
    if (p) bin = { path: p, source: 'path' }
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

/** Tạo / sửa ~/.gemini/taskboard-agy/settings.json cho đúng `toolPermission: strict` (giữ các khoá khác nếu có). */
export function ensureAgySettings(home = homedir()): string {
  const dir = join(home, '.gemini', AGY_APP_DIR)
  const file = join(dir, 'settings.json')
  mkdirSync(dir, { recursive: true })
  let cur: Record<string, unknown> = {}
  try {
    cur = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    /* chưa có hoặc hỏng: ghi mới */
  }
  if (cur.toolPermission !== AGY_SETTINGS.toolPermission) writeFileSync(file, `${JSON.stringify({ ...cur, ...AGY_SETTINGS }, null, 2)}\n`)
  return file
}

/** Môi trường cho agy: chỉ dùng phiên đăng nhập Google của CLI (QA3); bỏ key của mọi nhà cung cấp (R4). */
export function agyEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'TASKBOARD_ANTHROPIC_API_KEY', 'CURSOR_API_KEY'])
    delete env[k]
  return env
}

const QUOTA_RE = /RESOURCE_EXHAUSTED|quota (exceeded|exhausted)|exceeded your (current )?quota/i
const AUTH_RE = /\b(not (logged|signed) in|log ?in required|unauthenticated|unauthori[sz]ed|401|authentication|oauth)\b/i

export const antigravityAdapter: AgentAdapter = {
  id: 'antigravity',
  name: 'Antigravity',
  label: 'Google Antigravity',
  capabilities: {
    interactivePermission: true,
    askUser: false,
    resume: true,
    costUsd: false,
    hardBudget: false,
    permissionModes: ['manual', 'acceptEdits', 'auto', 'plan'],
  },
  findBin: (refresh) => findAgyBin(refresh),
  missingBinReason:
    'Không tìm thấy Antigravity CLI (agy). Cài Antigravity CLI rồi đăng nhập một lần bằng `agy`; có thể chỉ định đường dẫn bằng biến môi trường AGY_BIN.',
  prepare: (o): PreparedRun => {
    try {
      ensureAgySettings()
    } catch (err) {
      return { ok: false, error: `Không ghi được cấu hình Antigravity cho Task Board (~/.gemini/${AGY_APP_DIR}): ${(err as Error).message}` }
    }
    return { ok: true, args: ['acp', '--app-data-dir', AGY_APP_DIR], env: agyEnv({ TASKBOARD_TASK_ID: String(o.task.id) }), cleanup: () => {} }
  },
  createParser: () => ({ parseLine: () => ({ events: [] }) }),
  createDriver: (ctx) => createAntigravityDriver(ctx, { clientVersion: '0.1' }),
  isMissingSession: (o) => !!o.result?.isError && (o.result.text ?? '').startsWith(MISSING_SESSION),
  detectRateLimit: (o) => {
    const hit = detectRateLimit(o)
    if (hit) return hit
    const text = `${o.result?.isError ? o.result.text : ''} ${o.stderr ?? ''}`
    return QUOTA_RE.test(text) ? {} : undefined
  },
  onSuccess: () => clearAgentLimit('antigravity'),
  onRateLimit: (hit) => setAgentLimit('antigravity', hit),
  failureHint: (o) =>
    AUTH_RE.test(`${o.result?.text ?? ''} ${o.stderr ?? ''}`) ? 'Antigravity chưa đăng nhập hoặc phiên đã hết hạn: chạy `agy` một lần để đăng nhập Google.' : undefined,
}
