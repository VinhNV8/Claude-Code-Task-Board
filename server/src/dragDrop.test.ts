// Kéo thả trên Bảng công việc: kiểm tra các API mà mỗi thao tác thả gọi tới
// (queue / unqueue / run / stop) chuyển trạng thái đúng và từ chối chuyển không hợp lệ.
// Project có maxParallel = 0 nên runner không bao giờ spawn Claude thật trong test.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard dnd '))
process.env.TASKBOARD_DB = ':memory:'
const { projects, tasks } = await import('./db.ts')
const { routes } = await import('./routes.ts')
const { default: Fastify } = await import('fastify')
import type { TaskStatus } from './types.ts'

const app = Fastify()
await app.register(routes)
after(() => app.close())

projects.upsert({
  id: 'dnd',
  name: 'DnD',
  repoPath: process.env.TASKBOARD_DATA!,
  mainBranch: 'main',
  permissionMode: 'manual',
  allowedTools: [],
  maxParallel: 0, // không còn slot: /run phải đưa task vào hàng đợi thay vì chạy
  budgetAction: 'warn' as const,
  deliveryMode: 'worktree' as const,
})

const mk = (status: TaskStatus) =>
  tasks.create({ projectId: 'dnd', title: `t-${status}`, prompt: 'x', status, priority: 'normal', permissionMode: 'manual', tags: [] })
const post = (id: number, action: string) => app.inject({ method: 'POST', url: `/api/tasks/${id}/${action}` })
const statusOf = (id: number) => tasks.get(id)!.status

test('Backlog → Queued: /queue đưa task vào hàng đợi', async () => {
  const t = mk('backlog')
  const res = await post(t.id, 'queue')
  assert.equal(res.statusCode, 200)
  assert.equal(statusOf(t.id), 'queued')
})

test('Queued → Backlog: /unqueue bỏ task khỏi hàng đợi và xoá giờ chờ', async () => {
  const t = mk('queued')
  tasks.patch(t.id, { notBefore: Date.now() + 60_000, rateLimitRetries: 2 })
  const res = await post(t.id, 'unqueue')
  assert.equal(res.statusCode, 200)
  const after = tasks.get(t.id)!
  assert.equal(after.status, 'backlog')
  assert.equal(after.notBefore ?? null, null)
})

test('Backlog/Queued → Running khi hết slot: /run trả started=false và task vào hàng đợi', async () => {
  for (const from of ['backlog', 'queued'] as const) {
    const t = mk(from)
    const res = await post(t.id, 'run')
    assert.equal(res.statusCode, 200, from)
    assert.deepEqual(res.json(), { ok: true, started: false })
    assert.equal(statusOf(t.id), 'queued', from)
  }
})

test('Running → Backlog: /stop dừng task, task về Backlog kèm cờ Fail', async () => {
  const t = mk('running')
  const res = await post(t.id, 'stop')
  assert.equal(res.statusCode, 200)
  const after = tasks.get(t.id)!
  assert.equal(after.status, 'failed')
  assert.equal(after.failReason, 'Đã dừng bởi người dùng')
})

test('Tạm dừng → Tiếp tục: /stop rồi /resume đưa task vào hàng đợi chạy tiếp phiên cũ (hết slot)', async () => {
  const t = mk('running')
  tasks.patch(t.id, { worktreePath: process.env.TASKBOARD_DATA, sessionId: 'phien-cu' })
  assert.equal((await post(t.id, 'stop')).statusCode, 200)
  assert.equal(statusOf(t.id), 'failed')

  const res = await post(t.id, 'resume')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, started: false })
  const after = tasks.get(t.id)!
  assert.equal(after.status, 'queued')
  assert.equal(after.resumeNext, true)
  assert.equal(after.sessionId, 'phien-cu')
  assert.equal(after.failReason, undefined)
})

test('Hết giới hạn sử dụng: /resume bỏ giờ chờ của task Queued, giữ trong hàng đợi khi hết slot', async () => {
  const t = mk('queued')
  tasks.patch(t.id, { notBefore: Date.now() + 3600_000, rateLimitRetries: 2, resumeNext: true })
  const res = await post(t.id, 'resume')
  assert.equal(res.statusCode, 200)
  const after = tasks.get(t.id)!
  assert.equal(after.status, 'queued')
  assert.equal(after.notBefore, undefined)
  assert.equal(after.rateLimitRetries, undefined)
  assert.equal(after.resumeNext, true)
})

test('/resume bị từ chối 409: Failed không còn worktree, trạng thái không phù hợp', async () => {
  const noWt = mk('failed')
  assert.equal((await post(noWt.id, 'resume')).statusCode, 409)
  const missing = mk('failed')
  tasks.patch(missing.id, { worktreePath: join(process.env.TASKBOARD_DATA!, 'khong-ton-tai') })
  assert.equal((await post(missing.id, 'resume')).statusCode, 409)
  for (const from of ['backlog', 'queued', 'running', 'review', 'done'] as const) {
    const t = mk(from)
    tasks.patch(t.id, { worktreePath: process.env.TASKBOARD_DATA })
    assert.equal((await post(t.id, 'resume')).statusCode, 409, from)
    assert.equal(statusOf(t.id), from, from)
  }
  assert.equal((await post(999_999, 'resume')).statusCode, 404)
})

test('Chuyển không hợp lệ bị từ chối 409, trạng thái giữ nguyên', async () => {
  const cases: [TaskStatus, string][] = [
    ['queued', 'queue'], // đã ở hàng đợi
    ['running', 'queue'],
    ['backlog', 'unqueue'],
    ['running', 'unqueue'],
    ['running', 'run'],
    ['review', 'run'],
    ['done', 'run'],
    ['queued', 'stop'],
    ['backlog', 'stop'],
  ]
  for (const [from, action] of cases) {
    const t = mk(from)
    const res = await post(t.id, action)
    assert.equal(res.statusCode, 409, `${from} /${action}`)
    assert.equal(statusOf(t.id), from, `${from} /${action}`)
  }
})
