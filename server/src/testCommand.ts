// Chạy lệnh test của project (FR-34) mà không qua shell: tách lệnh thành mảng tham số,
// tìm file thực thi trong PATH, và chỉ khi đó là .cmd/.bat (npm, yarn, pnpm trên Windows) mới gọi qua cmd.exe
// với từng tham số được escape (cách làm của cross-spawn) để đường dẫn có dấu cách vẫn chạy đúng.
import { spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

export class TestCommandError extends Error {}

/** Giữ tối đa chừng này ký tự output cuối cùng (phần đầu bị cắt bớt). */
export const MAX_OUTPUT = 256 * 1024

const SHELL_CHARS = new Set(['&', '|', '<', '>', ';', '`'])

/**
 * Tách chuỗi lệnh thành argv. Hỗ trợ "..." và '...' cho tham số có dấu cách.
 * Không có shell nên không hỗ trợ toán tử (&&, |, >, ;): báo lỗi để người dùng chuyển sang script trong package.json.
 */
export function parseCommand(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur)
      cur = ''
      has = false
    } else if (SHELL_CHARS.has(ch)) {
      throw new TestCommandError(
        `Lệnh test không được chứa toán tử shell (${ch}). Hãy gộp các bước vào một script, ví dụ "npm run test:ci" hoặc "npm it".`,
      )
    } else {
      cur += ch
      has = true
    }
  }
  if (quote) throw new TestCommandError('Lệnh test thiếu dấu đóng ngoặc')
  if (has) out.push(cur)
  if (out.length === 0) throw new TestCommandError('Lệnh test trống')
  return out
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Đọc biến môi trường không phân biệt hoa thường (Windows dùng `Path`). */
function envVar(env: NodeJS.ProcessEnv, name: string) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name)
  return key ? env[key] : undefined
}

export interface ResolveOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  isFile?: (p: string) => boolean
}

/**
 * Tìm đường dẫn file thực thi. Windows: tìm theo PATH + PATHEXT; không tìm trong thư mục hiện tại
 * (worktree do Claude sửa, tránh chạy nhầm npm.cmd nằm trong repo). Trả null nếu không thấy.
 */
export function resolveExecutable(name: string, o: ResolveOptions): string | null {
  const platform = o.platform ?? process.platform
  const env = o.env ?? process.env
  const exists = o.isFile ?? isFile
  const hasDir = /[\\/]/.test(name)
  if (platform !== 'win32') {
    if (hasDir) {
      const p = posix.resolve(o.cwd, name)
      return exists(p) ? p : null
    }
    const dirs = (envVar(env, 'PATH') ?? '').split(':').filter(Boolean)
    return dirs.map((d) => posix.join(d, name)).find(exists) ?? null
  }
  const exts = (envVar(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
  const hasExt = exts.includes(win32.extname(name).toLowerCase())
  const dirs = hasDir ? [o.cwd] : (envVar(env, 'PATH') ?? '').split(';').filter(Boolean)
  for (const dir of dirs) {
    const base = win32.resolve(dir.replace(/^"(.*)"$/, '$1'), name)
    const candidates = hasExt ? [base] : exts.map((e) => base + e)
    for (const c of candidates) if (exists(c)) return c
  }
  return null
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/** Escape tên lệnh cho cmd.exe. */
export const escapeCmdCommand = (s: string) => s.replace(CMD_META, '^$1')

/** Escape một tham số cho cmd.exe /s /c "..." (quote theo quy tắc CommandLineToArgvW rồi escape ký tự đặc biệt của cmd). */
export function escapeCmdArg(arg: string) {
  let a = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  a = a.replace(/(?=(\\+?)?)\1$/, '$1$1')
  return `"${a}"`.replace(CMD_META, '^$1')
}

export interface SpawnSpec {
  file: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

/** argv đã resolve → cách gọi spawn. Chỉ .cmd/.bat trên Windows mới đi qua cmd.exe. */
export function buildSpawn(argv: string[], resolved: string, platform: NodeJS.Platform = process.platform, comspec = 'cmd.exe'): SpawnSpec {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    const line = [escapeCmdCommand(win32.normalize(resolved)), ...argv.slice(1).map(escapeCmdArg)].join(' ')
    return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true }
  }
  return { file: resolved, args: argv.slice(1) }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
// eslint-disable-next-line no-control-regex
const PARTIAL_TAIL = /(?:\r|\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*)?)$/

/**
 * Chuẩn hoá output theo từng luồng: bỏ mã màu ANSI, đổi CRLF/CR thành LF.
 * Giữ lại phần cuối chưa trọn (CR hoặc escape bị cắt giữa hai chunk) để ghép với chunk sau.
 */
export class OutputNormalizer {
  private carry = ''
  push(chunk: string) {
    let s = this.carry + chunk
    const m = PARTIAL_TAIL.exec(s)
    this.carry = m ? m[0] : ''
    if (m) s = s.slice(0, m.index)
    return s.replace(ANSI, '').replace(/\r\n?/g, '\n')
  }
  flush() {
    const s = this.carry.startsWith('\r') ? '\n' : ''
    this.carry = ''
    return s
  }
}

/** Lưu phần cuối của output; `end` = tổng số ký tự đã nhận (offset cho WS). */
export class OutputTail {
  text = ''
  end = 0
  constructor(private max = MAX_OUTPUT) {}
  push(s: string) {
    if (!s) return
    this.end += s.length
    this.text += s
    if (this.text.length > this.max) this.text = this.text.slice(-this.max)
  }
  snapshot() {
    return { text: this.text, end: this.end }
  }
}

export interface LaunchOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

/**
 * Chạy lệnh test. Ném TestCommandError nếu lệnh không hợp lệ hoặc không tìm thấy (đồng bộ, trước khi spawn).
 * `onOutput` nhận output đã chuẩn hoá của cả stdout và stderr; `onExit` được gọi đúng một lần.
 */
export function launch(
  command: string,
  o: LaunchOptions,
  onOutput: (s: string) => void,
  onExit: (code: number | null, error?: string) => void,
): ChildProcess {
  const platform = o.platform ?? process.platform
  const env = { ...(o.env ?? process.env), CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }
  const argv = parseCommand(command)
  const resolved = resolveExecutable(argv[0], { cwd: o.cwd, env, platform })
  if (!resolved) throw new TestCommandError(`Không tìm thấy lệnh "${argv[0]}" trong PATH của server`)
  const spec = buildSpawn(argv, resolved, platform, envVar(env, 'COMSPEC') ?? 'cmd.exe')

  const child = spawn(spec.file, spec.args, {
    cwd: o.cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  })
  let done = false
  let error: string | undefined
  const end = (code: number | null) => {
    if (done) return
    done = true
    for (const n of norms) {
      const rest = n.flush()
      if (rest) onOutput(rest)
    }
    onExit(code, error)
  }
  const norms = [child.stdout, child.stderr].map((stream) => {
    const n = new OutputNormalizer()
    stream?.setEncoding('utf8')
    stream?.on('data', (d: string) => {
      const s = n.push(d)
      if (s) onOutput(s)
    })
    return n
  })
  child.on('error', (err) => {
    error = `Không chạy được lệnh test: ${err.message}`
    if (child.pid === undefined) end(null) // không khởi động được: có thể không có sự kiện close
  })
  child.on('close', (code) => end(code))
  return child
}
