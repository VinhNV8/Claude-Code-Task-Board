// Gói Claude hết lượt (5 giờ / tuần): trạng thái dùng chung cho server (ghi nhận từ run) và web (banner trên mọi trang).
// File thuần, không phụ thuộc DOM/React/Node để test được bằng node:test.

export type ClaudeLimitKind = 'five_hour' | 'weekly' | 'weekly_opus' | 'unknown'

export interface ClaudeLimit {
  kind: ClaudeLimitKind
  /** Giờ có lượt lại (epoch ms), nếu Claude cho biết. */
  resetAt?: number
  /** Hết thời điểm này thì coi như đã có lượt lại (= resetAt, hoặc ước lượng khi không rõ giờ reset). */
  until: number
  /** Lúc ghi nhận (epoch ms). */
  since: number
  /** Thông điệp gốc của Claude, để tham khảo. */
  raw?: string
}

/** Đọc loại giới hạn từ `rateLimitType` của stream-json hoặc từ câu "You've hit your 5-hour limit". */
export function limitKind(o: { rateLimitType?: string; text?: string }): ClaudeLimitKind {
  const t = (o.rateLimitType ?? '').toLowerCase()
  if (t.includes('opus')) return 'weekly_opus'
  if (t.includes('five') || t.includes('5')) return 'five_hour'
  if (t.includes('seven') || t.includes('week')) return 'weekly'
  const m = /hit your ([\w\s-]*?)\s*limit/i.exec(o.text ?? '')
  const w = (m?.[1] ?? '').toLowerCase()
  if (w.includes('opus')) return 'weekly_opus'
  if (w.includes('week')) return 'weekly'
  if (/5[-\s]?hour|session/.test(w)) return 'five_hour'
  return 'unknown'
}

/** Giới hạn còn hiệu lực không (chưa tới giờ có lượt lại). */
export const isLimitActive = (l: ClaudeLimit | null | undefined, now = Date.now()): l is ClaudeLimit => !!l && l.until > now

const KIND_LABEL: Record<ClaudeLimitKind, string> = {
  five_hour: 'trong khung 5 giờ',
  weekly: 'của tuần này',
  weekly_opus: 'dành cho Opus trong tuần này',
  unknown: 'hiện tại',
}

/** "1 giờ 20 phút", "15 phút", "2 ngày 3 giờ", "chưa đầy 1 phút". */
export function formatRemaining(ms: number): string {
  if (ms < 60_000) return 'chưa đầy 1 phút'
  const totalMin = Math.ceil(ms / 60_000)
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d) return h ? `${d} ngày ${h} giờ` : `${d} ngày`
  if (h) return m ? `${h} giờ ${m} phút` : `${h} giờ`
  return `${m} phút`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Giờ có lượt lại theo giờ máy người xem: "14:30", thêm "thứ Bảy 15/11" nếu không phải hôm nay. */
export function formatResetAt(ts: number, now = Date.now()): string {
  const d = new Date(ts)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const n = new Date(now)
  if (d.toDateString() === n.toDateString()) return hm
  const tomorrow = new Date(now)
  tomorrow.setDate(n.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return `${hm} ngày mai`
  const dow = ['Chủ nhật', 'thứ Hai', 'thứ Ba', 'thứ Tư', 'thứ Năm', 'thứ Sáu', 'thứ Bảy'][d.getDay()]
  return `${hm} ${dow} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
}

/** Nội dung banner, giọng thân thiện. `queued`: số task đang chờ chạy tiếp. */
export function limitNotice(l: ClaudeLimit, now = Date.now(), queued = 0): { title: string; body: string } {
  const title = `Claude tạm nghỉ một chút: gói đã dùng hết lượt ${KIND_LABEL[l.kind]}`
  const when = l.resetAt
    ? `Lượt mới có lại lúc ${formatResetAt(l.resetAt, now)} (khoảng ${formatRemaining(l.resetAt - now)} nữa).`
    : `Chưa rõ giờ có lượt lại, hệ thống sẽ tự thử lại sau khoảng ${formatRemaining(l.until - now)}.`
  const after = queued
    ? `${queued} task đang xếp hàng sẽ tự chạy tiếp khi có lượt, bạn không cần làm gì thêm.`
    : 'Task giao lúc này sẽ được xếp hàng và tự chạy khi có lượt.'
  return { title, body: `${when} ${after}` }
}
