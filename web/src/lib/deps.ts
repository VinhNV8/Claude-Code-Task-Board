// Phụ thuộc giữa task (SPEC FR-08, PLAN C-02). Hàm thuần, dùng chung cho server và giao diện.
// Task B "chờ" task A: B chỉ chạy khi A ở Done (đã merge), vì worktree của B tạo từ nhánh chính.
import type { Priority, Task, TaskStatus } from '../types.ts'

/**
 * Quy ước gửi kèm mỗi run qua `--append-system-prompt` (R6, nguồn ④): Claude tự báo khi bị chặn
 * bởi phần việc của task khác, backend đọc dòng BLOCKED_BY để thêm phụ thuộc và đưa task về hàng đợi.
 */
export const BLOCKED_BY_INSTRUCTION = [
  'Bạn đang chạy như một task trên Claude Task Board. Nếu bạn KHÔNG THỂ hoàn thành vì thiếu phần việc thuộc về một task khác',
  '(task đó chưa làm, hoặc mới làm dở), thì: dừng lại, không tự làm thay phần việc của task kia, hoàn tác thay đổi dở dang của bạn,',
  'và kết thúc câu trả lời cuối cùng bằng đúng một dòng dạng:',
  'BLOCKED_BY: <#id hoặc mã task, ví dụ #40 hoặc P5-06; nhiều task thì cách nhau bằng dấu phẩy>; <lý do ngắn>',
  'Chỉ dùng dòng này khi thật sự bị chặn bởi task khác. Thiếu thông tin hay gặp lỗi thông thường thì KHÔNG dùng.',
].join(' ') // một dòng: truyền làm tham số dòng lệnh trên Windows

const PRIORITY_ORDER: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 }

/** Mã task: phần `[P5-01]` ở đầu tiêu đề (ví dụ "[P5-06b] Nối escalation…" → "P5-06B"). */
const CODE = '[A-Za-z]{1,4}\\d*-\\d{1,3}[A-Za-z]?'
const TITLE_CODE_RE = new RegExp(`^\\s*\\[(${CODE})\\]`)
const CODE_RE = new RegExp(`(?<![\\w-])(${CODE})(?![\\w-])`, 'g')
const ID_RE = /(?<![\w&])#(\d{1,7})(?!\w)/g

const normCode = (c: string) => c.toUpperCase()

export function taskCode(title: string): string | undefined {
  const m = title.match(TITLE_CODE_RE)
  return m ? normCode(m[1]) : undefined
}

/** Tìm tham chiếu tới task khác trong văn bản: `#35` và mã dạng `P5-01`, `C-02`, `P5-06b`. */
export function parseRefs(text: string): { ids: number[]; codes: string[] } {
  const ids = new Set<number>()
  const codes = new Set<string>()
  for (const m of text.matchAll(ID_RE)) ids.add(Number(m[1]))
  for (const m of text.matchAll(CODE_RE)) {
    // Mã phải có chữ cái đầu viết hoa trong văn bản (tránh khớp chuỗi như "utf-8", "x-1").
    if (/^[A-Z]/.test(m[1])) codes.add(normCode(m[1]))
  }
  return { ids: [...ids], codes: [...codes] }
}

type RefCandidate = Pick<Task, 'id' | 'title' | 'projectId'>

/** Đổi tham chiếu thành id task cùng project (bỏ chính nó), giữ thứ tự xuất hiện, không trùng. */
export function resolveRefs(refs: { ids: number[]; codes: string[] }, candidates: RefCandidate[], projectId: string, selfId?: number): number[] {
  const same = candidates.filter((t) => t.projectId === projectId && t.id !== selfId)
  const out = new Set<number>()
  for (const id of refs.ids) if (same.some((t) => t.id === id)) out.add(id)
  for (const code of refs.codes) {
    const t = same.find((x) => taskCode(x.title) === code)
    if (t) out.add(t.id)
  }
  return [...out]
}

/**
 * Đọc dòng `BLOCKED_BY: <refs>; <lý do>` trong kết quả cuối của Claude (dòng cuối cùng khớp được dùng).
 * Trả null nếu không có hoặc không có tham chiếu nào.
 */
export function parseBlockedBy(text: string | undefined): { refs: { ids: number[]; codes: string[] }; reason: string } | null {
  if (!text) return null
  const lines = [...text.matchAll(/^[\s>*`_-]*BLOCKED_BY\s*:\s*(.+)$/gim)]
  const last = lines.at(-1)
  if (!last) return null
  const body = last[1].replace(/[`*_]+$/g, '').trim()
  const cut = body.indexOf(';')
  const refPart = cut >= 0 ? body.slice(0, cut) : body
  const reason = cut >= 0 ? body.slice(cut + 1).trim() : ''
  const refs = parseRefs(refPart)
  if (!refs.ids.length && !refs.codes.length) return null
  return { refs, reason }
}

/** Các task được chờ chưa Done. Id không còn tồn tại (đã xoá) thì bỏ qua. */
export function unmetDeps(task: Pick<Task, 'dependsOn'>, statusOf: (id: number) => TaskStatus | undefined): number[] {
  return (task.dependsOn ?? []).filter((id) => {
    const s = statusOf(id)
    return s !== undefined && s !== 'done'
  })
}

/**
 * Đặt phụ thuộc `deps` cho `taskId` có tạo vòng tròn không. Trả về đường vòng (taskId → … → taskId) hoặc null.
 * `depsOf` trả danh sách chờ hiện tại của một task (không tính thay đổi đang xét).
 */
export function findCycle(taskId: number, deps: number[], depsOf: (id: number) => number[]): number[] | null {
  for (const start of deps) {
    if (start === taskId) return [taskId, taskId]
    const stack: { id: number; path: number[] }[] = [{ id: start, path: [taskId, start] }]
    const seen = new Set<number>()
    while (stack.length) {
      const { id, path } = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      for (const next of depsOf(id)) {
        if (next === taskId) return [...path, taskId]
        stack.push({ id: next, path: [...path, next] })
      }
    }
  }
  return null
}

/**
 * Thứ tự hiển thị cột Queued (R4): task đang chờ luôn đứng sau task nó chờ (nếu task đó cũng trong danh sách);
 * giữa các task sẵn sàng cùng lúc thì theo ưu tiên → thời gian tạo. Vòng tròn (không nên có) thì xếp cuối.
 */
export function sortByDeps<T extends Pick<Task, 'id' | 'priority' | 'createdAt' | 'dependsOn'>>(list: T[]): T[] {
  const cmp = (a: T, b: T) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt || a.id - b.id
  const inList = new Set(list.map((t) => t.id))
  const waitingOn = new Map(list.map((t) => [t.id, new Set((t.dependsOn ?? []).filter((d) => inList.has(d) && d !== t.id))]))
  const out: T[] = []
  const left = new Set(list)
  while (left.size) {
    const ready = [...left].filter((t) => waitingOn.get(t.id)!.size === 0).sort(cmp)
    if (!ready.length) {
      out.push(...[...left].sort(cmp))
      break
    }
    const next = ready[0]
    out.push(next)
    left.delete(next)
    for (const s of waitingOn.values()) s.delete(next.id)
  }
  return out
}
