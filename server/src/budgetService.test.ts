// P6-01: budget theo project với DB thật (in-memory): tạm dừng hàng đợi (B3), cảnh báo một lần mỗi tháng (B2),
// chạy tay bị từ chối 409, trần model (B4). Runner dùng launcher giả nên không spawn Claude thật.
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard budget '))
process.env.TASKBOARD_DB = ':memory:'
const { kv, projects, runs, settings, tasks, telegramToken } = await import('./db.ts')
const { bus } = await import('./bus.ts')
const { pump, setLauncherForTest } = await import('./runner.ts')
const svc = await import('./budgetService.ts')
const { BUDGET_BLOCK_REASON } = await import('./budget.ts')
const { maxTierForProject } = await import('./escalation.ts')
const { routes } = await import('./routes.ts')
const { default: Fastify } = await import('fastify')
import type { Project, Task } from './types.ts'

const VN = -420
const vn = (y: number, mo: number, d: number, h = 0) => Date.UTC(y, mo - 1, d, h) + VN * 60_000
let now = vn(2026, 11, 15, 10)
svc.budgetDeps.now = () => now
svc.budgetDeps.tzOffsetMin = () => VN
const sent: string[] = []
svc.budgetDeps.sendTelegram = async (_cfg, text) => void sent.push(text)
svc.budgetDeps.log = () => {}

const launched: number[] = []
setLauncherForTest((t) => {
  launched.push(t.id)
  tasks.patch(t.id, { status: 'running' }) // giữ slot như runner thật
})

const app = Fastify()
await app.register(routes)
after(async () => {
  setLauncherForTest()
  await app.close()
})

const alerts: { projectId: string; level: string; message: string }[] = []
const taskMsgs: Task[] = []
bus.on('message', (m: { type: string; projectId?: string; level?: string; message?: string; task?: Task }) => {
  if (m.type === 'budget_alert') alerts.push({ projectId: m.projectId!, level: m.level!, message: m.message! })
  if (m.type === 'task') taskMsgs.push(m.task!)
})

settings.set({ ...settings.get(), maxParallel: 5 })

