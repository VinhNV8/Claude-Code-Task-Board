// Parser diff dạng unified, dùng chung cho giao diện (dữ liệu mẫu) và server (`git diff` thật, PLAN 2.3).
import type { DiffHunk, DiffLine, FileDiff } from '../types.ts'

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Parse phần hunk của patch (1 file) thành cấu trúc hiển thị.
 * Dựa vào số dòng trong header `@@` để biết hunk kết thúc ở đâu, nên dòng trống cuối patch
 * và dòng `\ No newline at end of file` không bị đếm nhầm.
 */
export function parsePatch(path: string, status: FileDiff['status'], patch: string): FileDiff {
  const hunks: DiffHunk[] = []
  let cur: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let oldLeft = 0
  let newLeft = 0
  let additions = 0
  let deletions = 0

  for (const rawLine of patch.replace(/^\n/, '').split('\n')) {
    const raw = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const m = raw.match(HUNK_RE)
    if (m) {
      cur = { header: raw, lines: [] }
      hunks.push(cur)
      oldNo = Number(m[1])
      newNo = Number(m[3])
      oldLeft = m[2] === undefined ? 1 : Number(m[2])
      newLeft = m[4] === undefined ? 1 : Number(m[4])
      continue
    }
    if (!cur || (oldLeft <= 0 && newLeft <= 0)) continue
    const ch = raw[0]
    const text = raw.slice(1)
    let line: DiffLine
    if (ch === '+') {
      line = { type: 'add', newNo: newNo++, text }
      newLeft--
      additions++
    } else if (ch === '-') {
      line = { type: 'del', oldNo: oldNo++, text }
      oldLeft--
      deletions++
    } else if (ch === '\\') {
      continue // "\ No newline at end of file"
    } else {
      line = { type: 'ctx', oldNo: oldNo++, newNo: newNo++, text }
      oldLeft--
      newLeft--
    }
    cur.lines.push(line)
  }
  return { path, status, additions, deletions, hunks }
}

/** Bỏ ngoặc kép và giải mã escape kiểu C mà git dùng cho tên file đặc biệt (`"a/t\303\251st"`). */
export function unquoteGitPath(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s
  const body = s.slice(1, -1)
  const bytes: number[] = []
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' }
  const enc = new TextEncoder()
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      bytes.push(...enc.encode(c))
      continue
    }
    const n = body[i + 1]
    if (/[0-7]/.test(n ?? '')) {
      const oct = body.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)![0]
      bytes.push(parseInt(oct, 8))
      i += oct.length
    } else {
      bytes.push(...enc.encode(simple[n] ?? n ?? ''))
      i += 1
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** Đường dẫn trong dòng `--- a/x` / `+++ b/x`; null nếu là /dev/null. */
function markerPath(rest: string): string | null {
  // git thêm TAB ở cuối khi tên file có dấu cách
  const p = unquoteGitPath(rest.replace(/\t$/, ''))
  if (p === '/dev/null') return null
  return p.replace(/^[ab]\//, '')
}

/** Lấy đường dẫn (mới) từ header `diff --git a/<p> b/<p>`; dùng khi patch không có dòng ---/+++ (file nhị phân, file rỗng). */
function headerPath(rest: string): string {
  if (rest.startsWith('"')) {
    // Có thể cả hai vế đều quote, hoặc chỉ một vế
    const end = rest.indexOf('" ', 1)
    const second = end >= 0 ? rest.slice(end + 2) : ''
    return unquoteGitPath(second).replace(/^b\//, '')
  }
  if (rest.endsWith('"')) {
    const start = rest.lastIndexOf(' "')
    return unquoteGitPath(rest.slice(start + 1)).replace(/^b\//, '')
  }
  // Không rename: "a/P b/P" → hai nửa bằng nhau, an toàn cả khi P chứa " b/"
  const half = (rest.length - 1) / 2
  if (Number.isInteger(half) && rest.slice(2, half) === rest.slice(half + 3) && rest.startsWith('a/') && rest.slice(half + 1, half + 3) === 'b/')
    return rest.slice(half + 3)
  const i = rest.indexOf(' b/')
  return i >= 0 ? rest.slice(i + 3) : rest
}

/**
 * Parse toàn bộ output của `git diff` (nhiều file) thành FileDiff[].
 * Đổi tên → status 'modified', `path` là tên mới, `oldPath` là tên cũ. File nhị phân → hunks rỗng.
 */
export function parseGitDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  const blocks = text.split(/\r?\n(?=diff --git )/)
  for (const block of blocks) {
    if (!block.startsWith('diff --git ')) continue
    const lines = block.split('\n')
    let path = headerPath(lines[0].slice('diff --git '.length).replace(/\r$/, ''))
    let oldPath: string | undefined
    let status: FileDiff['status'] = 'modified'
    let minus: string | null | undefined
    let plus: string | null | undefined
    let bodyStart = lines.length
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i].replace(/\r$/, '')
      if (l.startsWith('@@ ')) {
        bodyStart = i
        break
      }
      if (l.startsWith('new file mode')) status = 'added'
      else if (l.startsWith('deleted file mode')) status = 'deleted'
      else if (l.startsWith('rename from ')) oldPath = unquoteGitPath(l.slice('rename from '.length))
      else if (l.startsWith('rename to ')) path = unquoteGitPath(l.slice('rename to '.length))
      else if (l.startsWith('--- ')) minus = markerPath(l.slice(4))
      else if (l.startsWith('+++ ')) plus = markerPath(l.slice(4))
    }
    if (plus) path = plus
    else if (plus === null && minus) path = minus // file bị xoá: +++ /dev/null
    if (minus === null && plus) status = 'added'
    if (plus === null && minus !== undefined) status = 'deleted'
    if (!oldPath && minus && plus && minus !== plus) oldPath = minus

    const fd = parsePatch(path, status, lines.slice(bodyStart).join('\n'))
    if (oldPath && oldPath !== path) fd.oldPath = oldPath
    files.push(fd)
  }
  return files
}
