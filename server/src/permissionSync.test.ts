// FR-48: đổi mức quyền project → áp dụng cho task chưa chạy (Backlog, Queued, Failed) nếu người dùng đồng ý.
// DB in-memory, không spawn agent.
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard sync '))
process.env.TASKBOARD_DB = ':memory:'
const { db, projects, tasks } = await import('./db.ts')
const { routes } = await import('./routes.ts')
const { planPermissionSync } = await import('./permissionSync.ts')
const { default: Fastify } = await import('fastify')
import type { PermissionMode, PermissionSyncPlan, Project, Task } from './types.ts'

const app = Fastify()
await app.register(routes)
after(async () => {
  await app.close()
})

const P1: Project = {
  id: 'p1',
  name: 'p1',
  repoPath: process.env.TASKBOARD_DATA!,
  mainBranch: 'main',
  permissionMode: 'acceptEdits',
  allowedTools: [],
  maxParallel: 1,
  budgetAction: 'warn',
  deliveryMode: 'direct',
}

const mk = (status: Task['status'], permissionMode: PermissionMode = 'acceptEdits', extra: Partial<Task> = {}, projectId = 'p1') => {
  const t = tasks.create({ projectId, title: `t-${status}-${permissionMode}`, prompt: 'làm gì đó đủ dài', status, priority: 'normal', permissionMode, tags: [] })
  return Object.keys(extra).length ? tasks.patch(t.id, extra)! : t
}

beforeEach(() => {
  db.exec('DELETE FROM tasks')
  projects.upsert(P1)
  projects.upsert({ ...P1, id: 'p2', name: 'p2' })
})

const ids = (l: { id: number }[]) => l.map((t) => t.id)

test('plan: chỉ task của project ở Backlog, Queued, Failed có mức quyền khác', () => {
  const backlog = mk('backlog')
  const queued = mk('queued', 'manual')
  const failed = mk('failed')
  const same = mk('backlog', 'auto')
  for (const s of ['running', 'needs_input', 'review', 'done'] as const) mk(s)
  mk('backlog', 'acceptEdits', {}, 'p2')
  const plan = planPermissionSync(P1, 'auto', tasks.all(), { defaultAgent: 'claude' })
  assert.deepEqual(ids(plan.apply), [backlog.id, queued.id, failed.id])
  assert.ok(!ids(plan.apply).includes(same.id))
  assert.deepEqual(plan.skippedPlan, [])
  assert.deepEqual(plan.skippedAgent, [])
})

test('plan: task Plan bị bỏ qua khi mức mới không phải Plan, được đổi khi mức mới là Plan', () => {
  const p = mk('backlog', 'plan')
  const loosen = planPermissionSync(P1, 'auto', tasks.all(), { defaultAgent: 'claude' })
  assert.deepEqual(ids(loosen.skippedPlan), [p.id])
  assert.deepEqual(loosen.apply, [])
  const e = mk('queued', 'acceptEdits')
  const toPlan = planPermissionSync(P1, 'plan', tasks.all(), { defaultAgent: 'claude' })
  assert.deepEqual(ids(toPlan.apply), [e.id])
  assert.deepEqual(toPlan.skippedPlan, [])
})

test('plan: task chọn agent không chạy được ở mức mới bị bỏ qua kèm lý do', () => {
  const t = mk('backlog', 'acceptEdits', { agent: 'cursor' })
  const plan = planPermissionSync(P1, 'manual', tasks.all(), { defaultAgent: 'claude' })
  assert.deepEqual(ids(plan.skippedAgent), [t.id])
  assert.match(plan.skippedAgent[0].reason, /Cursor/)
})

const preview = (body: object) => app.inject({ method: 'POST', url: '/api/projects/permission-sync', payload: body })
const save = (body: object) => app.inject({ method: 'POST', url: '/api/projects', payload: { ...P1, ...body } })

test('POST /api/projects/permission-sync: trả kế hoạch, không đổi gì', async () => {
  const t = mk('backlog')
  const res = await preview({ id: 'p1', permissionMode: 'manual' })
  assert.equal(res.statusCode, 200)
  const plan = res.json() as PermissionSyncPlan
  assert.equal(plan.mode, 'manual')
  assert.deepEqual(ids(plan.apply), [t.id])
  assert.equal(tasks.get(t.id)!.permissionMode, 'acceptEdits')
  assert.equal(projects.get('p1')!.permissionMode, 'acceptEdits')
})

test('POST /api/projects/permission-sync: project không có → 404, mức quyền sai → 400', async () => {
  assert.equal((await preview({ id: 'nope', permissionMode: 'manual' })).statusCode, 404)
  assert.equal((await preview({ id: 'p1', permissionMode: 'bypassPermissions' })).statusCode, 400)
})

test('lưu project kèm syncTaskPermissions: đổi task chưa chạy, giữ task Plan và task đang chạy', async () => {
  const backlog = mk('backlog')
  const failed = mk('failed', 'manual')
  const plan = mk('queued', 'plan')
  const running = mk('running')
  const res = await save({ permissionMode: 'auto', syncTaskPermissions: true })
  assert.equal(res.statusCode, 200)
  assert.equal(projects.get('p1')!.permissionMode, 'auto')
  assert.equal(tasks.get(backlog.id)!.permissionMode, 'auto')
  assert.equal(tasks.get(failed.id)!.permissionMode, 'auto')
  assert.equal(tasks.get(plan.id)!.permissionMode, 'plan')
  assert.equal(tasks.get(running.id)!.permissionMode, 'acceptEdits')
})

test('lưu project không kèm syncTaskPermissions ("Chỉ đổi project"): task giữ mức cũ', async () => {
  const t = mk('backlog')
  const res = await save({ permissionMode: 'manual' })
  assert.equal(res.statusCode, 200)
  assert.equal(projects.get('p1')!.permissionMode, 'manual')
  assert.equal(tasks.get(t.id)!.permissionMode, 'acceptEdits')
})

test('syncTaskPermissions khi mức quyền project không đổi: không đụng task', async () => {
  const t = mk('backlog', 'manual')
  const res = await save({ permissionMode: 'acceptEdits', syncTaskPermissions: true })
  assert.equal(res.statusCode, 200)
  assert.equal(tasks.get(t.id)!.permissionMode, 'manual')
})

test('lưu bị lỗi kiểm tra: không đổi project lẫn task', async () => {
  const t = mk('backlog')
  const res = await save({ name: '', permissionMode: 'manual', syncTaskPermissions: true })
  assert.equal(res.statusCode, 400)
  assert.equal(projects.get('p1')!.permissionMode, 'acceptEdits')
  assert.equal(tasks.get(t.id)!.permissionMode, 'acceptEdits')
})
