// Mode direct: Claude ghi output thẳng vào thư mục project (không cần git), review bằng snapshot riêng.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project } from './types.ts'

const root = mkdtempSync(join(tmpdir(), 'taskboard direct test '))
process.env.TASKBOARD_DATA = join(root, 'data') // phải đặt trước khi import db.ts
const folder = join(root, 'tai lieu du an') // thư mục thường, KHÔNG phải git repo
mkdirSync(folder, { recursive: true })
writeFileSync(join(folder, 'README.md'), '# Dự án\n')

const db = await import('./db.ts')
const g = await import('./git.ts')
const c = await import('./capture.ts')
const r = await import('./review.ts')
const rf = await import('./reviewFiles.ts')
const rt = await import('./retry.ts')
const { projectParallel } = await import('./runner.ts')

const project: Project = {
  id: 'p-direct',
  name: 'Direct',
  repoPath: folder,
  mainBranch: 'main',
  permissionMode: 'acceptEdits',
  allowedTools: [],
  maxParallel: 3,
  budgetAction: 'warn',
  deliveryMode: 'direct',
}
db.projects.upsert(project)

after(() => {
  db.db.close()
  rmSync(root, { recursive: true, force: true })
})

function newTask(title: string) {
  return db.tasks.create({
    projectId: project.id, title, prompt: 'prompt đủ dài', status: 'running',
    priority: 'normal', permissionMode: 'acceptEdits', tags: [],
  })
}

/** Giống startRun + completeRun nhưng thay Claude bằng hàm ghi file. */
async function runOnce(taskId: number, work: () => void) {
  const t = db.tasks.get(taskId)!
  const ws = await c.ensureWorktree(t, project)
  if (ws.created) db.tasks.patch(taskId, { branch: ws.branch, worktreePath: ws.path, baseRef: ws.baseRef ?? null })
  work()
  const cur = db.tasks.get(taskId)!
  const { headRef } = await c.captureChanges({ ...cur, worktreePath: cur.worktreePath! }, project, 1)
  return db.tasks.patch(taskId, { status: 'review', headRef: headRef ?? null })!
}

test('project mới lưu deliveryMode=direct; direct chỉ chạy 1 task/lần', () => {
  assert.equal(db.projects.get(project.id)!.deliveryMode, 'direct')
  assert.equal(projectParallel(project), 1)
  assert.equal(projectParallel({ ...project, deliveryMode: 'worktree' }), 3)
})

test('direct: output nằm ngay trong thư mục project, diff so với trước khi giao task, không tạo git trong thư mục', async () => {
  const t = newTask('Viết tài liệu')
  const done = await runOnce(t.id, () => {
    mkdirSync(join(folder, 'docs'), { recursive: true })
    writeFileSync(join(folder, 'docs', 'spec.md'), '# Spec\n')
    writeFileSync(join(folder, 'README.md'), '# Dự án\nĐã cập nhật\n')
  })
  assert.equal(done.branch, undefined)
  assert.equal(done.worktreePath, folder)
  assert.ok(done.baseRef && done.headRef)
  assert.ok(!existsSync(join(folder, '.git')), 'không được git init trong thư mục người dùng')
  assert.ok(existsSync(join(folder, 'docs', 'spec.md')), 'output phải nằm ngay trong thư mục project')

  const diff = await g.taskDiff(project, t.id)
  assert.deepEqual(diff.map((d) => d.path).sort(), ['README.md', 'docs/spec.md'])

  // Bản cũ lấy từ snapshot, bản mới từ thư mục project
  assert.equal((await rf.readTaskBlob(t.id, 'README.md', 'old')).toString('utf8'), '# Dự án\n')
  assert.equal((await rf.readTaskBlob(t.id, 'README.md', 'new')).toString('utf8'), '# Dự án\nĐã cập nhật\n')

  // Task chạy sau sửa thêm file: diff của task đang Review không bị lẫn
  writeFileSync(join(folder, 'khac.txt'), 'task khác\n')
  assert.deepEqual((await g.taskDiff(project, t.id)).map((d) => d.path).sort(), ['README.md', 'docs/spec.md'])
  rmSync(join(folder, 'khac.txt'))

  // Sửa tay file .md khi review: không commit, diff có phần sửa tay
  const saved = await rf.saveTaskFile(t.id, 'docs/spec.md', '# Spec v2\n')
  assert.equal(saved.committed, false)
  const spec = (await g.taskDiff(project, t.id)).find((d) => d.path === 'docs/spec.md')!
  assert.ok(JSON.stringify(spec).includes('Spec v2'))

  // Chấp nhận output: Done, file vẫn ở chỗ cũ
  const res = await r.approveTask(t.id)
  assert.equal(res.task.status, 'done')
  assert.equal(res.review.action, 'approve')
  assert.equal(readFileSync(join(folder, 'docs', 'spec.md'), 'utf8'), '# Spec v2\n')
})

test('direct: Reject và Retry không xoá/reset file trong thư mục người dùng', async () => {
  const t = newTask('Bị từ chối')
  await runOnce(t.id, () => writeFileSync(join(folder, 'nhap.md'), 'bản nháp\n'))
  await r.rejectTask(t.id)
  assert.ok(existsSync(join(folder, 'nhap.md')))

  const before = db.tasks.get(t.id)!.baseRef
  const queued = await rt.retryTask(t.id, { pump: () => {} })
  assert.equal(queued.status, 'queued')
  assert.equal(queued.baseRef, before) // giữ snapshot gốc
  assert.equal(queued.headRef, undefined)
  assert.ok(existsSync(join(folder, 'nhap.md')))
  assert.equal(c.taskMode(queued, { deliveryMode: 'worktree' }), 'direct') // mode đã chốt theo task
})

test('direct: không merge được', async () => {
  const t = newTask('Không merge')
  await runOnce(t.id, () => writeFileSync(join(folder, 'm.md'), 'x\n'))
  await assert.rejects(r.mergeTask(t.id), (e: Error & { statusCode?: number }) => e.statusCode === 409)
})
