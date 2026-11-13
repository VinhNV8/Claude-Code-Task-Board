// Rủi ro "Vượt giới hạn sử dụng của gói" (PLAN > Rủi ro theo giai đoạn > Chung):
// nhận diện run thất bại do rate limit, tính thời điểm được chạy lại, và sắp xếp hàng đợi theo not_before.
import type { Priority, Task } from './types.ts'
import type { ResultInfo } from './stream.ts'

/** Chờ mặc định khi thông điệp không cho biết giờ reset. */
export const DEFAULT_WAIT_MS = 15 * 60_000
/** Số lần tự đưa lại hàng đợi tối đa; vượt quá thì task Failed. */
export const MAX_RATE_LIMIT_RETRIES = 3
/** Chạy lại sau giờ reset một chút để tránh lệch đồng hồ. */
const RESET_BUFFER_MS = 60_000
/** Giờ reset xa hơn mức này thì coi là không đáng tin (vẫn dùng, nhưng giới hạn lại). */
const MAX_WAIT_MS = 8 * 24 * 60 * 60_000

/** Thông tin từ dòng `rate_limit_event` của stream-json (xem fixtures/*.jsonl). */
export interface RateLimitEvent {
  status: string
  /** epoch ms */
  resetsAt?: number
  /** 'five_hour' | 'seven_day' | 'seven_day_opus'... */
  rateLimitType?: string
}

export interface RateLimitHit {
  /** Giờ reset đọc được (epoch ms), nếu có. */
  resetAt?: number
}

// Các mẫu thông điệp của Claude Code / API khi hết hạn mức. Chỉ áp dụng cho run đã thất bại.
const PATTERNS = [
  /usage limit/i,
  /rate[ _-]?limit(ed)?\b/i,
  // "hit your limit", "hit your 5-hour limit", "hit your weekly limit", "hit your Opus weekly limit"...
  /hit your [\w -]{0,30}limit/i,
  /\blimit (reached|exceeded)\b/i,
  /\bapi error:?\s*429\b/i,
  /too many requests/i,
]

/** Thông điệp có vẻ là lỗi giới hạn sử dụng không. */
export const looksRateLimited = (text: string | undefined) => !!text && PATTERNS.some((re) => re.test(text))

/**
 * Đọc giờ reset từ thông điệp. Hỗ trợ:
 * - `Claude AI usage limit reached|1794404400` (epoch giây sau dấu `|`)
 * - `resets 3pm`, `resets 3:30 pm`, `resets at 15:00`, `reset at 9am (Asia/Saigon)`: giờ địa phương của máy
 *   (Claude CLI chạy cùng máy với server), lấy lần gần nhất sau `now`.
 */
export function parseResetTime(text: string | undefined, now = Date.now()): number | undefined {
  if (!text) return undefined
  const epoch = /\|\s*(\d{10,13})\b/.exec(text)
  if (epoch) {
    const n = Number(epoch[1])
    return n < 1e12 ? n * 1000 : n
  }
  const m = /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(text)
  if (!m) return undefined
  let h = Number(m[1])
  const min = m[2] ? Number(m[2]) : 0
  const ampm = m[3]?.toLowerCase().replace(/\./g, '')
  if (!ampm && !m[2]) return undefined // "resets 5" không rõ nghĩa
  if (ampm) {
    if (h < 1 || h > 12) return undefined
    h = (h % 12) + (ampm === 'pm' ? 12 : 0)
  }
  if (h > 23 || min > 59) return undefined
  const d = new Date(now)
  d.setHours(h, min, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/**
 * Run thất bại có phải do giới hạn sử dụng không. Trả về undefined nếu không phải.
 * Nguồn: `api_error_status` 429, `rate_limit_event` bị từ chối, hoặc thông điệp trong result (khi lỗi) / stderr.
 */
export function detectRateLimit(o: {
  result?: Pick<ResultInfo, 'isError' | 'text' | 'apiErrorStatus'>
  stderr?: string
  rateLimitEvent?: RateLimitEvent
  now?: number
}): RateLimitHit | undefined {
  const now = o.now ?? Date.now()
  const resultText = o.result?.isError ? o.result.text : undefined
  const rejected = !!o.rateLimitEvent && o.rateLimitEvent.status === 'rejected'
  const hit =
    o.result?.apiErrorStatus === 429 || rejected || looksRateLimited(resultText) || looksRateLimited(o.stderr)
  if (!hit) return undefined
  const resetAt =
    parseResetTime(resultText, now) ??
    parseResetTime(o.stderr, now) ??
    (rejected && o.rateLimitEvent?.resetsAt && o.rateLimitEvent.resetsAt > now ? o.rateLimitEvent.resetsAt : undefined)
  return resetAt ? { resetAt } : {}
}

/** Thời điểm task được chạy lại: sau giờ reset (nếu đọc được và hợp lý), mặc định chờ 15 phút. */
export function retryAt(hit: RateLimitHit, now = Date.now()): number {
  if (hit.resetAt && hit.resetAt > now) return Math.min(hit.resetAt + RESET_BUFFER_MS, now + MAX_WAIT_MS)
  return now + DEFAULT_WAIT_MS
}

export type RateLimitDecision =
  | { action: 'requeue'; notBefore: number; attempt: number }
  | { action: 'fail'; failReason: string }

/** Quyết định khi gặp rate limit: đưa lại hàng đợi (tối đa MAX_RATE_LIMIT_RETRIES lần) hoặc Failed. */
export function decideRateLimit(hit: RateLimitHit, retriesSoFar: number, now = Date.now()): RateLimitDecision {
  if (retriesSoFar >= MAX_RATE_LIMIT_RETRIES)
    return {
      action: 'fail',
      failReason: `Vượt giới hạn sử dụng của gói Claude, đã tự thử lại ${MAX_RATE_LIMIT_RETRIES} lần không thành công. Hãy chạy lại sau.`,
    }
  return { action: 'requeue', notBefore: retryAt(hit, now), attempt: retriesSoFar + 1 }
}

// ---------------------------------------------------------------- hàng đợi

export const PRIORITY_ORDER: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 }

/**
 * Sắp xếp task Queued: chỉ lấy task đã tới giờ (notBefore <= now), theo ưu tiên rồi createdAt.
 * `wakeAt` = notBefore sớm nhất của các task chưa tới giờ (để hẹn giờ pump lại).
 */
export function orderQueue<T extends Pick<Task, 'priority' | 'createdAt' | 'notBefore'>>(queued: T[], now = Date.now()) {
  const ready: T[] = []
  let wakeAt: number | undefined
  for (const t of queued) {
    if (t.notBefore && t.notBefore > now) wakeAt = wakeAt === undefined ? t.notBefore : Math.min(wakeAt, t.notBefore)
    else ready.push(t)
  }
  ready.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt)
  return { ready, wakeAt }
}
