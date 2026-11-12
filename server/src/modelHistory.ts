// P5-07 (PLAN P5, D5; SPEC FR-76): Lớp 2 — hiệu chỉnh gợi ý của Lớp 1 theo lịch sử từng project.
// Hàm thuần, không đụng DB, không gọi model (D7): chỉ đếm tỉ lệ task được duyệt ngay theo project × tag × model.
import { MODEL_ALIASES, type ModelAlias } from './model.ts'
import { modelAliasLabel, type Suggestion } from './modelPicker.ts'
import { modelTier } from '../../web/src/lib/format.ts'
import type { ReviewAction, Run, Task } from './types.ts'

const DAY = 86_400_000
/** Chỉ xét mẫu trong 90 ngày gần nhất. */
export const HISTORY_DAYS = 90
/** D5: cần ít nhất 10 mẫu mới điều chỉnh. */
export const MIN_SAMPLES = 10
/** Tỉ lệ duyệt ngay ≥ ngưỡng này ở model rẻ hơn → hạ một bậc. */
export const DOWN_RATE = 0.8
/** Tỉ lệ duyệt ngay < ngưỡng này ở model đang gợi ý → nâng một bậc. */
export const UP_RATE = 0.5
/** Tag dùng cho task không có tag nào. */
export const NO_TAG = '(không tag)'

export interface ModelStat {
  /** Số mẫu */
  n: number
  /** Số mẫu được duyệt ngay */
  approvedFirst: number
  /** Trung bình tổng costUsd các run của task */
  avgCost: number
}

/** Key `projectId|tag|tier`. */
export type ModelStats = Map<string, ModelStat>

export const statKey = (projectId: string, tag: string, tier: ModelAlias) => `${projectId}|${tag}|${tier}`

/** Tag đã chuẩn hoá (trim + lowercase, bỏ trùng); không có tag → [NO_TAG]. */
export function tagsOf(tags: string[] | undefined): string[] {
  const out = [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))]
  return out.length ? out : [NO_TAG]
}

/** Run bị coi là lỗi do model: failKind 'claude'; dữ liệu cũ chưa có failKind thì xét exit code khác 0. */
function isFailedRun(r: Run): boolean {
  if (r.failKind) return r.failKind === 'claude'
  return r.endedAt !== undefined && r.exitCode !== undefined && r.exitCode !== 0
}

export interface Sample {
  projectId: string
  tags: string[]
  tier: ModelAlias
  approvedFirst: boolean
  costUsd: number
  /** Thời điểm có kết quả: review approve/reject đầu tiên, hoặc lần cập nhật cuối nếu task Failed không qua review. */
  at: number
}

/**
 * Mẫu của một task (undefined nếu chưa có kết quả, hoặc run đầu tiên không xác định được bậc model).
 * - Mẫu: đã có review approve/reject, hoặc đang Failed.
 * - Tier: của run đầu tiên (initial), lấy từ giá trị đã truyền `--model`, không có thì model thực tế.
 * - Duyệt ngay: review đầu tiên là approve và không có run lỗi nào trước đó.
 */
export function sampleOf(task: Task, taskRuns: Run[], taskReviews: ReviewAction[]): Sample | undefined {
  const reviews = [...taskReviews].sort((a, b) => a.createdAt - b.createdAt)
  const outcome = reviews.find((r) => r.action === 'approve' || r.action === 'reject')
  if (!outcome && task.status !== 'failed') return undefined
  const runs = [...taskRuns].sort((a, b) => a.startedAt - b.startedAt)
  const first = runs.find((r) => r.kind === 'initial') ?? runs[0]
  if (!first) return undefined
  const tier = modelTier(first.requestedModel ?? first.model)
  if (tier === 'other') return undefined
  const firstReview = reviews[0]
  const approvedFirst =
    firstReview?.action === 'approve' && !runs.some((r) => r.startedAt <= firstReview.createdAt && isFailedRun(r))
  return {
    projectId: task.projectId,
    tags: tagsOf(task.tags),
    tier,
    approvedFirst,
    costUsd: runs.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    at: outcome?.createdAt ?? task.updatedAt,
  }
}

/**
 * Thống kê theo `projectId|tag|tier` của các mẫu có kết quả trong [from, now] (mặc định 90 ngày gần nhất).
 * Task nhiều tag được tính vào mỗi tag.
 */
export function computeModelStats(
  tasks: Task[],
  runs: Run[],
  reviews: ReviewAction[],
  now: number,
  from = now - HISTORY_DAYS * DAY,
): ModelStats {
  const runsByTask = group(runs, (r) => r.taskId)
  const reviewsByTask = group(reviews, (r) => r.taskId)
  const acc = new Map<string, { n: number; approvedFirst: number; cost: number }>()
  for (const t of tasks) {
    const s = sampleOf(t, runsByTask.get(t.id) ?? [], reviewsByTask.get(t.id) ?? [])
    if (!s || s.at < from || s.at > now) continue
    for (const tag of s.tags) {
      const k = statKey(s.projectId, tag, s.tier)
      const a = acc.get(k) ?? { n: 0, approvedFirst: 0, cost: 0 }
      a.n++
      if (s.approvedFirst) a.approvedFirst++
      a.cost += s.costUsd
      acc.set(k, a)
    }
  }
  const out: ModelStats = new Map()
  for (const [k, a] of acc) out.set(k, { n: a.n, approvedFirst: a.approvedFirst, avgCost: a.cost / a.n })
  return out
}

