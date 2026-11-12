// Quy tắc cho phép của project (PLAN 3.4, FR-42/FR-61), cùng cú pháp với `--allowedTools` của Claude Code:
//   `Read`              mọi lần gọi tool Read
//   `Bash(npm test)`    đúng lệnh `npm test`
//   `Bash(npm test:*)`  mọi lệnh bắt đầu bằng `npm test`
// Hàm thuần, không đụng DB, để test được độc lập.

type Input = Record<string, unknown>

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

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

function parseRule(rule: string): { tool: string; pattern?: string } {
  const m = rule.trim().match(/^([\w-]+)\((.*)\)$/s)
  return m ? { tool: m[1], pattern: m[2] } : { tool: rule.trim() }
}

function matchPattern(pattern: string, value: string) {
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2)
    // `npm test:*` khớp `npm test` và `npm test -- x`, không khớp `npm testing`
    return value === prefix || value.startsWith(prefix + ' ')
  }
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1))
  return value === pattern
}

/** Lần gọi tool có khớp một quy tắc trong danh sách không. Lệnh Bash ghép phải khớp ở MỌI lệnh con. */
export function matchesAllowed(rules: string[], tool: string, input: Input): boolean {
  const parsed = rules.map(parseRule).filter((r) => r.tool === tool)
  if (!parsed.length) return false
  if (parsed.some((r) => r.pattern === undefined || r.pattern === '*')) return true

  if (tool === 'Bash') {
    const cmd = str(input.command)?.trim()
    if (!cmd || isRiskyShell(cmd)) return false
    const parts = splitCommand(cmd)
    return parts.length > 0 && parts.every((part) => parsed.some((r) => matchPattern(r.pattern!, part)))
  }
  const value = describeInput(tool, input)
  return parsed.some((r) => matchPattern(r.pattern!, value))
}

/** Từ có dạng tên lệnh con (`status`, `install`, `run`), không phải cờ hay đường dẫn. */
const isSubcommand = (w: string | undefined) => !!w && /^[a-z][\w:-]*$/i.test(w)

const MULTI_COMMAND = new Set([
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'dotnet', 'docker', 'gh', 'cargo', 'go', 'pip', 'python', 'kubectl', 'az', 'aws',
])

/** Quy tắc thêm vào project khi bấm "Luôn cho phép". */
export function rulesFor(tool: string, input: Input): string[] {
  if (tool !== 'Bash') return [tool]
  const cmd = str(input.command)?.trim()
  if (!cmd) return []
  const rules = splitCommand(cmd).map((part) => {
    const words = part.split(/\s+/)
    if (isSubcommand(words[1])) return `Bash(${words[0]} ${words[1]}:*)`
    // Công cụ nhiều lệnh con mà không xác định được lệnh con (`git --version`, `git -C x push`):
    // chỉ cho đúng lệnh này, tránh sinh `Bash(git:*)` cho phép cả `git push`.
    if (MULTI_COMMAND.has(words[0]) && words.length > 1) return `Bash(${part})`
    return `Bash(${words[0]}:*)`
  })
  return [...new Set(rules)]
}
