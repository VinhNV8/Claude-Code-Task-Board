// Quy tắc cho phép của project (PLAN 3.4, FR-42/FR-61), cùng cú pháp với `--allowedTools` của Claude Code:
//   `Read`                 mọi lần gọi tool Read (và Glob/Grep: tool đọc file)
//   `Edit`                 mọi tool sửa file: Edit, MultiEdit, Write, NotebookEdit
//   `Bash(npm test)`       đúng lệnh `npm test`
//   `Bash(npm test:*)`     `npm test` và mọi lệnh bắt đầu bằng `npm test ` (dạng mới: `Bash(npm test *)`)
//   `Bash(git * main)`     `*` ở giữa khớp chuỗi bất kỳ
//   `Edit(src/**)`         đường dẫn kiểu gitignore, tương đối với thư mục làm việc của task
//   `Read(//c/secrets/*)`  `//` = đường dẫn tuyệt đối (Windows: `C:\x` viết thành `/c/x`), `~/` = thư mục home
//   `WebFetch(domain:docs.example.com)`  theo tên miền
//   `mcp__github` hoặc `mcp__github__*`  mọi tool của MCP server `github`
// Hàm thuần, không đụng DB, để test được độc lập.
import { homedir } from 'node:os'
import { posix } from 'node:path'

type Input = Record<string, unknown>

