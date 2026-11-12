// Retry (PLAN 2.7): task lỗi → Retry → chạy trên code sạch, không mang thay đổi dở dang của lần trước.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project } from './types.ts'

// Thư mục tạm có dấu cách để kiểm tra đường dẫn trên Windows.
const root = mkdtempSync(join(tmpdir(), 'taskboard retry test '))
process.env.TASKBOARD_DATA = join(root, 'data') // phải đặt trước khi import db.ts
const repo = join(root, 'my repo')

const g = await import('./git.ts')
const db = await import('./db.ts')
const c = await import('./capture.ts')
const rt = await import('./retry.ts')
const rv = await import('./review.ts')
const runner = await import('./runner.ts')
const { bus } = await import('./bus.ts')
type ServerMessage = import('./bus.ts').ServerMessage

const project: Project = {
  id: 'proj',
  name: 'Proj',
  repoPath: repo,
  mainBranch: 'main',
  permissionMode: 'acceptEdits',
  allowedTools: [],
  maxParallel: 1,
  budgetAction: 'warn' as const,
}

async function ok(cwd: string, args: string[]) {
  const res = await g.git(cwd, args)
  assert.equal(res.code, 0, `git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout.trim()
}

const branchExists = async (taskId: number) =>
  (await g.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/claude/task-${taskId}`])).code === 0

/**
 * Task Failed giữa chừng: worktree có 1 commit của run trước, 1 file đã sửa chưa commit và 1 file mới chưa track
 * (giống Claude bị dừng / lỗi khi đang làm dở). Task còn session id và feedback cũ.
 */
async function failedTask(title: string) {
  const t = db.tasks.create({
    projectId: project.id,
    title,
    prompt: 'prompt đủ dài',
    status: 'failed',
    priority: 'normal',
    permissionMode: 'acceptEdits',
    tags: [],
  })
  const wt = await c.ensureWorktree(t, project)
  writeFileSync(join(wt.path, 'run1.txt'), 'commit của run trước\n')
  assert.equal(await g.commitAll(wt.path, `task #${t.id}: ${title} (run 1)`), true)
  writeFileSync(join(wt.path, 'README.md'), 'sửa dở dang\n')
  mkdirSync(join(wt.path, 'dở dang'), { recursive: true })
  writeFileSync(join(wt.path, 'dở dang', 'wip.txt'), 'chưa track\n')
  db.runs.create({ id: `run-${t.id}`, taskId: t.id, kind: 'initial', sessionId: `old-session-${t.id}`, startedAt: Date.now() })
  return db.tasks.patch(t.id, {
    branch: wt.branch,
    worktreePath: wt.path,
    sessionId: `old-session-${t.id}`,
    failReason: 'Claude CLI thoát với mã 1',
    pendingFeedback: 'feedback cũ còn sót',
  })!
}

/** Kiểm tra worktree đúng bằng mainBranch: không commit thừa, không file bẩn, không file chưa track. */
async function assertClean(path: string) {
  assert.equal(await ok(path, ['rev-parse', 'HEAD']), await ok(repo, ['rev-parse', 'main']))
  assert.equal(await ok(path, ['status', '--porcelain', '--untracked-files=all']), '')
  assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), 'hello\n')
  assert.ok(!existsSync(join(path, 'run1.txt')))
  assert.ok(!existsSync(join(path, 'dở dang')))
}

function fakePump() {
  const f = { calls: 0, pump: () => void f.calls++ }
  return f
}

const messages: ServerMessage[] = []
bus.on('message', (m: ServerMessage) => messages.push(m))

before(async () => {
  mkdirSync(repo, { recursive: true })
  await ok(repo, ['-c', 'init.defaultBranch=main', 'init'])
  await ok(repo, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  assert.equal(await g.commitAll(repo, 'initial'), true)
  db.projects.upsert(project)
})

after(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {}
})

// ---------------------------------------------------------------- hàm thuần ở runner

test('runKindFor: task đã từng chạy → retry, chưa → initial', () => {
  assert.equal(runner.runKindFor(true), 'retry')
  assert.equal(runner.runKindFor(false), 'initial')
})

test('sessionFor: retry/initial luôn session mới, chỉ resume mới dùng lại phiên cũ', () => {
  const id = () => 'new-id'
  assert.deepEqual(runner.sessionFor('retry', 'old', id), { resume: false, sessionId: 'new-id' })
  assert.deepEqual(runner.sessionFor('initial', 'old', id), { resume: false, sessionId: 'new-id' })
  assert.deepEqual(runner.sessionFor('resume', 'old', id), { resume: true, sessionId: 'old' })
  assert.deepEqual(runner.sessionFor('resume', undefined, id), { resume: false, sessionId: 'new-id' })
})

// ---------------------------------------------------------------- retry với repo thật

