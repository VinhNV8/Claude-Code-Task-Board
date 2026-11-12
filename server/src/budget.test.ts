// P6-01: hàm thuần của budget (tháng theo giờ địa phương, chi tiêu, mức, cảnh báo, kiểm tra dữ liệu nhập).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BudgetError,
  alertToSend,
  budgetStatus,
  formatBudgetAlert,
  formatUsd,
  isBudgetBlocked,
  maxTierForLevel,
  monthKey,
  monthStart,
  nextMonthStart,
  parseBudgetAction,
  parseUsd,
  projectSpend,
} from './budget.ts'
import type { Run } from './types.ts'

/** UTC+7 theo quy ước getTimezoneOffset(). */
const VN = -420
/** Giờ Việt Nam → epoch ms. */
const vn = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) + VN * 60_000

test('monthStart UTC+7: 30/11/2026 23:30 giờ VN vẫn thuộc tháng 11', () => {
  const now = vn(2026, 11, 30, 23, 30) // = 16:30 UTC cùng ngày
  assert.equal(now, Date.UTC(2026, 10, 30, 16, 30))
  assert.equal(monthKey(now, VN), '2026-11')
  assert.equal(monthStart(now, VN), vn(2026, 11, 1))
  assert.equal(monthStart(now, VN), Date.UTC(2026, 9, 31, 17, 0)) // 00:00 1/11 VN = 17:00 31/10 UTC
  assert.equal(nextMonthStart(now, VN), vn(2026, 12, 1))
})

test('monthStart UTC+7: 01/11 00:30 giờ VN (còn là 31/10 theo UTC) đã thuộc tháng 11', () => {
  const now = vn(2026, 11, 1, 0, 30)
  assert.equal(new Date(now).getUTCMonth(), 9) // theo UTC vẫn là tháng 10
  assert.equal(monthKey(now, VN), '2026-11')
  assert.equal(monthStart(now, VN), vn(2026, 11, 1))
})

test('đổi tháng: đúng 00:00 ngày 1 là tháng mới; cuối năm sang năm sau', () => {
  const start = vn(2026, 12, 1)
  assert.equal(monthKey(start, VN), '2026-12')
  assert.equal(monthKey(start - 1, VN), '2026-11')
  assert.equal(monthStart(start, VN), start)
  const dec = vn(2026, 12, 31, 23, 59)
  assert.equal(nextMonthStart(dec, VN), vn(2027, 1, 1))
  assert.equal(monthKey(nextMonthStart(dec, VN), VN), '2027-01')
  // UTC
  assert.equal(monthStart(Date.UTC(2026, 1, 28, 23, 59), 0), Date.UTC(2026, 1, 1))
  assert.equal(nextMonthStart(Date.UTC(2026, 1, 28, 23, 59), 0), Date.UTC(2026, 2, 1))
})

test('projectSpend: chỉ cộng run của project, từ mốc from, bỏ run không có chi phí', () => {
  const from = vn(2026, 11, 1)
  const run = (taskId: number, startedAt: number, costUsd?: number) => ({ id: `${taskId}-${startedAt}`, taskId, kind: 'initial', startedAt, costUsd }) as Run
  const runs = [
    run(1, from, 1.25), // đúng mốc: tính
    run(1, from - 1, 100), // tháng trước
    run(2, from + 10, 2.5),
    run(3, from + 20, 7), // project khác
    run(1, from + 30), // chưa có chi phí
    run(99, from + 40, 5), // task không còn
  ]
  const map = new Map([
    [1, 'a'],
    [2, 'a'],
    [3, 'b'],
  ])
  assert.equal(projectSpend(runs, map, 'a', from), 3.75)
  assert.equal(projectSpend(runs, map, 'b', from), 7)
  assert.equal(projectSpend(runs, map, 'c', from), 0)
})

test('budgetStatus: ratio và level ở các mốc 79,99% / 80% / 99,99% / 100%', () => {
  const s = budgetStatus(79.99, 100)
  assert.equal(s.level, 'ok')
  assert.ok(Math.abs(s.ratio! - 0.7999) < 1e-12)
  assert.equal(s.budget, 100)
  assert.equal(budgetStatus(80, 100).level, 'warn')
  assert.equal(budgetStatus(80, 100).ratio, 0.8)
  assert.equal(budgetStatus(99.99, 100).level, 'warn')
  assert.equal(budgetStatus(100, 100).level, 'over')
  assert.equal(budgetStatus(130, 100).level, 'over')
  assert.equal(budgetStatus(130, 100).ratio, 1.3)
  assert.equal(budgetStatus(0, 100).level, 'ok')
  // Sai số số thực: 0,1 + 0,7 = 0,7999… vẫn là 80%
  assert.equal(budgetStatus(0.1 + 0.7, 1).level, 'warn')
})

