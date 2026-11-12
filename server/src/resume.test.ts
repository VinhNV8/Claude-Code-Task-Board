// Resume (Tiếp tục) task bị tạm dừng / lỗi / hết giới hạn sử dụng: giữ worktree đang dở, chạy tiếp phiên Claude cũ.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Task } from './types.ts'

const root = mkdtempSync(join(tmpdir(), 'taskboard resume test '))
process.env.TASKBOARD_DATA = join(root, 'data') // phải đặt trước khi import db.ts
const repo = join(root, 'my repo')

const g = await import('./git.ts')
const db = await import('./db.ts')
const c = await import('./capture.ts')
const rs = await import('./resume.ts')
const rt = await import('./retry.ts')
const rv = await import('./review.ts')
const runner = await import('./runner.ts')
const lib = await import('../../web/src/lib/resume.ts')
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

/** Runner giả: ghi lại các lần gọi, startRun chuyển task sang Running như runner thật (không spawn Claude). */
function fakeDeps(slot: boolean) {
  const f = {
    started: [] as { taskId: number; kind: string; sessionId?: string }[],
    pumps: 0,
    hasSlot: () => slot,
    startRun: (task: Task, kind: 'continue') => {
      f.started.push({ taskId: task.id, kind, sessionId: task.sessionId })
      db.tasks.patch(task.id, { status: 'running', failReason: null, notBefore: null, resumeNext: null })
    },
    pump: () => void f.pumps++,
  }
  return f
}

/** Task bị gián đoạn giữa chừng: worktree có 1 commit + 1 file sửa dở + 1 file chưa track, còn session id. */
async function interruptedTask(title: string, failReason: string = lib.STOP_REASON) {
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
  writeFileSync(join(wt.path, 'wip.txt'), 'chưa track\n')
  db.runs.create({ id: `run-${t.id}`, taskId: t.id, kind: 'initial', sessionId: `old-session-${t.id}`, startedAt: Date.now() })
  return db.tasks.patch(t.id, {
    branch: wt.branch,
    worktreePath: wt.path,
    sessionId: `old-session-${t.id}`,
    failReason,
    rateLimitRetries: 2,
  })!
}

/** Thay đổi dở dang vẫn còn nguyên (Resume không reset worktree như Retry). */
function assertWorkKept(path: string) {
  assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), 'sửa dở dang\n')
  assert.ok(existsSync(join(path, 'run1.txt')))
  assert.ok(existsSync(join(path, 'wip.txt')))
}

// ---------------------------------------------------------------- hàm thuần (dùng chung web/server)

test('resumeBlocker: Failed còn worktree / Queued chờ giới hạn sử dụng → được; còn lại → lý do', () => {
  const now = 1_000_000
  assert.equal(lib.resumeBlocker({ status: 'failed', worktreePath: '/wt' }, now), undefined)
  assert.equal(lib.resumeBlocker({ status: 'queued', notBefore: now + 60_000 }, now), undefined)
  assert.match(lib.resumeBlocker({ status: 'failed' }, now)!, /Chạy lại/)
  assert.ok(lib.resumeBlocker({ status: 'queued', notBefore: now - 1 }, now)) // đã tới giờ: pump tự chạy
  assert.ok(lib.resumeBlocker({ status: 'queued' }, now))
  for (const status of ['backlog', 'running', 'needs_input', 'review', 'done'] as const)
    assert.ok(lib.resumeBlocker({ status, worktreePath: '/wt' }, now), status)
  assert.equal(lib.canResume({ status: 'failed', worktreePath: '/wt' }, now), true)
  assert.equal(lib.isWaitingRateLimit({ status: 'queued', notBefore: now + 1 }, now), true)
  assert.equal(lib.isWaitingRateLimit({ status: 'failed', notBefore: now + 1 }, now), false)
})

test('nextRunKind: pendingFeedback → resume, resumeNext → continue, còn lại initial/retry', () => {
  assert.equal(runner.nextRunKind({ pendingFeedback: 'sửa đi', resumeNext: true }, true), 'resume')
  assert.equal(runner.nextRunKind({ resumeNext: true }, true), 'continue')
  assert.equal(runner.nextRunKind({}, true), 'retry')
  assert.equal(runner.nextRunKind({}, false), 'initial')
})

