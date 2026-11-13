// P6 (PLAN P6, B1–B5): budget theo project theo tháng. Hàm thuần, không đụng DB.
// Mọi số tiền là giá niêm yết quy đổi (`total_cost_usd`), luôn hiển thị kèm "ước tính" (B5).
import type { ModelAlias } from './model.ts'
import type { BudgetAction, BudgetLevel, ProjectBudget, Run } from './types.ts'

export type { BudgetLevel }

/** Ngưỡng cảnh báo (B2). */
export const WARN_RATIO = 0.8
/** Sai số khi cộng số thực (tránh 0,1 + 0,7 = 0,7999… bị coi là chưa tới 80%). */
const EPS = 1e-9

export const BUDGET_ACTIONS: BudgetAction[] = ['warn', 'pause']

/** Lý do task Queued không được chạy (B3). Chỉ tính lúc chạy, không lưu DB. */
export const BUDGET_BLOCK_REASON = 'Tạm dừng: project đã vượt budget tháng'

/**
 * Giờ địa phương theo quy ước `Date#getTimezoneOffset()`: số phút UTC − giờ địa phương (UTC+7 → −420).
 * Lấy năm/tháng của thời điểm `now` theo giờ địa phương.
 */
function localYearMonth(now: number, tzOffsetMin: number) {
  const local = new Date(now - tzOffsetMin * 60_000)
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() }
}

/** Đầu tháng (00:00 ngày 1, giờ địa phương) chứa `now`, dạng epoch ms. */
export function monthStart(now: number, tzOffsetMin: number): number {
  const { y, m } = localYearMonth(now, tzOffsetMin)
  return Date.UTC(y, m, 1) + tzOffsetMin * 60_000
}

/** Đầu tháng kế tiếp (giờ địa phương), dạng epoch ms. */
export function nextMonthStart(now: number, tzOffsetMin: number): number {
  const { y, m } = localYearMonth(now, tzOffsetMin)
  return Date.UTC(y, m + 1, 1) + tzOffsetMin * 60_000
}

/** Khoá tháng 'YYYY-MM' theo giờ địa phương. */
export function monthKey(now: number, tzOffsetMin: number): string {
  const { y, m } = localYearMonth(now, tzOffsetMin)
  return `${y}-${String(m + 1).padStart(2, '0')}`
}

/** Tổng `costUsd` của các run thuộc project, bắt đầu từ mốc `from` (epoch ms). */
export function projectSpend(runs: Run[], taskProject: Map<number, string>, projectId: string, from: number): number {
  let sum = 0
  for (const r of runs) if (r.startedAt >= from && r.costUsd && taskProject.get(r.taskId) === projectId) sum += r.costUsd
  return sum
}

/**
 * Mức sử dụng budget. none: không đặt budget; warn: ≥ 80%; over: ≥ 100%.
 * Budget 0 nghĩa là không cho chi gì: luôn 'over' (ratio = 1 khi chưa chi, tránh chia cho 0).
 */
export function budgetStatus(spent: number, budget?: number): { spent: number; budget?: number; ratio?: number; level: BudgetLevel } {
  if (budget === undefined || budget === null || !Number.isFinite(budget) || budget < 0) return { spent, level: 'none' }
  const ratio = budget > 0 ? spent / budget : 1
  const level: BudgetLevel = spent + EPS >= budget ? 'over' : spent + EPS >= budget * WARN_RATIO ? 'warn' : 'ok'
  return { spent, budget, ratio, level }
}

/** B4: project đã ≥ 80% budget thì Lớp 3 không nâng model quá sonnet. */
export function maxTierForLevel(level: BudgetLevel): ModelAlias {
  return level === 'warn' || level === 'over' ? 'sonnet' : 'opus'
}

/** B3: task mới của project có bị chặn không. */
/**
 * Trần chi phí cho một lần chạy: nhỏ nhất giữa giới hạn của task và phần budget tháng còn lại (khi có).
 * undefined = không giới hạn. Đã hết budget thì trả 0 (người gọi không nên chạy).
 */
