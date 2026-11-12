// Hiển thị budget tháng theo project (PLAN P6, B1–B5). Hàm thuần, server test được (server/src/budgetUi.test.ts).
// Mọi số tiền là giá niêm yết quy đổi: luôn hiện kèm chữ "ước tính" (B5).
import type { BudgetLevel, Project, ProjectBudget } from '../types'

/** Ngưỡng cảnh báo (B2). Trùng với server/src/budget.ts. */
export const WARN_RATIO = 0.8
const EPS = 1e-9

/** $12,40 · $50 (dấu phẩy thập phân, bỏ phần lẻ khi tròn). Giống formatUsd ở server. */
export function formatUsd(n: number): string {
  const r = Math.round(n * 100) / 100
  return `$${Number.isInteger(r) ? String(r) : r.toFixed(2).replace('.', ',')}`
}

/** 'YYYY-MM' → "tháng 11". */
export function monthLabel(month: string): string {
  return `tháng ${Number(month.slice(5, 7))}`
}

/** 'YYYY-MM' theo giờ địa phương của trình duyệt. */
export function currentMonth(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Mức theo tỉ lệ: không đặt budget → none; < 80% ok; 80–99% warn; ≥ 100% over. Budget 0 luôn over (như server). */
export function levelOf(spent: number, limit: number | undefined): BudgetLevel {
  if (limit === undefined || limit === null || !Number.isFinite(limit) || limit < 0) return 'none'
  if (spent + EPS >= limit) return 'over'
  if (spent + EPS >= limit * WARN_RATIO) return 'warn'
  return 'ok'
}

export interface BudgetView {
  spent: number
  /** Không có: không giới hạn */
  limit?: number
  /** 0..1 để vẽ thanh (đã chặn ở 1) */
  fill: number
  /** Phần trăm thật (có thể > 100) */
  percent: number
  level: BudgetLevel
  month: string
}

/**
 * Số liệu hiển thị của một project. Hạn mức lấy từ project (vừa lưu form là đổi ngay, không chờ server tính lại),
 * số đã chi lấy từ bảng budgets do server gửi (chưa có thì coi là 0).
 */
export function budgetView(project: Pick<Project, 'monthlyBudgetUsd'>, budget: ProjectBudget | undefined, now: number): BudgetView {
  const spent = budget?.spent ?? 0
  const limit = project.monthlyBudgetUsd ?? undefined
  const level = levelOf(spent, limit)
  const ratio = limit === undefined ? 0 : limit > 0 ? spent / limit : 1
  return {
    spent,
    limit,
    fill: Math.max(0, Math.min(1, ratio)),
    percent: Math.floor(ratio * 100 + EPS),
    level,
    month: budget?.month ?? currentMonth(now),
  }
}

/** Màu thanh tiến độ theo mức: < 80% bình thường, 80–99% vàng, ≥ 100% đỏ. */
export const BUDGET_TONE: Record<BudgetLevel, { bar: string; text: string }> = {
  none: { bar: 'bg-indigo-500', text: 'text-slate-600 dark:text-slate-300' },
  ok: { bar: 'bg-indigo-500', text: 'text-slate-600 dark:text-slate-300' },
  warn: { bar: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400' },
  over: { bar: 'bg-rose-500', text: 'text-rose-700 dark:text-rose-400' },
}

/** Số ngày của tháng chứa `now` (giờ địa phương). */
export function daysInMonth(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
}

/**
 * Dự báo chi tiêu cuối tháng: spent / số ngày đã qua × số ngày trong tháng.
 * "Số ngày đã qua" tính cả hôm nay (ngày 1 → 1) để không chia cho 0.
 */
export function forecastMonthEnd(spent: number, now: number): number {
  const elapsed = new Date(now).getDate()
  return (spent / elapsed) * daysInMonth(now)
}

/**
 * Giá trị nhập ở form ("12,5", "", "50") → số USD, hoặc undefined nếu để trống (không giới hạn).
 * Trả về chuỗi lỗi tiếng Việt nếu sai. Server kiểm tra lại (parseUsd).
 */
export function parseBudgetInput(raw: string): { value?: number; error?: string } {
  const s = raw.trim()
  if (!s) return {}
  const n = Number(s.replace(',', '.'))
  if (!Number.isFinite(n)) return { error: 'Budget tháng phải là số (USD)' }
  if (n < 0) return { error: 'Budget tháng không được âm' }
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return { error: 'Budget tháng chỉ được có tối đa 2 chữ số thập phân' }
  return { value: Math.round(n * 100) / 100 }
}
