// P6-01: tính budget tháng của từng project từ DB, cảnh báo (B2), chặn hàng đợi (B3), trần model (B4).
// Kết quả được cache; tính lại khi run kết thúc, project/task thay đổi, hoặc sang tháng mới.
import { broadcast, setTaskDecorator } from './bus.ts'
import { kv, projects, runs, settings, tasks, telegramToken } from './db.ts'
import {
  BUDGET_BLOCK_REASON,
  alertKey,
  alertToSend,
  budgetStatus,
  formatBudgetAlert,
  isBudgetBlocked,
  monthKey,
  monthStart,
  nextMonthStart,
  projectSpend,
  runCap,
} from './budget.ts'
import { setBudgetLevelSource } from './escalation.ts'
import { TelegramError, sendTelegram, type TelegramConfig } from './telegram.ts'
import type { BudgetAction, ProjectBudget, Task } from './types.ts'

/** Phụ thuộc có thể thay trong test (đồng hồ, múi giờ, gửi Telegram, log). */
export const budgetDeps = {
  now: () => Date.now(),
  /** Múi giờ của máy chạy server (B1). */
  tzOffsetMin: (at: number) => new Date(at).getTimezoneOffset(),
  sendTelegram: (cfg: TelegramConfig, text: string) => sendTelegram(cfg, text),
  log: (msg: string) => console.warn(msg),
}

let cache: { month: string; budgets: Record<string, ProjectBudget> } | undefined

/** Tính budget của mọi project cho tháng chứa `now` (không có tác dụng phụ). */
export function computeBudgets(now = budgetDeps.now()): Record<string, ProjectBudget> {
  const tz = budgetDeps.tzOffsetMin(now)
  const from = monthStart(now, tz)
  const month = monthKey(now, tz)
  const monthRuns = runs.since(from)
  const taskProject = new Map(tasks.all().map((t) => [t.id, t.projectId]))
  const out: Record<string, ProjectBudget> = {}
  for (const p of projects.all()) {
    const spent = Math.round(projectSpend(monthRuns, taskProject, p.id, from) * 1e6) / 1e6
    out[p.id] = { ...budgetStatus(spent, p.monthlyBudgetUsd), month }
  }
  return out
}

/** Budget hiện tại (cache). Sang tháng mới thì tự tính lại và báo web. */
export function getBudgets(): Record<string, ProjectBudget> {
  const now = budgetDeps.now()
  if (!cache || cache.month !== monthKey(now, budgetDeps.tzOffsetMin(now))) refreshBudgets()
  return cache!.budgets
}

/**
 * Chế độ API key: chi phí là tiền thật nên budget là giới hạn cứng, vượt budget luôn tạm dừng project
 * (bỏ qua lựa chọn "chỉ cảnh báo"). Chế độ gói: theo budgetAction của project như cũ.
 */
export const hardBudget = () => settings.get().auth.mode === 'apiKey'
const actionOf = (action: BudgetAction | undefined): BudgetAction | undefined => (hardBudget() ? 'pause' : action)

const blockedOf = (budgets: Record<string, ProjectBudget>, projectId: string) =>
  isBudgetBlocked(actionOf(projects.get(projectId)?.budgetAction), budgets[projectId]?.level)

/**
 * Trần chi phí (`--max-budget-usd`) cho một lần chạy: giới hạn của task, và ở chế độ API key thêm
 * phần budget tháng còn lại của project. undefined = không giới hạn.
 */
export function runBudgetCap(projectId: string, taskMax?: number): number | undefined {
  return runCap(taskMax, hardBudget() ? getBudgets()[projectId] : undefined)
}

/** B3: project đang bị tạm dừng chạy task mới (pause + vượt budget). */
export function isProjectBlocked(projectId: string): boolean {
  return blockedOf(getBudgets(), projectId)
}

/** Lý do chặn task (chỉ áp dụng task Queued), undefined nếu không bị chặn. */
export function blockedReasonFor(t: Pick<Task, 'status' | 'projectId'>): string | undefined {
  return t.status === 'queued' && isProjectBlocked(t.projectId) ? BUDGET_BLOCK_REASON : undefined
}

/** Gắn `blockedReason` vào task trả qua API/WebSocket. */
export function withBlockedReason(t: Task): Task {
  const reason = blockedReasonFor(t)
  if (reason) return { ...t, blockedReason: reason }
  if (t.blockedReason === undefined) return t
  const { blockedReason: _, ...rest } = t
  return rest
}

/** Thời điểm hết bị chặn (đầu tháng sau), undefined nếu không có project nào đang bị chặn. */
export function budgetWakeAt(): number | undefined {
  const budgets = getBudgets()
  if (!projects.all().some((p) => isBudgetBlocked(actionOf(p.budgetAction), budgets[p.id]?.level))) return undefined
  const now = budgetDeps.now()
  return nextMonthStart(now, budgetDeps.tzOffsetMin(now))
}

/**
 * Tính lại budget, broadcast cho web, gửi cảnh báo (B2) và cập nhật task Queued đổi trạng thái chặn.
 * Gọi khi run kết thúc, project được sửa/xoá, task bị xoá.
 */
export function refreshBudgets(): Record<string, ProjectBudget> {
  const prev = cache
  const budgets = computeBudgets()
  const month = Object.values(budgets)[0]?.month ?? monthKey(budgetDeps.now(), budgetDeps.tzOffsetMin(budgetDeps.now()))
  cache = { month, budgets }
  broadcast({ type: 'budgets', budgets })

  for (const p of projects.all()) {
    const b = budgets[p.id]
    if (!b) continue
    sendAlertIfNeeded(p.id, p.name, actionOf(p.budgetAction) ?? 'warn', b)
    // Task Queued của project vừa bị chặn / hết bị chặn: gửi lại để web thấy blockedReason.
    const was = prev ? blockedOf(prev.budgets, p.id) : false
    if (was !== blockedOf(budgets, p.id))
      for (const t of tasks.byStatus('queued')) if (t.projectId === p.id) broadcast({ type: 'task', task: t })
  }
  return budgets
}

function sendAlertIfNeeded(projectId: string, projectName: string, action: 'warn' | 'pause', b: ProjectBudget) {
  const key = alertKey(projectId, b.month)
  const level = alertToSend(b.level, kv.get(key))
  if (!level) return
  kv.set(key, level) // ghi trước khi gửi: lỗi gửi cũng không báo lặp (B2: mỗi mức một lần mỗi tháng)
  const message = formatBudgetAlert({ projectName, budget: b, action })
  broadcast({ type: 'budget_alert', projectId, level, month: b.month, message })
  const s = settings.get()
  const token = telegramToken.get()
  if (!s.telegram.enabled || !s.telegram.chatId || !token) return
  const icon = level === 'over' ? '⛔' : '⚠️'
  budgetDeps.sendTelegram({ token, chatId: s.telegram.chatId }, `${icon} ${message}`).catch((e) => {
    budgetDeps.log(`Gửi Telegram cảnh báo budget của project ${projectId} thất bại: ${e instanceof TelegramError ? e.message : 'lỗi không xác định'}`)
  })
}

/** Chỉ dùng trong test: xoá cache để tính lại từ đầu. */
export function resetBudgetCache() {
  cache = undefined
}

// Nối vào các module dùng chung: mọi task gửi ra web đều kèm blockedReason; Lớp 3 đọc trần model theo budget.
setTaskDecorator(withBlockedReason)
setBudgetLevelSource((projectId) => getBudgets()[projectId]?.level ?? 'none')
