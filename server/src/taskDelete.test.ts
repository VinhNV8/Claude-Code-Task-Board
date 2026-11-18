// Xoá task: chỉ cho backlog / queued / failed (gồm task bị dừng); các trạng thái khác 409. DB in-memory, không spawn Claude.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard del '))
process.env.TASKBOARD_DB = ':memory:'
const { projects, runs, taskDeps, tasks } = await import('./db.ts')
const { routes } = await import('./routes.ts')
const { canDeleteTask } = await import('../../web/src/lib/taskDelete.ts')
const { default: Fastify } = await import('fastify')
import type { Task } from './types.ts'

const app = Fastify()
await app.register(routes)
after(async () => {
  await app.close()
})

projects.upsert({
  id: 'p1',
  name: 'p1',
  repoPath: process.env.TASKBOARD_DATA!,
  mainBranch: 'main',
  permissionMode: 'acceptEdits',
  allowedTools: [],
  maxParallel: 5,
  budgetAction: 'warn',
  deliveryMode: 'worktree',
})

const mk = (status: Task['status'], extra: Partial<Task> = {}) => {
  const t = tasks.create({ projectId: 'p1', title: `t-${status}`, prompt: 'làm gì đó đủ dài', status, priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
  return extra && Object.keys(extra).length ? tasks.patch(t.id, extra)! : t
}
const del = (id: number) => app.inject({ method: 'DELETE', url: `/api/tasks/${id}` })

test('canDeleteTask: chỉ backlog, queued, failed', () => {
  assert.deepEqual(
    (['backlog', 'queued', 'running', 'needs_input', 'review', 'done', 'failed'] as const).filter(canDeleteTask),
    ['backlog', 'queued', 'failed'],
  )
})

for (const status of ['backlog', 'queued', 'failed'] as const) {
  test(`DELETE task ${status} → 200 và task biến mất`, async () => {
    const t = mk(status)
    const res = await del(t.id)
    assert.equal(res.statusCode, 200)
    assert.equal(tasks.get(t.id), undefined)
  })
}

test('DELETE task failed do người dùng dừng (cancel) → xoá được, kèm run', async () => {
  const t = mk('failed', { failReason: 'Đã dừng bởi người dùng.' })
  const res = await del(t.id)
  assert.equal(res.statusCode, 200)
  assert.equal(tasks.get(t.id), undefined)
  assert.equal(runs.byTask(t.id).length, 0)
})

for (const status of ['running', 'needs_input', 'review', 'done'] as const) {
  test(`DELETE task ${status} → 409, task còn nguyên`, async () => {
    const t = mk(status)
    const res = await del(t.id)
    assert.equal(res.statusCode, 409)
    assert.ok(tasks.get(t.id))
  })
}

test('DELETE task failed có branch/worktree không còn tồn tại → vẫn xoá được (dọn best-effort)', async () => {
  const t = mk('failed', { branch: 'claude/task-999', worktreePath: join(process.env.TASKBOARD_DATA!, 'missing') })
  const res = await del(t.id)
  assert.equal(res.statusCode, 200)
  assert.equal(tasks.get(t.id), undefined)
})

test('DELETE task được task khác chờ → liên kết phụ thuộc bị gỡ', async () => {
  const a = mk('failed')
  const b = mk('backlog')
  taskDeps.set(b.id, [a.id])
  assert.equal((await del(a.id)).statusCode, 200)
  assert.deepEqual(taskDeps.dependents(a.id), [])
  assert.deepEqual(tasks.get(b.id)?.dependsOn ?? [], [])
})

test('DELETE task không tồn tại → 404', async () => {
  assert.equal((await del(987654)).statusCode, 404)
})
