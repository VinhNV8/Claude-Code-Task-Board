// Hạn mức theo agent (SPEC-MULTI-AGENT 3.6a, ngắt mạch): agent hết lượt thì đánh dấu "không dùng được đến <giờ reset>"
// cho mọi task, để task kế tiếp đi thẳng sang agent dự phòng thay vì thất bại một lần rồi mới chuyển.
// Claude dùng trạng thái sẵn có (claudeLimit.ts: banner, lưu qua khởi động lại); agent khác giữ trong bộ nhớ.
import { getClaudeLimit } from '../claudeLimit.ts'
import { DEFAULT_WAIT_MS, type RateLimitHit } from '../rateLimit.ts'
import type { AgentId } from './types.ts'

const until = new Map<AgentId, number>()

/** Agent hết lượt: giờ reset đọc được, không có thì chờ mặc định. */
export function setAgentLimit(id: AgentId, hit: RateLimitHit | undefined, now = Date.now()) {
  until.set(id, hit?.resetAt && hit.resetAt > now ? hit.resetAt : now + DEFAULT_WAIT_MS)
}

export const clearAgentLimit = (id: AgentId) => void until.delete(id)

/** Mốc agent có lượt lại (epoch ms) nếu đang hết lượt; undefined = còn lượt. */
export function agentLimitedUntil(id: AgentId, now = Date.now()): number | undefined {
  if (id === 'claude') return getClaudeLimit(now)?.until
  const t = until.get(id)
  if (t === undefined) return undefined
  if (t <= now) {
    until.delete(id)
    return undefined
  }
  return t
}