export interface MatchOptions {
  /** Thư mục làm việc của task (worktree), gốc của quy tắc đường dẫn tương đối. */
  cwd?: string
  home?: string
  /** So khớp đường dẫn không phân biệt hoa thường. Mặc định: true trên Windows. */
  caseInsensitive?: boolean
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'])
/** Tool mà quy tắc có tham số là đường dẫn file. */
const PATH_TOOLS = new Set([...EDIT_TOOLS, ...READ_TOOLS])

/** Chuỗi hiển thị cho người duyệt (và dùng để so khớp quy tắc). */
export function describeInput(tool: string, input: Input): string {
  const s =
    tool === 'Bash'
      ? str(input.command)
      : str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? str(input.url) ?? str(input.pattern)
  return (s ?? JSON.stringify(input)).slice(0, 4000)
}

/** Tách lệnh ghép (`a && b | c; d`) thành từng lệnh con, như Claude Code kiểm tra từng phần. */
export function splitCommand(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||[;|\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
}

/**
 * Lệnh có cấu trúc khó đoán (thế lệnh, ghi file bằng redirect) thì không tự cho phép theo tiền tố,
 * luôn hỏi người dùng. Bỏ qua các redirect vô hại thường gặp.
 */
export function isRiskyShell(cmd: string): boolean {
  const cleaned = cmd.replace(/\d?>&\d/g, '').replace(/\d?>\s*\/dev\/null/g, '').replace(/\d?>\s*NUL\b/gi, '')
  return /\$\(|`|>|<\(/.test(cleaned)
}

export function parseRule(rule: string): { tool: string; pattern?: string } {
  const m = rule.trim().match(/^([\w-]+)\((.*)\)$/s)
  return m ? { tool: m[1], pattern: m[2] } : { tool: rule.trim() }
}

/** Quy tắc của `ruleTool` có áp dụng cho lần gọi `tool` không. */
function covers(ruleTool: string, tool: string): boolean {
  if (ruleTool === tool) return true
  if (ruleTool === 'Edit') return EDIT_TOOLS.has(tool)
  if (ruleTool === 'Read') return READ_TOOLS.has(tool)
  if (ruleTool.startsWith('mcp__') && tool.startsWith('mcp__')) {
    const server = ruleTool.replace(/__\*$/, '')
    return server.split('__').length === 2 && tool.startsWith(server + '__')
  }
  return false
}

const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\?*]/g, '\\$&')

/** Glob → regex. `path`: `*` không vượt qua `/`, `**` khớp nhiều cấp thư mục, `?` một ký tự. */
function globToRe(glob: string, path: boolean): string {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (path && glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += path ? '[^/]*' : '.*'
    } else if (c === '?' && path) re += '[^/]'
    else re += escapeRe(c)
  }
  return re
}

/** Mẫu lệnh/chuỗi: `:*` hoặc ` *` ở cuối khớp cả lệnh trần lẫn lệnh có thêm tham số; `*` khác khớp chuỗi bất kỳ. */
function matchText(pattern: string, value: string): boolean {
  let p = pattern.endsWith(':*') ? pattern.slice(0, -2) + ' *' : pattern
  let tail = ''
  if (p.endsWith(' *')) {
    p = p.slice(0, -2)
    tail = '(?:\\s.*)?' // `npm test:*` khớp `npm test`, `npm test -- x`, không khớp `npm testing`
  }
  return new RegExp(`^${globToRe(p, false)}${tail}$`, 's').test(value)
}

/** Đường dẫn về dạng POSIX: `C:\a\b` → `/c/a/b`, chuẩn hoá `..`. */
export function toPosixPath(p: string): string {
  let s = p.replace(/\\/g, '/')
  const m = s.match(/^\/?([a-zA-Z]):(\/|$)/)
  if (m) s = `/${m[1].toLowerCase()}/${s.slice(m[0].length)}`
  return posix.normalize(s).replace(/(.)\/+$/, '$1')
}

/** Đường dẫn tuyệt đối (POSIX) mà lần gọi tool chạm tới. Glob/Grep không có `path` = tìm trong cwd. */
function targetPath(tool: string, input: Input, cwd?: string): string | undefined {
  const searchTool = tool === 'Glob' || tool === 'Grep' || tool === 'LS'
  const raw = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? (searchTool ? cwd : undefined)
  if (!raw) return
  const abs = toPosixPath(raw)
  if (abs.startsWith('/')) return abs
  return cwd ? toPosixPath(posix.join(toPosixPath(cwd), abs)) : undefined
}

/** Quy tắc đường dẫn kiểu gitignore. Quy tắc trỏ vào thư mục cũng khớp mọi thứ bên trong. */
function matchPath(pattern: string, target: string, o: MatchOptions): boolean {
  const ci = o.caseInsensitive ?? process.platform === 'win32'
  let full: string
  if (pattern.startsWith('//')) {
    full = toPosixPath(pattern.slice(1))
  } else {
    const rel = pattern.replace(/^\.\//, '').replace(/^\//, '')
    const base = pattern.startsWith('~/') ? o.home ?? homedir() : o.cwd
    if (!base) return false
    const body = pattern.startsWith('~/') ? pattern.slice(2) : rel
    const b = toPosixPath(base)
    // Không có `/` (trừ ở cuối) → khớp ở mọi cấp, như gitignore (`*.env`, `node_modules`)
    const anyDepth = !body.replace(/\/+$/, '').includes('/') && !pattern.startsWith('/') && !pattern.startsWith('~/')
    full = (b === '/' ? '' : b) + '/' + (anyDepth ? '**/' : '') + body.replace(/\/+$/, '')
  }
  const re = new RegExp(`^${globToRe(full, true)}(?:/.*)?$`, ci ? 'is' : 's')
  return re.test(target)
}

function matchHost(pattern: string, url: string | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname.toLowerCase()
    return new RegExp(`^${globToRe(pattern.toLowerCase(), false)}$`).test(host)
  } catch {
    return false
  }
}

/**
 * Lần gọi tool có khớp một quy tắc trong danh sách không.
 * Lệnh Bash ghép phải khớp ở MỌI lệnh con; lệnh có thế lệnh/redirect ghi file không bao giờ khớp theo mẫu.
 */
export function matchesAllowed(rules: string[], tool: string, input: Input, opts: MatchOptions = {}): boolean {
  const parsed = rules.map(parseRule).filter((r) => covers(r.tool, tool))
  if (!parsed.length) return false
  if (parsed.some((r) => r.pattern === undefined || r.pattern === '*')) return true
  const patterns = parsed.map((r) => r.pattern!)

  if (tool === 'Bash') {
    const cmd = str(input.command)?.trim()
    if (!cmd || isRiskyShell(cmd)) return false
    const parts = splitCommand(cmd)
    return parts.length > 0 && parts.every((part) => patterns.some((p) => matchText(p, part)))
  }
  if (PATH_TOOLS.has(tool)) {
    const target = targetPath(tool, input, opts.cwd)
    return !!target && patterns.some((p) => matchPath(p, target, opts))
  }
  if (tool === 'WebFetch') {
    return patterns.some((p) => (p.startsWith('domain:') ? matchHost(p.slice(7), str(input.url)) : matchText(p, str(input.url) ?? '')))
  }
  const value = describeInput(tool, input)
  return patterns.some((p) => matchText(p, value))
}

// ---------------------------------------------------------------- phân loại rủi ro (FR-45, AC-10)

export interface Risk {
  level: 'high' | 'normal'
  /** Lý do (tiếng Việt) hiển thị cho người duyệt, mỗi điều kiện khớp một dòng. */
  reasons: string[]
}

/** Tách lệnh thành từ, giữ nguyên cụm trong ngoặc (`git -C "D:/a b" push` → 4 từ) và bỏ dấu ngoặc. */
const shellWords = (part: string) =>
  (part.match(/(?:"[^"]*"?|'[^']*'?|[^\s"'])+/g) ?? []).map((w) => w.replace(/["']/g, ''))

/** Lệnh `git` → lệnh con và phần tham số sau nó, bỏ qua tuỳ chọn toàn cục (`git -C dir push`). */
function gitSub(words: string[]): { sub?: string; args: string[] } {
  for (let i = 1; i < words.length; i++) {
    const w = words[i]
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(w)) i++
    else if (!w.startsWith('-')) return { sub: w.toLowerCase(), args: words.slice(i + 1) }
  }
  return { args: [] }
}

/**
 * Có cụm cờ ngắn kiểu Unix (`-rf`, `-xdf`) gồm toàn ký tự trong `flags` và chứa `want` không.
 * Giới hạn bộ ký tự để cờ PowerShell (`-Force`) không bị hiểu nhầm thành `-r`.
 */
const shortFlagHas = (args: string[], flags: string, want: RegExp) =>
  args.some((a) => new RegExp(`^-[${flags}]+$`).test(a) && want.test(a))
/** Tham số chỉ cả thư mục: `.`, `./`, `*`, `:/`, `-A`… */
const WHOLE_TREE = new Set(['.', './', '*', ':/', ':', '-A', '--all'])

/** Lý do rủi ro của một lệnh con (đã tách bằng splitCommand). */
function subcommandRisks(part: string): string[] {
  let words = shellWords(part)
  // Bỏ gán biến môi trường đầu lệnh (`FOO=1 git push`)
  while (words.length > 1 && /^[A-Za-z_]\w*=/.test(words[0])) words = words.slice(1)
  const out: string[] = []
  if (words[0]?.toLowerCase() === 'sudo') {
    out.push('Chạy với quyền quản trị (sudo)')
    words = words.slice(1)
    while (words[0]?.startsWith('-')) words = words.slice(1) // `sudo -E rm -rf x`
  }
  const [head = '', ...args] = words
  const cmd = head.toLowerCase().replace(/\.exe$/, '')
  const lowerArgs = args.map((a) => a.toLowerCase())

  switch (cmd) {
    case 'rm':
      // Unix `rm -r/-rf/-fr/-R/--recursive`; trong PowerShell `rm` là alias của Remove-Item (`-Recurse`)
      if (shortFlagHas(args, 'rRfivdI', /r/i) ||lowerArgs.some((a) => a === '--recursive' || /^-rec(u(r(s(e)?)?)?)?$/.test(a)))
        out.push('Xoá đệ quy')
      break
    case 'remove-item':
    case 'ri':
    case 'rd':
    case 'rmdir':
    case 'del':
    case 'erase':
      if (lowerArgs.some((a) => a === '/s' || a === '-r' || /^-rec(u(r(s(e)?)?)?)?(:\$true)?$/.test(a))) out.push('Xoá đệ quy')
      break
    case 'git': {
      const { sub, args: g } = gitSub(words)
      const lg = g.map((a) => a.toLowerCase())
      if (sub === 'push') out.push('Đẩy code lên remote')
      else if (sub === 'reset' && lg.includes('--hard')) out.push('Huỷ mọi thay đổi chưa commit (git reset --hard)')
      else if (sub === 'clean' && (lg.includes('--force') || shortFlagHas(g, 'fdxXnqi', /f/)))
        out.push('Xoá file chưa được git theo dõi (git clean)')
      else if ((sub === 'checkout' || sub === 'restore') && lg.some((a) => WHOLE_TREE.has(a)))
        out.push('Huỷ thay đổi trên toàn thư mục')
      break
    }
    case 'npm':
    case 'pnpm':
    case 'yarn':
      if (lowerArgs[0] === 'publish') out.push('Phát hành package lên registry')
      break
    case 'chmod':
    case 'chown':
      if (args.includes('-R') || lowerArgs.includes('--recursive')) out.push('Đổi quyền file đệ quy')
      break
    case 'format':
      out.push('Định dạng ổ đĩa')
      break
    case 'shutdown':
    case 'reboot':
    case 'stop-computer':
    case 'restart-computer':
      out.push('Tắt hoặc khởi động lại máy')
      break
    case 'reg':
      if (lowerArgs[0] === 'delete') out.push('Xoá khoá registry')
      break
    default:
      if (/^mkfs(\.|$)/.test(cmd)) out.push('Định dạng ổ đĩa')
  }
  return out
}

/** `curl … | sh`, `wget -O- … | bash`, `iwr … | iex`: tải script về rồi chạy ngay. */
const DOWNLOAD_EXEC =
  /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|iex|invoke-expression|pwsh|powershell)\b/i

/** Đường dẫn `target` (POSIX) có nằm trong `base` không. */
function isInside(target: string, base: string, ci: boolean): boolean {
  const t = ci ? target.toLowerCase() : target
  const b = ci ? base.toLowerCase() : base
  return b === '/' || t === b || t.startsWith(b + '/')
}

/**
 * Mức rủi ro của một lần gọi tool. 'high' → luôn phải duyệt tay, không cho "Luôn cho phép"
 * và allowlist không tự cho phép (AC-10). Hàm thuần, không đụng DB.
 */
export function riskOf(tool: string, input: Input, opts: MatchOptions = {}): Risk {
  const reasons: string[] = []
  if (tool === 'Bash') {
    const cmd = str(input.command)?.trim() ?? ''
    if (cmd && isRiskyShell(cmd)) reasons.push('Lệnh có thế lệnh hoặc redirect ghi file')
    if (DOWNLOAD_EXEC.test(cmd)) reasons.push('Tải script từ mạng về và chạy ngay')
    for (const part of splitCommand(cmd)) reasons.push(...subcommandRisks(part))
  } else if (EDIT_TOOLS.has(tool) && opts.cwd) {
    const target = targetPath(tool, input, opts.cwd)
    const ci = opts.caseInsensitive ?? process.platform === 'win32'
    if (target && !isInside(target, toPosixPath(opts.cwd), ci)) reasons.push('Ghi file ngoài thư mục task')
  }
  const unique = [...new Set(reasons)]
  return { level: unique.length ? 'high' : 'normal', reasons: unique }
}

/** Từ có dạng tên lệnh con (`status`, `install`, `run`), không phải cờ hay đường dẫn. */
const isSubcommand = (w: string | undefined) => !!w && /^[a-z][\w:-]*$/i.test(w)

const MULTI_COMMAND = new Set([
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'dotnet', 'docker', 'gh', 'cargo', 'go', 'pip', 'python', 'kubectl', 'az', 'aws',
])

/**
 * Quy tắc thêm vào project khi bấm "Luôn cho phép".
 * Bash: lệnh đầu của mỗi lệnh con + `:*` (kèm lệnh con với công cụ nhiều lệnh con: `npm install:*`, không phải `npm:*`).
 */
export function rulesFor(tool: string, input: Input): string[] {
  if (tool !== 'Bash') return [tool]
  const cmd = str(input.command)?.trim()
  if (!cmd) return []
  const rules = splitCommand(cmd).map((part) => {
    const words = part.split(/\s+/)
    if (!MULTI_COMMAND.has(words[0])) return `Bash(${words[0]}:*)`
    if (isSubcommand(words[1])) return `Bash(${words[0]} ${words[1]}:*)`
    // Công cụ nhiều lệnh con mà không xác định được lệnh con (`git --version`, `git -C x push`):
    // chỉ cho đúng lệnh này, tránh sinh `Bash(git:*)` cho phép cả `git push`.
    return `Bash(${part})`
  })
  return [...new Set(rules)]
}