export function runCap(taskMax: number | undefined, budget?: Pick<ProjectBudget, 'spent' | 'budget'>): number | undefined {
  const caps: number[] = []
  if (taskMax !== undefined && taskMax !== null && Number.isFinite(taskMax) && taskMax > 0) caps.push(taskMax)
  if (budget?.budget !== undefined && budget.budget !== null && Number.isFinite(budget.budget) && budget.budget >= 0)
    caps.push(Math.max(0, Math.round((budget.budget - budget.spent) * 1e6) / 1e6))
  return caps.length ? Math.min(...caps) : undefined
}

export function isBudgetBlocked(action: BudgetAction | undefined, level: BudgetLevel | undefined): boolean {
  return action === 'pause' && level === 'over'
}

// ---------------------------------------------------------------- cảnh báo (B2)

const RANK: Record<BudgetLevel, number> = { none: 0, ok: 0, warn: 1, over: 2 }

/** Khoá settings lưu mức đã báo của project trong tháng. */
export const alertKey = (projectId: string, month: string) => `budgetAlert:${projectId}:${month}`

/**
 * Mức cần báo (B2): chỉ báo khi lên mức cao hơn mức đã báo trong tháng. Nhảy thẳng lên 'over' thì chỉ báo 'over'.
 * Trả về undefined nếu không cần báo.
 */
export function alertToSend(level: BudgetLevel, alreadySent: string | undefined): 'warn' | 'over' | undefined {
  if (level !== 'warn' && level !== 'over') return undefined
  const sent = alreadySent === 'warn' || alreadySent === 'over' ? RANK[alreadySent] : 0
  return RANK[level] > sent ? level : undefined
}

/** $41,20 · $50 (dấu phẩy thập phân, bỏ phần lẻ khi tròn). */
export function formatUsd(n: number): string {
  const r = Math.round(n * 100) / 100
  return `$${Number.isInteger(r) ? String(r) : r.toFixed(2).replace('.', ',')}`
}

/** "Project X đã dùng $41,20 / $50 (82%) budget tháng 11 (ước tính)". */
export function formatBudgetAlert(o: { projectName: string; budget: Pick<ProjectBudget, 'spent' | 'budget' | 'ratio' | 'level' | 'month'>; action: BudgetAction }) {
  const b = o.budget
  const pct = Math.floor((b.ratio ?? 0) * 100 + EPS)
  const month = Number(b.month.slice(5))
  let text = `Project ${o.projectName} đã dùng ${formatUsd(b.spent)} / ${formatUsd(b.budget ?? 0)} (${pct}%) budget tháng ${month} (ước tính)`
  if (b.level === 'over') text += o.action === 'pause' ? '. Đã tạm dừng chạy task mới tới đầu tháng sau.' : '. Đã vượt budget.'
  return text
}

// ---------------------------------------------------------------- kiểm tra dữ liệu nhập

export class BudgetError extends Error {}

/**
 * Số tiền USD ≥ 0, tối đa 2 chữ số thập phân. Rỗng/null → undefined (không giới hạn).
 * `label` dùng trong thông báo lỗi.
 */
export function parseUsd(raw: unknown, label = 'Budget tháng'): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const n = typeof raw === 'string' ? Number(raw.trim().replace(',', '.')) : raw
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new BudgetError(`${label} phải là số (USD)`)
  if (n < 0) throw new BudgetError(`${label} không được âm`)
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) throw new BudgetError(`${label} chỉ được có tối đa 2 chữ số thập phân`)
  if (n > 1_000_000) throw new BudgetError(`${label} quá lớn (tối đa $1.000.000)`)
  return Math.round(n * 100) / 100
}

export function parseBudgetAction(raw: unknown): BudgetAction {
  if (raw === undefined || raw === null || raw === '') return 'warn'
  if (!BUDGET_ACTIONS.includes(raw as BudgetAction)) throw new BudgetError('Hành động khi vượt budget chỉ được là "warn" (cảnh báo) hoặc "pause" (tạm dừng)')
  return raw as BudgetAction
}
