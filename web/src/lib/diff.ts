import type { DiffHunk, DiffLine, FileDiff } from '../types'

/** Parse một patch dạng unified (của 1 file) thành cấu trúc hiển thị. */
export function parsePatch(path: string, status: FileDiff['status'], patch: string): FileDiff {
  const hunks: DiffHunk[] = []
  let cur: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let additions = 0
  let deletions = 0

  for (const raw of patch.replace(/^\n/, '').split('\n')) {
    const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
    if (m) {
      cur = { header: raw, lines: [] }
      hunks.push(cur)
      oldNo = Number(m[1])
      newNo = Number(m[2])
      continue
    }
    if (!cur) continue
    const ch = raw[0]
    const text = raw.slice(1)
    let line: DiffLine
    if (ch === '+') {
      line = { type: 'add', newNo: newNo++, text }
      additions++
    } else if (ch === '-') {
      line = { type: 'del', oldNo: oldNo++, text }
      deletions++
    } else {
      line = { type: 'ctx', oldNo: oldNo++, newNo: newNo++, text }
    }
    cur.lines.push(line)
  }
  return { path, status, additions, deletions, hunks }
}