test('sessionFor: continue dùng lại phiên cũ; mất phiên thì tạo phiên mới', () => {
  const id = () => 'new-id'
  assert.deepEqual(runner.sessionFor('continue', 'old', id), { resume: true, sessionId: 'old' })
  assert.deepEqual(runner.sessionFor('continue', undefined, id), { resume: false, sessionId: 'new-id' })
})

test('resumePrompt continue: đúng phiên → lời nhắc tiếp tục; phiên mới → prompt gốc + ghi chú', () => {
  assert.equal(runner.resumePrompt({ kind: 'continue', resume: true, taskPrompt: 'P' }), lib.CONTINUE_PROMPT)
  assert.equal(runner.resumePrompt({ kind: 'continue', resume: false, taskPrompt: 'P' }), `P\n\n${lib.CONTINUE_NOTE}`)
})

test('isMissingSession: nhận ra lỗi CLI không tìm thấy phiên', () => {
  assert.equal(runner.isMissingSession({ stderr: 'Error: No conversation found with session ID: abc' }), true)
  assert.equal(runner.isMissingSession({ result: { isError: true, text: 'No conversation found with session ID x' } }), true)
  assert.equal(runner.isMissingSession({ result: { isError: false, text: 'No conversation found' } }), false)
  assert.equal(runner.isMissingSession({ stderr: 'Claude AI usage limit reached' }), false)
})

test('requeueIntent (hết giới hạn sử dụng): run Yêu cầu sửa giữ feedback, run khác chạy tiếp phiên cũ', () => {
  assert.deepEqual(runner.requeueIntent({ kind: 'resume', feedback: 'fb' }), { pendingFeedback: 'fb', resumeNext: false })
  for (const kind of ['initial', 'retry', 'continue'] as const)
    assert.deepEqual(runner.requeueIntent({ kind }), { pendingFeedback: null, resumeNext: true })
  assert.deepEqual(runner.requeueIntent(undefined), { pendingFeedback: null, resumeNext: true })
})

test('db: cột resume_next lưu/đọc được, null/false xoá cờ', () => {
  const t = db.tasks.create({
    projectId: project.id,
    title: 'cờ',
    prompt: 'p',
    status: 'backlog',
    priority: 'normal',
    permissionMode: 'acceptEdits',
    tags: [],
  })
  assert.equal(t.resumeNext, undefined)
  assert.equal(db.tasks.patch(t.id, { resumeNext: true })!.resumeNext, true)
  assert.equal(db.tasks.patch(t.id, { resumeNext: null })!.resumeNext, undefined)
  assert.equal(db.tasks.patch(t.id, { resumeNext: true })!.resumeNext, true)
  assert.equal(db.tasks.patch(t.id, { resumeNext: false })!.resumeNext, undefined)
  db.tasks.remove(t.id)
})

// ---------------------------------------------------------------- resumeTask với repo thật

test('tiếp tục task Tạm dừng khi còn slot: startRun continue trên phiên cũ, worktree giữ nguyên', async () => {
  const t = await interruptedTask('Tạm dừng giữa chừng')
  const f = fakeDeps(true)
  const res = await rs.resumeTask(t.id, f)
  assert.equal(res.started, true)
  assert.deepEqual(f.started, [{ taskId: t.id, kind: 'continue', sessionId: `old-session-${t.id}` }])
  assert.equal(res.task.status, 'running')
  // Người dùng chủ động tiếp tục: bộ đếm tự thử lại do giới hạn sử dụng về 0
  assert.equal(res.task.rateLimitRetries, undefined)
  assertWorkKept(t.worktreePath!)
  assert.equal(await ok(repo, ['rev-list', '--count', `main..claude/task-${t.id}`]), '1')
  await g.removeWorktree(project, t.id)
})

