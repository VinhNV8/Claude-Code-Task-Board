// Gói Claude hết lượt: giữ trạng thái chung để web hiện banner trên mọi trang.
// Ghi nhận khi một run gặp giới hạn sử dụng (runner.ts), xoá khi có run chạy được hoặc đã qua giờ có lượt lại.
// Lưu ra file nhỏ trong DATA_DIR để khởi động lại server vẫn còn thông báo.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './db.ts'
import { broadcast } from './bus.ts'
import { DEFAULT_WAIT_MS, type RateLimitEvent, type RateLimitHit } from './rateLimit.ts'
import { isLimitActive, limitKind, type ClaudeLimit } from '../../web/src/lib/claudeLimit.ts'

const FILE = join(DATA_DIR, 'claude-limit.json')

let current: ClaudeLimit | null = load()
let expiry: NodeJS.Timeout | undefined
schedule()

function load(): ClaudeLimit | null {
  try {
    const l = JSON.parse(readFileSync(FILE, 'utf8')) as ClaudeLimit
    return isLimitActive(l) ? l : null
  } catch {
    return null
  }
}

function save() {
  try {
    if (current) writeFileSync(FILE, JSON.stringify(current))
    else rmSync(FILE, { force: true })
  } catch {
    /* chỉ là bộ nhớ đệm cho lần khởi động sau */
  }
}

/** Hết giờ thì tự xoá và báo web (không cần đợi run kế tiếp). */
function schedule() {
  clearTimeout(expiry)
  if (!current) return
  // setTimeout tối đa ~24.8 ngày; giới hạn tuần nằm trong khoảng đó.
  expiry = setTimeout(() => clearClaudeLimit(), Math.max(0, Math.min(current.until - Date.now(), 2 ** 31 - 1)))
  expiry.unref?.()
}

/** Giới hạn đang hiệu lực, hoặc null. */
export function getClaudeLimit(now = Date.now()): ClaudeLimit | null {
  return isLimitActive(current, now) ? current : null
}

/** Dựng trạng thái từ một lần gặp giới hạn (hàm thuần, để test). */
export function buildClaudeLimit(o: { hit: RateLimitHit; event?: RateLimitEvent; text?: string; now?: number }): ClaudeLimit {
  const now = o.now ?? Date.now()
  const resetAt = o.hit.resetAt && o.hit.resetAt > now ? o.hit.resetAt : undefined
  return {
    kind: limitKind({ rateLimitType: o.event?.rateLimitType, text: o.text }),
    resetAt,
    until: resetAt ?? now + DEFAULT_WAIT_MS,
    since: now,
    raw: o.text?.trim().slice(0, 300) || undefined,
  }
}

export function setClaudeLimit(l: ClaudeLimit) {
  current = l
  save()
  schedule()
  broadcast({ type: 'claude_limit', limit: l })
}

/** Có run chạy được hoặc đã qua giờ reset: bỏ banner. */
export function clearClaudeLimit() {
  if (!current) return
  current = null
  save()
  schedule()
  broadcast({ type: 'claude_limit', limit: null })
}
