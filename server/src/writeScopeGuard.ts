// FR-49 (chặn cứng): thao tác ghi file của agent nằm ngoài phạm vi ghi của task bị từ chối ngay, không cần người duyệt.
// Dùng ở hai cổng: permissions.ts (Claude qua permission prompt tool) và permissionBroker.ts (Codex, Antigravity).
// Lệnh shell không được phân tích đường dẫn; file do shell sửa ngoài phạm vi vẫn bị cảnh báo ở bước Review.
import { posix } from 'node:path'
import { toPosixPath } from './permissionRules.ts'
import { inScope } from '../../web/src/lib/writeScope.ts'

type Input = Record<string, unknown>

/** Tool ghi file của Claude (cùng nhóm với quy tắc `Edit` của allowlist). */
export const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)

/** Đường dẫn file mà lần gọi tool ghi tới (chỉ với tool ghi file). */
export function writePathOf(toolName: string, input: Input | undefined): string | undefined {
  if (!WRITE_TOOLS.has(toolName)) return undefined
  return str(input?.file_path) ?? str(input?.notebook_path) ?? str(input?.path)
}

/** Đường dẫn tương đối với cwd (dạng `/`), hoặc undefined nếu nằm ngoài cwd. */
export function relToCwd(path: string, cwd: string, caseInsensitive = process.platform === 'win32'): string | undefined {
  const base = toPosixPath(cwd)
  const p0 = toPosixPath(path)
  const abs = p0.startsWith('/') ? p0 : toPosixPath(posix.join(base, p0))
  const a = caseInsensitive ? abs.toLowerCase() : abs
  const b = caseInsensitive ? base.toLowerCase() : base
  const root = b.endsWith('/') ? b : `${b}/`
  if (a === b) return ''
  if (!a.startsWith(root)) return undefined
  return abs.slice(root.length)
}

/**
 * File đầu tiên vi phạm phạm vi ghi (tương đối với cwd nếu được), hoặc undefined nếu mọi file đều hợp lệ.
 * Không giới hạn phạm vi → luôn hợp lệ. Không rõ đường dẫn hoặc không có cwd → coi là vi phạm (đóng an toàn).
 */
export function scopeViolation(paths: (string | undefined)[], cwd: string | undefined, scope: string[] | undefined): string | undefined {
  if (!scope?.length) return undefined
  if (!paths.length) return '(không rõ đường dẫn)'
  for (const p of paths) {
    if (!p) return '(không rõ đường dẫn)'
    if (!cwd) return p
    const rel = relToCwd(p, cwd)
    if (rel === undefined || rel === '') return p
    if (!inScope(rel, scope)) return rel
  }
  return undefined
}

/** Lời từ chối gửi lại cho agent: nói rõ lý do và cách làm tiếp. */
export function scopeDenyMessage(file: string, scope: string[]): string {
  return (
    `Task Board từ chối: ${file} nằm ngoài phạm vi ghi của task (${scope.join(', ')}). ` +
    'Không sửa file này; nếu thật sự cần, ghi file và nội dung cần sửa vào mục "Đề xuất ngoài phạm vi" ở cuối câu trả lời.'
  )
}