test('tiếp tục task Failed khi hết slot: Queued + resumeNext, lần pump sau chạy continue', async () => {
  const t = await interruptedTask('Lỗi giữa chừng', 'Claude CLI thoát với mã 1')
  const f = fakeDeps(false)
  messages.length = 0
  const res = await rs.resumeTask(t.id, f)
  assert.equal(res.started, false)
  assert.equal(f.started.length, 0)
  assert.equal(f.pumps, 1)
  assert.equal(res.task.status, 'queued')
  assert.equal(res.task.resumeNext, true)
  assert.equal(res.task.failReason, undefined)
  assert.equal(res.task.notBefore, undefined)
  assert.equal(res.task.sessionId, `old-session-${t.id}`) // giữ phiên cũ để resume
  assert.ok(messages.some((m) => m.type === 'task' && m.task.id === t.id && m.task.status === 'queued' && m.task.resumeNext))
  assert.equal(runner.nextRunKind(res.task, true), 'continue')
  assertWorkKept(t.worktreePath!)

  // Bấm Tiếp tục lần nữa khi task đã Queued (không chờ giới hạn) → 409
  await assert.rejects(rs.resumeTask(t.id, f), (e: Error & { statusCode?: number }) => e.statusCode === 409)

  // Chọn Chạy lại sau đó: bỏ ý định tiếp tục
  db.tasks.patch(t.id, { status: 'failed' })
  const retried = await rt.retryTask(t.id, { pump: () => {} })
  assert.equal(retried.resumeNext, undefined)
  assert.equal(runner.nextRunKind(retried, true), 'retry')
  db.tasks.patch(t.id, { status: 'failed' }) // không để task Queued lại trong DB
  await g.removeWorktree(project, t.id)
})

test('tiếp tục task chờ giới hạn sử dụng: bỏ giờ chờ, giữ ý định chạy tiếp, gọi pump', async () => {
  const t = await interruptedTask('Hết limit')
  db.tasks.patch(t.id, { status: 'queued', notBefore: Date.now() + 3600_000, rateLimitRetries: 1, resumeNext: true, failReason: null })
  const f = fakeDeps(true)
  const res = await rs.resumeTask(t.id, f)
  assert.equal(f.pumps, 1)
  assert.equal(f.started.length, 0) // pump (giả) mới là nơi lấy task ra chạy
  assert.equal(res.started, false)
  assert.equal(res.task.status, 'queued')
  assert.equal(res.task.notBefore, undefined)
  assert.equal(res.task.rateLimitRetries, undefined)
  assert.equal(res.task.resumeNext, true)
  assertWorkKept(t.worktreePath!)
  db.tasks.patch(t.id, { status: 'failed' })
  await g.removeWorktree(project, t.id)
})

test('tiếp tục task Failed do hết lượt tự thử lại (giới hạn sử dụng): chạy continue', async () => {
  const t = await interruptedTask('Hết lượt thử lại', 'Gặp giới hạn sử dụng quá 3 lần')
  const f = fakeDeps(true)
  const res = await rs.resumeTask(t.id, f)
  assert.equal(res.started, true)
  assert.equal(f.started[0]?.kind, 'continue')
  await g.removeWorktree(project, t.id)
})

test('không tiếp tục được: mất thư mục worktree, bị Reject, không ở trạng thái phù hợp, không tồn tại', async () => {
  const f = fakeDeps(true)
  const isCode = (code: number) => (e: Error & { statusCode?: number }) => e.statusCode === code

  const lost = await interruptedTask('Mất worktree')
  await ok(repo, ['worktree', 'remove', '--force', lost.worktreePath!])
  await assert.rejects(rs.resumeTask(lost.id, f), (e: Error & { statusCode?: number }) => {
    assert.equal(e.statusCode, 409)
    assert.match(e.message, /Chạy lại/)
    return true
  })
  assert.equal(db.tasks.get(lost.id)!.status, 'failed')
  await g.removeWorktree(project, lost.id)

  const rej = await interruptedTask('Bị từ chối')
  db.tasks.patch(rej.id, { status: 'review' })
  await rv.rejectTask(rej.id)
  await assert.rejects(rs.resumeTask(rej.id, f), isCode(409))

  const inReview = await interruptedTask('Đang ở Review')
  db.tasks.patch(inReview.id, { status: 'review' })
  await assert.rejects(rs.resumeTask(inReview.id, f), isCode(409))
  await g.removeWorktree(project, inReview.id)

  await assert.rejects(rs.resumeTask(999_999, f), isCode(404))
  assert.equal(f.started.length, 0)
})

test('bấm Tiếp tục 2 lần liên tiếp: chỉ chạy 1 lần, lần sau 409', async () => {
  const t = await interruptedTask('Bấm 2 lần')
  const f = fakeDeps(true)
  const results = await Promise.allSettled([rs.resumeTask(t.id, f), rs.resumeTask(t.id, f)])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.equal(((results[1] as PromiseRejectedResult).reason as { statusCode?: number }).statusCode, 409)
  assert.equal(f.started.length, 1)
  db.tasks.patch(t.id, { status: 'failed' })
  await g.removeWorktree(project, t.id)
})