function group<T>(list: T[], key: (x: T) => number): Map<number, T[]> {
  const m = new Map<number, T[]>()
  for (const x of list) {
    const k = key(x)
    const arr = m.get(k)
    if (arr) arr.push(x)
    else m.set(k, [x])
  }
  return m
}

const tagLabel = (tag: string) => (tag === NO_TAG ? 'không tag' : `'${tag}'`)

/**
 * D5: điều chỉnh gợi ý của Lớp 1 theo lịch sử, tối đa MỘT bậc.
 * 1. Gợi ý opus, nhóm (P, T, sonnet) n ≥ 10 và rate ≥ 0,8 → hạ xuống sonnet.
 * 2. Gợi ý sonnet, nhóm (P, T, haiku) n ≥ 10 và rate ≥ 0,8 → hạ xuống haiku.
 * 3. Nhóm (P, T, model đang gợi ý) n ≥ 10 và rate < 0,5 → nâng một bậc.
 * Nhiều tag cho kết quả khác nhau: nâng thắng hạ (an toàn chất lượng).
 */
export function adjustSuggestion(suggestion: Suggestion, task: { projectId?: string; tags?: string[] }, stats: ModelStats): Suggestion {
  if (!task.projectId) return suggestion
  const idx = MODEL_ALIASES.indexOf(suggestion.model)
  const up = MODEL_ALIASES[idx + 1] as ModelAlias | undefined
  const down = idx > 0 ? MODEL_ALIASES[idx - 1] : undefined
  let upReason: string | undefined
  let downReason: string | undefined

  for (const tag of tagsOf(task.tags)) {
    const cur = stats.get(statKey(task.projectId, tag, suggestion.model))
    if (up && !upReason && cur && cur.n >= MIN_SAMPLES && cur.approvedFirst / cur.n < UP_RATE)
      upReason = `Lịch sử: chỉ ${cur.approvedFirst}/${cur.n} task ${tagLabel(tag)} dùng ${modelAliasLabel(suggestion.model)} được duyệt ngay → nâng lên ${modelAliasLabel(up)}`
    if (!down || downReason) continue
    const cheap = stats.get(statKey(task.projectId, tag, down))
    if (cheap && cheap.n >= MIN_SAMPLES && cheap.approvedFirst / cheap.n >= DOWN_RATE)
      downReason = `Lịch sử: ${cheap.approvedFirst}/${cheap.n} task ${tagLabel(tag)} dùng ${modelAliasLabel(down)} được duyệt ngay → hạ xuống ${modelAliasLabel(down)}`
  }

  if (up && upReason) return { ...suggestion, model: up, reasons: [...suggestion.reasons, upReason] }
  if (down && downReason) return { ...suggestion, model: down, reasons: [...suggestion.reasons, downReason] }
  return suggestion
}

export interface TagModelRow {
  tag: string
  tier: ModelAlias
  n: number
  approvalRate: number
  avgCost: number
}

/** Gộp thống kê theo tag × tier (cộng mọi project trong `stats`), cho bảng ở trang Thống kê. */
export function tagModelRows(stats: ModelStats): TagModelRow[] {
  const acc = new Map<string, { tag: string; tier: ModelAlias; n: number; ok: number; cost: number }>()
  for (const [k, s] of stats) {
    const [, tag, tier] = splitKey(k)
    const key = `${tag}|${tier}`
    const a = acc.get(key) ?? { tag, tier, n: 0, ok: 0, cost: 0 }
    a.n += s.n
    a.ok += s.approvedFirst
    a.cost += s.avgCost * s.n
    acc.set(key, a)
  }
  return [...acc.values()]
    .map((a) => ({ tag: a.tag, tier: a.tier, n: a.n, approvalRate: a.ok / a.n, avgCost: a.cost / a.n }))
    .sort(
      (a, b) =>
        Number(a.tag === NO_TAG) - Number(b.tag === NO_TAG) ||
        a.tag.localeCompare(b.tag) ||
        MODEL_ALIASES.indexOf(a.tier) - MODEL_ALIASES.indexOf(b.tier),
    )
}

/** Tag do người dùng gõ có thể chứa '|': projectId là phần trước '|' đầu tiên, tier là phần sau '|' cuối cùng. */
function splitKey(k: string): [string, string, ModelAlias] {
  const tagAt = k.indexOf('|')
  const tierAt = k.lastIndexOf('|')
  return [k.slice(0, tagAt), k.slice(tagAt + 1, tierAt), k.slice(tierAt + 1) as ModelAlias]
}