test('retry task Failed còn worktree: reset về main, bỏ commit + file dở dang, xoá session/feedback, Queued', async () => {
  const t = await failedTask('Lỗi giữa chừng')
  const p = fakePump()
  messages.length = 0

  const res = await rt.retryTask(t.id, p)
  assert.equal(res.status, 'queued')
  assert.equal(res.sessionId, undefined)
  assert.equal(res.failReason, undefined)
  assert.equal(res.pendingFeedback, undefined)
  // Giữ worktree cũ (đã sạch) để startRun dùng lại, không phải tạo mới
  assert.equal(res.worktreePath, t.worktreePath)
  assert.equal(res.branch, `claude/task-${t.id}`)
  await assertClean(t.worktreePath!)
  assert.equal(await ok(repo, ['rev-list', '--count', `main..claude/task-${t.id}`]), '0')
  assert.equal(p.calls, 1)
  assert.ok(messages.some((m) => m.type === 'task' && m.task.id === t.id && m.task.status === 'queued'))

  // Đúng như startRun: ensureWorktree dùng lại worktree đã reset, run mới kind 'retry' với session mới
  const wt = await c.ensureWorktree(res, project)
  assert.equal(wt.created, false)
  await assertClean(wt.path)
  assert.equal(runner.runKindFor(db.runs.byTask(t.id).length > 0), 'retry')
  assert.notEqual(runner.sessionFor('retry', res.sessionId).sessionId, t.sessionId)
  await g.removeWorktree(project, t.id)
})

test('retry dựa trên main mới nhất (main đã tiến lên sau khi task tạo nhánh)', async () => {
  const t = await failedTask('Main đã đổi')
  writeFileSync(join(repo, 'moi.txt'), 'commit mới trên main\n')
  assert.equal(await g.commitAll(repo, 'main tiến lên'), true)

  await rt.retryTask(t.id, fakePump())
  await assertClean(t.worktreePath!)
  assert.equal(readFileSync(join(t.worktreePath!, 'moi.txt'), 'utf8'), 'commit mới trên main\n')
  await g.removeWorktree(project, t.id)
})

test('retry task bị Reject (không còn worktree): xoá branch/worktreePath để startRun tạo worktree mới từ main', async () => {
  const t = db.tasks.create({
    projectId: project.id,
    title: 'Bị từ chối',
    prompt: 'prompt đủ dài',
    status: 'review',
    priority: 'normal',
    permissionMode: 'acceptEdits',
    tags: [],
  })
  const wt = await c.ensureWorktree(t, project)
  writeFileSync(join(wt.path, 'run1.txt'), 'bị reject\n')
  assert.equal(await g.commitAll(wt.path, 'run 1'), true)
  db.tasks.patch(t.id, { branch: wt.branch, worktreePath: wt.path, sessionId: 'old-session' })
  db.runs.create({ id: `run-${t.id}`, taskId: t.id, kind: 'initial', sessionId: 'old-session', startedAt: Date.now() })
  await rv.rejectTask(t.id)

  const p = fakePump()
  const res = await rt.retryTask(t.id, p)
  assert.equal(res.status, 'queued')
  assert.equal(res.branch, undefined)
  assert.equal(res.worktreePath, undefined)
  assert.equal(res.sessionId, undefined)
  assert.equal(p.calls, 1)

  const fresh = await c.ensureWorktree(res, project)
  assert.equal(fresh.created, true)
  await assertClean(fresh.path)
  await g.removeWorktree(project, t.id)
})

test('retry khi thư mục worktree đã mất nhưng nhánh còn: xoá nhánh cũ để không checkout lại commit cũ', async () => {
  const t = await failedTask('Mất thư mục')
  await ok(repo, ['worktree', 'remove', '--force', t.worktreePath!])
  assert.ok(await branchExists(t.id))

  const res = await rt.retryTask(t.id, fakePump())
  assert.equal(res.worktreePath, undefined)
  assert.ok(!(await branchExists(t.id)))

  const fresh = await c.ensureWorktree(res, project)
  await assertClean(fresh.path)
  await g.removeWorktree(project, t.id)
})

test('retry: task không ở Failed → 409, bấm 2 lần liên tiếp chỉ reset 1 lần', async () => {
  const t = await failedTask('Bấm 2 lần')
  const p = fakePump()
  const results = await Promise.allSettled([rt.retryTask(t.id, p), rt.retryTask(t.id, p)])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  const err = (results[1] as PromiseRejectedResult).reason as Error & { statusCode?: number }
  assert.equal(err.statusCode, 409)
  assert.match(err.message, /Chỉ chạy lại task ở Failed/)
  assert.equal(p.calls, 1)

  await assert.rejects(rt.retryTask(999_999, p), (e: Error & { statusCode?: number }) => e.statusCode === 404)
  await g.removeWorktree(project, t.id)
})

test('retry: không reset được worktree → 500 với thông báo tiếng Việt, task giữ nguyên Failed', async () => {
  const t = await failedTask('Main không tồn tại')
  db.projects.upsert({ ...project, mainBranch: 'khong-ton-tai' })
  const p = fakePump()
  try {
    await assert.rejects(rt.retryTask(t.id, p), (e: Error & { statusCode?: number }) => {
      assert.equal(e.statusCode, 500)
      assert.match(e.message, /Không đưa được worktree về nhánh "khong-ton-tai"/)
      return true
    })
    assert.equal(db.tasks.get(t.id)!.status, 'failed')
    assert.equal(p.calls, 0)
  } finally {
    db.projects.upsert(project)
    await g.removeWorktree(project, t.id)
  }
})