function mkProject(id: string, p: Partial<Project>) {
  return projects.upsert({
    id,
    name: id.toUpperCase(),
    repoPath: process.env.TASKBOARD_DATA!,
    mainBranch: 'main',
    permissionMode: 'acceptEdits',
    allowedTools: [],
    maxParallel: 5,
    budgetAction: 'warn',
    ...p,
  })
}
const mkTask = (projectId: string, status: Task['status'] = 'queued') =>
  tasks.create({ projectId, title: 't', prompt: 'làm gì đó', status, priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
/** Ghi một run đã xong có chi phí, bắt đầu lúc `at`. */
function spend(projectId: string, costUsd: number, at = now) {
  const t = mkTask(projectId, 'done')
  const id = randomUUID()
  runs.create({ id, taskId: t.id, kind: 'initial', startedAt: at })
  runs.finish(id, { endedAt: at + 1000, exitCode: 0, costUsd })
}

beforeEach(() => {
  launched.length = 0
  alerts.length = 0
  sent.length = 0
  taskMsgs.length = 0
})

test('pump: project pause + vượt budget → task Queued không chạy, có blockedReason; sang tháng mới → chạy lại', () => {
  now = vn(2026, 11, 15, 10)
  mkProject('pp', { budgetAction: 'pause', monthlyBudgetUsd: 10 })
  spend('pp', 6, vn(2026, 10, 31, 23)) // tháng trước: không tính
  spend('pp', 10.5)
  const t = mkTask('pp')
  svc.refreshBudgets()
  assert.equal(svc.getBudgets().pp.level, 'over')
  assert.equal(svc.getBudgets().pp.spent, 10.5)
  assert.equal(svc.getBudgets().pp.month, '2026-11')

  pump()
  assert.ok(!launched.includes(t.id))
  assert.equal(tasks.get(t.id)!.status, 'queued')
  assert.equal(tasks.get(t.id)!.failReason, undefined) // không dùng failReason
  assert.equal(svc.withBlockedReason(tasks.get(t.id)!).blockedReason, BUDGET_BLOCK_REASON)
  // Task Queued của project vừa bị chặn được gửi lại kèm blockedReason
  assert.ok(taskMsgs.some((m) => m.id === t.id && m.blockedReason === BUDGET_BLOCK_REASON))
  // blockedReason không lưu DB
  assert.equal(tasks.get(t.id)!.blockedReason, undefined)
  // Hẹn chạy lại đầu tháng sau
  assert.equal(svc.budgetWakeAt(), vn(2026, 12, 1))

  // Sang tháng mới: chi tiêu về 0, hết bị chặn
  now = vn(2026, 12, 1, 0) + 1
  pump()
  assert.ok(launched.includes(t.id))
  assert.equal(svc.getBudgets().pp.month, '2026-12')
  assert.equal(svc.getBudgets().pp.level, 'ok')
})

test('pump: project warn + vượt budget → vẫn chạy', () => {
  now = vn(2026, 11, 15, 10)
  mkProject('pw', { budgetAction: 'warn', monthlyBudgetUsd: 5 })
  spend('pw', 9)
  const t = mkTask('pw')
  svc.refreshBudgets()
  assert.equal(svc.getBudgets().pw.level, 'over')
  pump()
  assert.ok(launched.includes(t.id))
  assert.equal(svc.withBlockedReason(mkTask('pw')).blockedReason, undefined)
})

test('pump: tăng budget (sửa project) → hết bị chặn và chạy', () => {
  now = vn(2026, 11, 15, 10)
  mkProject('pr', { budgetAction: 'pause', monthlyBudgetUsd: 1 })
  spend('pr', 2)
  const t = mkTask('pr')
  svc.refreshBudgets()
  pump()
  assert.ok(!launched.includes(t.id))
  mkProject('pr', { budgetAction: 'pause', monthlyBudgetUsd: 100 })
  svc.refreshBudgets()
  pump()
  assert.ok(launched.includes(t.id))
})

test('chạy tay khi project pause đang vượt budget → 409 tiếng Việt; task vẫn ở Queued', async () => {
  now = vn(2026, 11, 15, 10)
  mkProject('pm', { budgetAction: 'pause', monthlyBudgetUsd: 0 }) // budget 0: luôn vượt
  svc.refreshBudgets()
  const t = mkTask('pm', 'backlog')
  const res = await app.inject({ method: 'POST', url: `/api/tasks/${t.id}/run` })
  assert.equal(res.statusCode, 409)
  assert.match(res.json().error, /vượt budget tháng/)
  assert.equal(tasks.get(t.id)!.status, 'backlog')
  assert.ok(!launched.includes(t.id))
})

test('/api/state trả budgets và blockedReason', async () => {
  now = vn(2026, 11, 15, 10)
  mkProject('ps', { budgetAction: 'pause', monthlyBudgetUsd: 2 })
  spend('ps', 3)
  const t = mkTask('ps')
  svc.refreshBudgets()
  const res = await app.inject({ method: 'GET', url: '/api/state' })
  const body = res.json() as { budgets: Record<string, unknown>; tasks: Task[] }
  assert.deepEqual(body.budgets.ps, { spent: 3, budget: 2, ratio: 1.5, level: 'over', month: '2026-11' })
  assert.equal(body.tasks.find((x) => x.id === t.id)!.blockedReason, BUDGET_BLOCK_REASON)
})

test('B2: cảnh báo warn và over mỗi mức một lần mỗi tháng, toast + Telegram khi bật', () => {
  now = vn(2026, 11, 15, 10)
  settings.set({ ...settings.get(), telegram: { ...settings.get().telegram, enabled: true, chatId: '123456' } })
  telegramToken.set('123456:' + 'a'.repeat(35))
  mkProject('pa', { budgetAction: 'warn', monthlyBudgetUsd: 50 })
  spend('pa', 41.2)
  svc.refreshBudgets()
  assert.deepEqual(
    alerts.filter((a) => a.projectId === 'pa').map((a) => a.level),
    ['warn'],
  )
  assert.equal(alerts.find((a) => a.projectId === 'pa')!.message, 'Project PA đã dùng $41,20 / $50 (82%) budget tháng 11 (ước tính)')
  assert.equal(kv.get('budgetAlert:pa:2026-11'), 'warn')
  assert.ok(sent.some((s) => s.includes('Project PA đã dùng $41,20')))

  // Tính lại nhiều lần trong cùng tháng: không báo lặp
  svc.refreshBudgets()
  spend('pa', 1)
  svc.refreshBudgets()
  assert.equal(alerts.filter((a) => a.projectId === 'pa').length, 1)

  // Lên over: báo một lần
  spend('pa', 10)
  svc.refreshBudgets()
  svc.refreshBudgets()
  assert.deepEqual(
    alerts.filter((a) => a.projectId === 'pa').map((a) => a.level),
    ['warn', 'over'],
  )
  assert.equal(kv.get('budgetAlert:pa:2026-11'), 'over')
  assert.equal(sent.filter((s) => s.includes('Project PA')).length, 2)

  // Tháng sau vượt lại: báo lại (khoá theo tháng)
  now = vn(2026, 12, 3, 9)
  spend('pa', 60)
  svc.refreshBudgets()
  assert.deepEqual(
    alerts.filter((a) => a.projectId === 'pa').map((a) => a.level),
    ['warn', 'over', 'over'],
  )
  assert.equal(kv.get('budgetAlert:pa:2026-12'), 'over')
  settings.set({ ...settings.get(), telegram: { ...settings.get().telegram, enabled: false } })
})

test('B2: Telegram tắt thì chỉ có toast; project không đặt budget thì không báo', () => {
  now = vn(2026, 11, 15, 10)
  mkProject('pt', { monthlyBudgetUsd: 10 })
  mkProject('pn', {})
  spend('pt', 9)
  spend('pn', 1000)
  svc.refreshBudgets()
  assert.deepEqual(
    alerts.map((a) => a.projectId),
    ['pt'],
  )
  assert.equal(sent.length, 0)
  assert.equal(svc.getBudgets().pn.level, 'none')
  assert.equal(svc.getBudgets().pn.ratio, undefined)
})

test('B4: maxTierForProject trả sonnet khi ≥ 80%, opus khi chưa tới hoặc không đặt budget', () => {
  now = vn(2026, 11, 15, 10)
  mkProject('b4warn', { monthlyBudgetUsd: 10 })
  mkProject('b4ok', { monthlyBudgetUsd: 10 })
  mkProject('b4none', {})
  spend('b4warn', 8)
  spend('b4ok', 7.99)
  svc.refreshBudgets()
  assert.equal(maxTierForProject('b4warn'), 'sonnet')
  assert.equal(maxTierForProject('b4ok'), 'opus')
  assert.equal(maxTierForProject('b4none'), 'opus')
  assert.equal(maxTierForProject('khong-ton-tai'), 'opus')
})

test('DB: lưu và đọc monthlyBudgetUsd / budgetAction / maxCostUsd', () => {
  const p = mkProject('pdb', { monthlyBudgetUsd: 12.34, budgetAction: 'pause' })
  assert.equal(p.monthlyBudgetUsd, 12.34)
  assert.equal(p.budgetAction, 'pause')
  const cleared = mkProject('pdb', { monthlyBudgetUsd: undefined })
  assert.equal(cleared.monthlyBudgetUsd, undefined)
  assert.equal(cleared.budgetAction, 'warn')
  const t = tasks.create({ projectId: 'pdb', title: 't', prompt: 'x', status: 'backlog', priority: 'normal', permissionMode: 'acceptEdits', tags: [], maxCostUsd: 2.5 })
  assert.equal(t.maxCostUsd, 2.5)
  assert.equal(tasks.patch(t.id, { maxCostUsd: null })!.maxCostUsd, undefined)
})
