// P5-07: thống kê lịch sử model (Lớp 2) lấy từ DB, cache 5 phút; có review mới thì tính lại.
import { bus, type ServerMessage } from './bus.ts'
import { reviews, runs, tasks } from './db.ts'
import { adjustSuggestion, computeModelStats, type ModelStats } from './modelHistory.ts'
import type { Suggestion } from './modelPicker.ts'

export const MODEL_STATS_TTL_MS = 5 * 60_000

export const modelHistoryDeps = { now: () => Date.now() }

let cache: { at: number; stats: ModelStats } | undefined

/** Thống kê 90 ngày gần nhất của mọi project (cache MODEL_STATS_TTL_MS). */
export function getModelStats(): ModelStats {
  const now = modelHistoryDeps.now()
  if (!cache || now - cache.at >= MODEL_STATS_TTL_MS) cache = { at: now, stats: computeModelStats(tasks.all(), runs.all(), reviews.all(), now) }
  return cache.stats
}

/** Áp Lớp 2 lên gợi ý của Lớp 1 cho task thuộc project. */
export const adjustByHistory = (s: Suggestion, task: { projectId?: string; tags?: string[] }) => adjustSuggestion(s, task, getModelStats())

export function resetModelStatsCache() {
  cache = undefined
}

// Có review mới (approve/reject/request_changes) → lần gợi ý sau tính lại từ DB.
bus.on('message', (m: ServerMessage) => {
  if (m.type === 'review') cache = undefined
})
