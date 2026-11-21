// PLAN "Kết quả kiểm thử P5", vấn đề 5: với `--resume`, Claude CLI trả `total_cost_usd` và `modelUsage`
// cộng dồn cả phiên, không phải của riêng lần chạy. Lưu thẳng thì Stats và budget tính trùng chi phí
// của mọi task có Request changes / Tiếp tục / lượt Thực hiện sau Kế hoạch.
//
// Cách tính: run lưu cả số cộng dồn CLI báo (`session_cost_usd`, `session_model_usage`) và số của riêng nó
// (`cost_usd`, `model_usage`) = cộng dồn hiện tại − cộng dồn của run trước gần nhất trong cùng phiên.
import type { ModelUsage, Run } from './types.ts'

export interface UsageTotals {
  costUsd?: number
  modelUsage?: Record<string, ModelUsage>
}

type RunLite = Pick<Run, 'id' | 'sessionId' | 'startedAt' | 'costUsd' | 'modelUsage'> & {
  sessionCostUsd?: number
  sessionModelUsage?: Record<string, ModelUsage>
}

const FIELDS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUsd'] as const

const nonNeg = (n: number) => (n > 0 ? n : 0)

/** `cur − base` theo từng model và từng trường (không âm); model không còn số nào thì bỏ. */
export function subtractUsage(cur: Record<string, ModelUsage>, base: Record<string, ModelUsage> | undefined): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = {}
  for (const [model, u] of Object.entries(cur)) {
    const b = base?.[model]
    const d = Object.fromEntries(FIELDS.map((f) => [f, nonNeg((u[f] ?? 0) - (b?.[f] ?? 0))])) as unknown as ModelUsage
    if (FIELDS.some((f) => d[f] > 0)) out[model] = d
  }
  return out
}

/**
 * Số cộng dồn của phiên tính đến hết run trước gần nhất (cùng `sessionId`, đã có số liệu).
 * Run cũ (trước bản sửa) không có `session*`: khi đó `costUsd`/`modelUsage` của nó chính là số cộng dồn CLI báo.
 */
export function sessionBaseline(runId: string, sessionId: string | undefined, prior: RunLite[]): UsageTotals | undefined {
  if (!sessionId) return undefined
  const same = prior
    .filter((r) => r.id !== runId && r.sessionId === sessionId && (r.sessionCostUsd ?? r.costUsd) !== undefined)
    .sort((a, b) => b.startedAt - a.startedAt)
  const last = same[0]
  if (!last) return undefined
  return { costUsd: last.sessionCostUsd ?? last.costUsd, modelUsage: last.sessionModelUsage ?? last.modelUsage }
}

/** Chi phí của riêng run từ số cộng dồn CLI báo và mốc của phiên. Không có mốc: số CLI báo là của run này. */
export function perRunUsage(reported: UsageTotals, baseline: UsageTotals | undefined): UsageTotals {
  if (!baseline) return reported
  return {
    costUsd: reported.costUsd === undefined ? undefined : nonNeg(reported.costUsd - (baseline.costUsd ?? 0)),
    modelUsage: reported.modelUsage ? subtractUsage(reported.modelUsage, baseline.modelUsage) : undefined,
  }
}

/**
 * Chuyển dữ liệu cũ (mọi run lưu số cộng dồn) sang số của riêng từng run.
 * Trả về các run cần sửa: `cost`/`usage` mới, `sessionCost`/`sessionUsage` = số cộng dồn gốc.
 */
export function migrateCumulative(all: RunLite[]) {
  const bySession = new Map<string, RunLite[]>()
  for (const r of all) {
    if (!r.sessionId) continue
    const list = bySession.get(r.sessionId) ?? []
    list.push(r)
    bySession.set(r.sessionId, list)
  }
  const out: { id: string; cost?: number; usage?: Record<string, ModelUsage>; sessionCost?: number; sessionUsage?: Record<string, ModelUsage> }[] = []
  for (const list of bySession.values()) {
    list.sort((a, b) => a.startedAt - b.startedAt)
    let base: UsageTotals | undefined
    for (const r of list) {
      if (r.costUsd === undefined && !r.modelUsage) continue
      const reported = { costUsd: r.costUsd, modelUsage: r.modelUsage }
      const own = perRunUsage(reported, base)
      out.push({ id: r.id, cost: own.costUsd, usage: own.modelUsage, sessionCost: r.costUsd, sessionUsage: r.modelUsage })
      base = reported
    }
  }
  return out
}