test('budgetStatus: budget 0 luôn vượt; không đặt budget → none, không có ratio', () => {
  assert.deepEqual(budgetStatus(0, 0), { spent: 0, budget: 0, ratio: 1, level: 'over' })
  assert.equal(budgetStatus(3, 0).level, 'over')
  assert.deepEqual(budgetStatus(12.5), { spent: 12.5, level: 'none' })
  assert.deepEqual(budgetStatus(12.5, undefined), { spent: 12.5, level: 'none' })
})

test('B3/B4: chặn chỉ khi pause + over; trần model sonnet khi warn/over', () => {
  assert.equal(isBudgetBlocked('pause', 'over'), true)
  assert.equal(isBudgetBlocked('pause', 'warn'), false)
  assert.equal(isBudgetBlocked('warn', 'over'), false)
  assert.equal(isBudgetBlocked(undefined, 'over'), false)
  assert.equal(maxTierForLevel('none'), 'opus')
  assert.equal(maxTierForLevel('ok'), 'opus')
  assert.equal(maxTierForLevel('warn'), 'sonnet')
  assert.equal(maxTierForLevel('over'), 'sonnet')
})

test('alertToSend: mỗi mức một lần, nhảy thẳng lên over chỉ báo over', () => {
  assert.equal(alertToSend('ok', undefined), undefined)
  assert.equal(alertToSend('none', undefined), undefined)
  assert.equal(alertToSend('warn', undefined), 'warn')
  assert.equal(alertToSend('warn', 'warn'), undefined)
  assert.equal(alertToSend('over', 'warn'), 'over')
  assert.equal(alertToSend('over', undefined), 'over')
  assert.equal(alertToSend('over', 'over'), undefined)
  assert.equal(alertToSend('warn', 'over'), undefined) // đã báo over thì không báo lại warn
})

test('formatBudgetAlert: số tiền kiểu Việt Nam, phần trăm, tháng, "ước tính"', () => {
  assert.equal(formatUsd(41.2), '$41,20')
  assert.equal(formatUsd(50), '$50')
  assert.equal(formatUsd(0.005), '$0,01')
  const warn = formatBudgetAlert({ projectName: 'X', action: 'warn', budget: { spent: 41.2, budget: 50, ratio: 0.824, level: 'warn', month: '2026-11' } })
  assert.equal(warn, 'Project X đã dùng $41,20 / $50 (82%) budget tháng 11 (ước tính)')
  const over = formatBudgetAlert({ projectName: 'X', action: 'pause', budget: { spent: 51, budget: 50, ratio: 1.02, level: 'over', month: '2026-01' } })
  assert.match(over, /^Project X đã dùng \$51 \/ \$50 \(102%\) budget tháng 1 \(ước tính\)\. Đã tạm dừng/)
})

test('parseUsd: số ≥ 0, tối đa 2 chữ số thập phân, rỗng = không giới hạn, lỗi tiếng Việt', () => {
  assert.equal(parseUsd(undefined), undefined)
  assert.equal(parseUsd(null), undefined)
  assert.equal(parseUsd(''), undefined)
  assert.equal(parseUsd(50), 50)
  assert.equal(parseUsd(0), 0)
  assert.equal(parseUsd(12.34), 12.34)
  assert.equal(parseUsd('12,5'), 12.5)
  assert.equal(parseUsd(0.1 + 0.2), 0.3)
  assert.throws(() => parseUsd(-1), (e: Error) => e instanceof BudgetError && /không được âm/.test(e.message))
  assert.throws(() => parseUsd(1.234), /tối đa 2 chữ số thập phân/)
  assert.throws(() => parseUsd('abc'), /phải là số/)
  assert.throws(() => parseUsd(Number.POSITIVE_INFINITY), /phải là số/)
  assert.throws(() => parseUsd(true), /phải là số/)
})

test('parseBudgetAction: mặc định warn, chỉ nhận warn/pause', () => {
  assert.equal(parseBudgetAction(undefined), 'warn')
  assert.equal(parseBudgetAction('pause'), 'pause')
  assert.equal(parseBudgetAction('warn'), 'warn')
  assert.throws(() => parseBudgetAction('stop'), BudgetError)
})

test('--max-budget-usd: chỉ truyền khi task có giới hạn > 0', async () => {
  const { buildClaudeArgs } = await import('./permissionTool.ts')
  const base = { sessionId: 's', resume: false, permissionMode: 'acceptEdits', allowedTools: ['Read'] }
  const args = buildClaudeArgs({ ...base, maxBudgetUsd: 2.5 })
  const i = args.indexOf('--max-budget-usd')
  assert.ok(i > 0)
  assert.equal(args[i + 1], '2.5')
  assert.ok(i < args.indexOf('--allowedTools')) // --allowedTools nhận nhiều giá trị nên phải ở cuối
  assert.ok(!buildClaudeArgs(base).includes('--max-budget-usd'))
  assert.ok(!buildClaudeArgs({ ...base, maxBudgetUsd: 0 }).includes('--max-budget-usd'))
})
