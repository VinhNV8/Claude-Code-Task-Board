// Nhận xét theo file/dòng khi review (G3): logic thuần, dùng chung cho server và giao diện.
import type { FileDiff, ReviewComment } from '../types.ts'

export const MAX_COMMENTS = 200
export const MAX_COMMENT_LEN = 4000
const MAX_SNIPPET = 300

export const isMarkdownPath = (path: string) => /\.(md|markdown|mdx)$/i.test(path)

/** Vị trí của nhận xét để hiển thị: `src/a.ts:12`, `src/a.ts:12 (bản cũ)` hoặc `src/a.ts (cả file)`. */
export function commentLocation(c: Pick<ReviewComment, 'path' | 'line' | 'side'>) {
  if (c.line === undefined) return `${c.path} (cả file)`
  return `${c.path}:${c.line}${c.side === 'old' ? ' (bản cũ, dòng đã xoá)' : ''}`
}

/** Sắp theo file rồi theo dòng; nhận xét cả file đứng đầu mỗi file. */
export function sortComments(comments: ReviewComment[]) {
  return [...comments].sort(
    (a, b) => a.path.localeCompare(b.path) || (a.line ?? -1) - (b.line ?? -1) || (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1),
  )
}

/**
 * Nội dung gửi cho Claude khi "Request changes": feedback chung + danh sách nhận xét theo file/dòng,
 * kèm nội dung dòng để Claude định vị dù số dòng đã lệch.
 */
export function formatReviewFeedback(feedback: string | undefined, comments: ReviewComment[] = []) {
  const general = (feedback ?? '').trim()
  if (!comments.length) return general
  const lines: string[] = []
  if (general) lines.push(general, '')
  lines.push(`Nhận xét khi review (${comments.length}), hãy sửa theo từng mục:`)
  sortComments(comments).forEach((c, i) => {
    lines.push(`${i + 1}. ${commentLocation(c)}`)
    if (c.snippet !== undefined && c.snippet.trim()) lines.push(`   Dòng: \`${c.snippet.trim()}\``)
    lines.push(...c.text.trim().split(/\r?\n/).map((l) => `   ${l}`))
  })
  return lines.join('\n')
}

/** Chuẩn hoá danh sách nhận xét từ request; trả lỗi (tiếng Việt) nếu không hợp lệ. */
export function parseComments(raw: unknown): { comments: ReviewComment[]; error?: undefined } | { error: string } {
  if (raw === undefined || raw === null) return { comments: [] }
  if (!Array.isArray(raw)) return { error: 'Danh sách nhận xét không hợp lệ' }
  if (raw.length > MAX_COMMENTS) return { error: `Tối đa ${MAX_COMMENTS} nhận xét mỗi lần` }
  const comments: ReviewComment[] = []
  for (const [i, item] of raw.entries()) {
    const c = (item ?? {}) as Record<string, unknown>
    const path = typeof c.path === 'string' ? c.path.trim() : ''
    const text = typeof c.text === 'string' ? c.text.trim() : ''
    if (!path) return { error: `Nhận xét #${i + 1} thiếu đường dẫn file` }
    if (!text) return { error: `Nhận xét #${i + 1} (${path}) chưa có nội dung` }
    if (text.length > MAX_COMMENT_LEN) return { error: `Nhận xét #${i + 1} dài quá ${MAX_COMMENT_LEN} ký tự` }
    const line = c.line === undefined || c.line === null ? undefined : Number(c.line)
    if (line !== undefined && !(Number.isInteger(line) && line > 0)) return { error: `Nhận xét #${i + 1} có số dòng không hợp lệ` }
    comments.push({
      id: typeof c.id === 'string' && c.id ? c.id.slice(0, 64) : `c${i + 1}`,
      path,
      line,
      side: line === undefined ? undefined : c.side === 'old' ? 'old' : 'new',
      snippet: line !== undefined && typeof c.snippet === 'string' ? c.snippet.slice(0, MAX_SNIPPET) : undefined,
      text,
    })
  }
  return { comments }
}

/** Dấu vân tay nội dung diff của một file: file đổi sau lần chạy mới thì trạng thái "Đã xem" tự mất. */
export function fileSignature(f: FileDiff) {
  let h = 0
  for (const hunk of f.hunks)
    for (const l of hunk.lines) {
      const s = l.type + l.text
      for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
    }
  return `${f.path}:${f.additions}:${f.deletions}:${h >>> 0}`
}
