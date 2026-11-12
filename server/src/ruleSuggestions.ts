// Gợi ý thêm rule vào allowlist từ lịch sử duyệt quyền (FR-44, PLAN P7-02).
// Hàm thuần, không đụng DB; ruleSuggestionsFor() ở dưới mới đọc DB.
import { bus, broadcast, type ServerMessage } from './bus.ts'
import { db, kv, projects, tasks } from './db.ts'
import { describeInput, isRiskyShell, riskOf, rulesFor } from './permissionRules.ts'
import type { PermissionRequest, RuleSuggestion } from './types.ts'

/** Số lần cho phép tối thiểu để gợi ý, khoảng thời gian xét và số gợi ý tối đa. */
export const MIN_ALLOWED = 3
export const WINDOW_MS = 30 * 86_400_000
export const MAX_SUGGESTIONS = 10

export interface HistoryItem {
  tool: string
  input: Record<string, unknown>
  status: PermissionRequest['status']
  createdAt: number
}

/** Lệnh có thế lệnh/redirect (isRiskyShell) hoặc bị P7-04 đánh dấu high thì không bao giờ gợi ý cho phép sẵn. */
const isRisky = (h: HistoryItem) =>
  (h.tool === 'Bash' && typeof h.input.command === 'string' && isRiskyShell(h.input.command)) || riskOf(h.tool, h.input).level === 'high'

/**
 * Rule R được gợi ý khi: ≥ 3 request 'allowed' (lệnh không rủi ro) sinh ra R, không request 'denied' nào sinh ra R,
 * R chưa có trong allowlist và chưa bị bỏ qua. Lệnh ghép sinh nhiều rule thì xét từng rule.
 */
export function suggestRules(requests: HistoryItem[], allowedTools: string[], dismissed: string[]): RuleSuggestion[] {
  const skip = new Set([...allowedTools, ...dismissed].map((r) => r.trim()))
  const denied = new Set<string>()
  const stats = new Map<string, RuleSuggestion>()

  for (const h of requests) {
    const rules = rulesFor(h.tool, h.input)
    if (h.status === 'denied') {
      rules.forEach((r) => denied.add(r))
      continue
    }
    if (h.status !== 'allowed' || isRisky(h)) continue
    for (const rule of rules) {
      const s = stats.get(rule)
      if (!s) stats.set(rule, { rule, count: 1, lastAt: h.createdAt, example: describeInput(h.tool, h.input) })
      else {
        s.count++
        if (h.createdAt > s.lastAt) Object.assign(s, { lastAt: h.createdAt, example: describeInput(h.tool, h.input) })
      }
    }
  }

  return [...stats.values()]
    .filter((s) => s.count >= MIN_ALLOWED && !denied.has(s.rule) && !skip.has(s.rule))
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, MAX_SUGGESTIONS)
}

// ---------------------------------------------------------------- lưu trữ

const dismissKey = (projectId: string) => `ruleSuggestDismissed:${projectId}`

export function dismissedRules(projectId: string): string[] {
  try {
    const v = JSON.parse(kv.get(dismissKey(projectId)) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function dismissRule(projectId: string, rule: string): string[] {
  const list = dismissedRules(projectId)
  if (!list.includes(rule)) list.push(rule)
  kv.set(dismissKey(projectId), JSON.stringify(list))
  return list
}

/** Lịch sử duyệt quyền 30 ngày gần nhất của project. */
export function projectHistory(projectId: string, now = Date.now()): HistoryItem[] {
  const rows = db
    .prepare(
      `SELECT r.tool, r.input_json, r.status, r.created_at FROM permission_requests r
       JOIN tasks t ON t.id = r.task_id
       WHERE t.project_id = ? AND r.created_at >= ? AND r.status IN ('allowed', 'denied')`,
    )
    .all(projectId, now - WINDOW_MS) as { tool: string; input_json: string; status: HistoryItem['status']; created_at: number }[]
  return rows.flatMap((r) => {
    try {
      return [{ tool: r.tool, input: JSON.parse(r.input_json), status: r.status, createdAt: r.created_at }]
    } catch {
      return []
    }
  })
}

export function ruleSuggestionsFor(project: { id: string; allowedTools: string[] }, now = Date.now()): RuleSuggestion[] {
  return suggestRules(projectHistory(project.id, now), project.allowedTools, dismissedRules(project.id))
}

let watching = false

/**
 * Gợi ý đổi khi người dùng quyết định một yêu cầu xin quyền hoặc sửa allowlist của project:
 * tính lại và broadcast để web cập nhật realtime.
 */
export function watchRuleSuggestions() {
  if (watching) return
  watching = true
  bus.on('message', (m: ServerMessage) => {
    let projectId: string | undefined
    if (m.type === 'project') projectId = m.project.id
    else if (m.type === 'permission' && (m.permission.status === 'allowed' || m.permission.status === 'denied'))
      projectId = tasks.get(m.permission.taskId)?.projectId
    const p = projectId ? projects.get(projectId) : undefined
    if (p) broadcast({ type: 'rule_suggestions', projectId: p.id, suggestions: ruleSuggestionsFor(p) })
  })
}
