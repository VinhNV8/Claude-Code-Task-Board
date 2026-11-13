import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project } from './types.ts'

// Thư mục tạm có dấu cách để kiểm tra đường dẫn trên Windows.
const root = mkdtempSync(join(tmpdir(), 'taskboard review test '))
process.env.TASKBOARD_DATA = join(root, 'data') // phải đặt trước khi import db.ts
const repo = join(root, 'my repo')

const g = await import('./git.ts')
const db = await import('./db.ts')
const r = await import('./review.ts')
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

/** Tạo task ở Review với một commit trên nhánh claude/task-<id> ghi `files` vào worktree. */
async function reviewTask(title: string, files: Record<string, string>) {
  const t = db.tasks.create({
    projectId: project.id,
    title,
    prompt: 'prompt đủ dài',
    status: 'review',
    priority: 'normal',
    permissionMode: 'acceptEdits',
    tags: [],
  })
  const wt = await g.createWorktree(project, t.id)
  for (const [f, content] of Object.entries(files)) writeFileSync(join(wt.path, f), content)
  assert.equal(await g.commitAll(wt.path, `task #${t.id}: ${title} (run 1)`), true)
  return db.tasks.patch(t.id, { branch: wt.branch, worktreePath: wt.path })!
}

async function rejects(p: Promise<unknown>, status: number, match: RegExp) {
  await assert.rejects(p, (e: Error & { statusCode?: number }) => {
    assert.equal(e.statusCode, status, e.message)
    assert.match(e.message, match)
    return true
  })
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

// ---------------------------------------------------------------- hàm thuần

test('repoNotReadyWarning: nhánh sai, detached HEAD, file chưa commit', () => {
  assert.equal(r.repoNotReadyWarning({ branch: 'main', changes: [] }, 'main'), undefined)
  assert.match(r.repoNotReadyWarning({ branch: 'dev', changes: [] }, 'main')!, /đang ở nhánh "dev".*"main"/)
  assert.match(r.repoNotReadyWarning({ branch: 'HEAD', changes: [] }, 'main')!, /detached HEAD/)
  const w = r.repoNotReadyWarning({ branch: 'dev', changes: ['a.txt', 'b.txt'] }, 'main')!
  assert.match(w, /nhánh "dev"/)
  assert.match(w, /2 file chưa commit: a\.txt, b\.txt/)
})

test('listFiles rút gọn danh sách dài', () => {
  assert.equal(r.listFiles(['a', 'b']), 'a, b')
  assert.equal(r.listFiles(['a', 'b', 'c', 'd'], 2), 'a, b và 2 file khác')
})

test('withLock chạy tuần tự theo key, key khác chạy song song, lỗi không làm kẹt khoá', async () => {
  const log: string[] = []
  const step = (name: string, ms: number, fail = false) => async () => {
    log.push(`${name}:start`)
    await new Promise((res) => setTimeout(res, ms))
    log.push(`${name}:end`)
    if (fail) throw new Error(name)
    return name
  }
  const a = r.withLock('p1', step('a', 30, true))
  const b = r.withLock('p1', step('b', 5))
  const c = r.withLock('p2', step('c', 5))
  await assert.rejects(a, /a/)
  assert.equal(await b, 'b')
  assert.equal(await c, 'c')
  assert.ok(log.indexOf('b:start') > log.indexOf('a:end'), `b phải chờ a: ${log}`)
  assert.ok(log.indexOf('c:start') < log.indexOf('a:end'), `c không phải chờ a: ${log}`)
})

// ---------------------------------------------------------------- approve với repo thật

test('approve: merge sạch → Done, ghi review, xoá worktree + nhánh', async () => {
  const t = await reviewTask('Thêm feature', { 'feature.txt': 'new feature\n' })
  db.tasks.patch(t.id, { reviewWarning: 'cảnh báo cũ' })
  messages.length = 0

  const res = await r.approveTask(t.id)
  assert.equal(res.task.status, 'done')
  assert.equal(res.task.reviewWarning, undefined)
  assert.equal(res.task.worktreePath, undefined)
  assert.equal(res.review.action, 'approve')

  assert.equal(await ok(repo, ['log', '-1', '--format=%s']), `Merge task #${t.id}: Thêm feature`)
  assert.equal(await ok(repo, ['rev-list', '--count', '--merges', 'HEAD']), '1')
  assert.equal(readFileSync(join(repo, 'feature.txt'), 'utf8'), 'new feature\n')
  assert.equal(await ok(repo, ['status', '--porcelain']), '')
  assert.notEqual((await g.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/claude/task-${t.id}`])).code, 0)
  assert.ok(!existsSync(t.worktreePath!))

  assert.deepEqual(db.reviews.byTask(t.id).map((x) => x.action), ['approve'])
  assert.ok(db.reviews.all().some((x) => x.id === res.review.id))
  assert.ok(messages.some((m) => m.type === 'review' && m.review.id === res.review.id))
  assert.ok(messages.some((m) => m.type === 'task' && m.task.id === t.id && m.task.status === 'done'))
})

test('approve: output không kèm thay đổi code → Done, không merge, không cần repo chính sạch', async () => {
  const t = db.tasks.create({
    projectId: project.id,
    title: 'Phân tích log',
    prompt: 'prompt đủ dài',
    status: 'review',
    priority: 'normal',
    permissionMode: 'acceptEdits',
    tags: [],
  })
  const wt = await g.createWorktree(project, t.id)
  db.tasks.patch(t.id, { branch: wt.branch, worktreePath: wt.path })
  const head = await ok(repo, ['rev-parse', 'HEAD'])
  writeFileSync(join(repo, 'dang-sua.txt'), 'chưa commit\n') // repo chính bẩn vẫn duyệt được

  const res = await r.approveTask(t.id)
  assert.equal(res.task.status, 'done')
  assert.equal(res.review.action, 'approve')
  assert.equal(await ok(repo, ['rev-parse', 'HEAD']), head)
  assert.notEqual((await g.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/claude/task-${t.id}`])).code, 0)
  assert.ok(!existsSync(wt.path))
  rmSync(join(repo, 'dang-sua.txt'))
})

test('approve: nhánh task đã mất → Done (không có gì để merge)', async () => {
  const t = db.tasks.create({
    projectId: project.id,
    title: 'Mất nhánh',
    prompt: 'prompt đủ dài',
    status: 'review',
    priority: 'normal',
    permissionMode: 'acceptEdits',
    tags: [],
  })
  const res = await r.approveTask(t.id)
  assert.equal(res.task.status, 'done')
})

test('approve: task không ở Review → 409', async () => {
  const t = await reviewTask('Chưa review', { 'x.txt': 'x\n' })
  db.tasks.patch(t.id, { status: 'running' })
  await rejects(r.approveTask(t.id), 409, /không ở trạng thái Review/)
  await rejects(r.approveTask(999_999), 404, /Không tìm thấy task/)
  db.tasks.patch(t.id, { status: 'review' })
  await r.approveTask(t.id) // dọn cho các test sau
})

test('approve: repo chính có file chưa commit → 409, không merge', async () => {
  const t = await reviewTask('Repo bẩn', { 'dirty-feature.txt': 'y\n' })
  const head = await ok(repo, ['rev-parse', 'HEAD'])
  writeFileSync(join(repo, 'wip.txt'), 'đang sửa dở')
  try {
    await rejects(r.approveTask(t.id), 409, /1 file chưa commit: wip\.txt/)
    const after = db.tasks.get(t.id)!
    assert.equal(after.status, 'review')
    assert.match(after.reviewWarning!, /wip\.txt/)
    assert.equal(await ok(repo, ['rev-parse', 'HEAD']), head)
    assert.ok(existsSync(t.worktreePath!))
    assert.deepEqual(db.reviews.byTask(t.id), [])
  } finally {
    rmSync(join(repo, 'wip.txt'))
  }
  // Repo sạch lại thì approve được và cảnh báo bị xoá
  const res = await r.approveTask(t.id)
  assert.equal(res.task.status, 'done')
  assert.equal(res.task.reviewWarning, undefined)
})

test('approve: repo chính không ở mainBranch → 409 nêu tên nhánh', async () => {
  const t = await reviewTask('Sai nhánh', { 'branch-feature.txt': 'z\n' })
  await ok(repo, ['checkout', '-q', '-b', 'dev'])
  try {
    await rejects(r.approveTask(t.id), 409, /đang ở nhánh "dev"/)
    assert.match(db.tasks.get(t.id)!.reviewWarning!, /"dev".*"main"/)
    assert.equal(db.tasks.get(t.id)!.status, 'review')
  } finally {
    await ok(repo, ['checkout', '-q', 'main'])
    await ok(repo, ['branch', '-D', 'dev'])
  }
  await r.approveTask(t.id)
})

test('approve: conflict → merge --abort, task giữ Review, repo chính sạch', async () => {
  const t = await reviewTask('Sửa README', { 'README.md': 'từ task\n' })
  writeFileSync(join(repo, 'README.md'), 'từ main\n')
  assert.equal(await g.commitAll(repo, 'main sửa README'), true)
  const head = await ok(repo, ['rev-parse', 'HEAD'])

  await rejects(r.approveTask(t.id), 409, /conflict ở 1 file: README\.md/)
  const after = db.tasks.get(t.id)!
  assert.equal(after.status, 'review')
  assert.match(after.reviewWarning!, /README\.md/)
  assert.equal(await ok(repo, ['status', '--porcelain']), '')
  assert.equal(await ok(repo, ['rev-parse', 'HEAD']), head)
  assert.notEqual((await g.git(repo, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).code, 0)
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'từ main\n')
  // Nhánh + worktree còn nguyên để sửa tiếp
  assert.equal(await ok(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main')
  assert.ok(existsSync(t.worktreePath!))
  assert.deepEqual(db.reviews.byTask(t.id), [])
})

test('approve đồng thời: hai lệnh trên cùng repo không chạy chồng', async () => {
  const a = await reviewTask('Song song A', { 'a.txt': 'a\n' })
  const b = await reviewTask('Song song B', { 'b.txt': 'b\n' })
  const merges = Number(await ok(repo, ['rev-list', '--count', '--merges', 'HEAD']))

  // Cùng task hai lần + task khác: đúng một lệnh cho task A thành công, B cũng merge được
  const results = await Promise.allSettled([r.approveTask(a.id), r.approveTask(a.id), r.approveTask(b.id)])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.match((results[1] as PromiseRejectedResult).reason.message, /không ở trạng thái Review/)
  assert.equal(results[2].status, 'fulfilled')

  assert.equal(Number(await ok(repo, ['rev-list', '--count', '--merges', 'HEAD'])), merges + 2)
  assert.equal(await ok(repo, ['status', '--porcelain']), '')
  assert.ok(existsSync(join(repo, 'a.txt')) && existsSync(join(repo, 'b.txt')))
  assert.deepEqual(db.reviews.byTask(a.id).map((x) => x.action), ['approve'])
})

// ---------------------------------------------------------------- request changes (PLAN 2.5)

test('validateFeedback: bắt buộc, tối thiểu 5 ký tự, trả lỗi 400 tiếng Việt', () => {
  const bad = (v: unknown, m: RegExp) =>
    assert.throws(
      () => r.validateFeedback(v),
      (e: Error & { statusCode?: number }) => e.statusCode === 400 && m.test(e.message),
    )
  bad(undefined, /Vui lòng nhập/)
  bad('   ', /Vui lòng nhập/)
  bad(42, /Vui lòng nhập/)
  bad('  abcd  ', /ít nhất 5 ký tự/)
  assert.equal(r.validateFeedback('  sửa đi  '), 'sửa đi')
})

test('resumePrompt: resume đúng phiên chỉ gửi feedback, mất session thì kèm prompt gốc', async () => {
  const { resumePrompt } = await import('./runner.ts')
  assert.equal(resumePrompt({ kind: 'initial', resume: false, taskPrompt: 'P' }), 'P')
  assert.equal(resumePrompt({ kind: 'retry', resume: false, feedback: 'x', taskPrompt: 'P' }), 'P')
  assert.equal(resumePrompt({ kind: 'resume', resume: true, feedback: 'sửa lỗi', taskPrompt: 'P' }), 'sửa lỗi')
  assert.match(resumePrompt({ kind: 'resume', resume: false, feedback: 'sửa lỗi', taskPrompt: 'P' }), /^P\n[\s\S]*sửa lỗi$/)
})

function fakeRunner(slot: boolean) {
  const calls: { taskId: number; kind: string; feedback: string }[] = []
  return {
    calls,
    deps: {
      hasSlot: () => slot,
      startRun: (task: { id: number }, kind: 'resume', feedback: string) => {
        calls.push({ taskId: task.id, kind, feedback })
        db.tasks.patch(task.id, { status: 'running', pendingFeedback: null })
      },
    },
  }
}

test('request changes: còn slot → ghi review, startRun resume kèm feedback, giữ worktree', async () => {
  const t = await reviewTask('Cần sửa', { 'fix.txt': 'v1\n' })
  db.tasks.patch(t.id, { sessionId: 'sess-1' })
  const fake = fakeRunner(true)
  messages.length = 0

  const res = await r.requestChanges(t.id, '  Đổi tên biến cho rõ  ', fake.deps)
  assert.equal(res.queued, false)
  assert.deepEqual(fake.calls, [{ taskId: t.id, kind: 'resume', feedback: 'Đổi tên biến cho rõ' }])
  assert.equal(res.task.status, 'running')
  assert.equal(res.review.action, 'request_changes')
  assert.equal(res.review.feedback, 'Đổi tên biến cho rõ')
  assert.ok(messages.some((m) => m.type === 'review' && m.review.id === res.review.id))
  assert.ok(existsSync(t.worktreePath!))
})

test('request changes: hết slot → Queued, lưu pendingFeedback, không chạy ngay', async () => {
  const t = await reviewTask('Hết slot', { 'slot.txt': 'v1\n' })
  const fake = fakeRunner(false)
  messages.length = 0

  const res = await r.requestChanges(t.id, 'Thêm test cho hàm này', fake.deps)
  assert.equal(res.queued, true)
  assert.deepEqual(fake.calls, [])
  assert.equal(res.task.status, 'queued')
  assert.equal(res.task.pendingFeedback, 'Thêm test cho hàm này')
  assert.equal(db.tasks.get(t.id)!.pendingFeedback, 'Thêm test cho hàm này')
  assert.ok(messages.some((m) => m.type === 'task' && m.task.id === t.id && m.task.status === 'queued'))
  assert.ok(existsSync(t.worktreePath!))
})

test('request changes: feedback ngắn → 400; task không ở Review → 409; không ghi review', async () => {
  const t = await reviewTask('Validate', { 'v.txt': 'v\n' })
  const fake = fakeRunner(true)
  await rejects(r.requestChanges(t.id, 'abc', fake.deps), 400, /ít nhất 5 ký tự/)
  db.tasks.patch(t.id, { status: 'done' })
  await rejects(r.requestChanges(t.id, 'feedback hợp lệ', fake.deps), 409, /không ở trạng thái Review/)
  await rejects(r.requestChanges(999_999, 'feedback hợp lệ', fake.deps), 404, /Không tìm thấy task/)
  assert.deepEqual(fake.calls, [])
  assert.deepEqual(db.reviews.byTask(t.id), [])
})

test('AC-03 (phần git): run resume thêm commit mới lên nhánh, diff tính lại có thay đổi mới', async () => {
  const { captureChanges } = await import('./capture.ts')
  const t = await reviewTask('Hai vòng', { 'round.txt': 'vòng 1\n' })
  const before = Number(await ok(t.worktreePath!, ['rev-list', '--count', 'main..HEAD']))
  // Giả lập Claude sửa tiếp trong cùng worktree sau Request changes
  writeFileSync(join(t.worktreePath!, 'round2.txt'), 'vòng 2\n')
  assert.deepEqual(await captureChanges({ id: t.id, title: t.title, worktreePath: t.worktreePath! }, project, 2), { hasChanges: true })
  assert.equal(Number(await ok(t.worktreePath!, ['rev-list', '--count', 'main..HEAD'])), before + 1)
  assert.match(await ok(t.worktreePath!, ['log', '-1', '--format=%s']), /\(run 2\)$/)
  const files = (await g.taskDiff(project, t.id)).map((f) => f.path)
  assert.ok(files.includes('round.txt') && files.includes('round2.txt'), JSON.stringify(files))
})

// ---------------------------------------------------------------- reject (PLAN 2.6)

test('reject: ghi review, xoá worktree + nhánh, task Failed với lý do', async () => {
  const t = await reviewTask('Bị từ chối', { 'rej.txt': 'x\n' })
  db.tasks.patch(t.id, { reviewWarning: 'cảnh báo' })
  const head = await ok(repo, ['rev-parse', 'HEAD'])
  messages.length = 0

  const res = await r.rejectTask(t.id)
  assert.equal(res.task.status, 'failed')
  assert.equal(res.task.failReason, 'Bị từ chối khi review')
  assert.equal(res.task.branch, undefined)
  assert.equal(res.task.worktreePath, undefined)
  assert.equal(res.task.reviewWarning, undefined)
  assert.equal(res.review.action, 'reject')
  assert.ok(!existsSync(t.worktreePath!))
  assert.notEqual((await g.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/claude/task-${t.id}`])).code, 0)
  assert.equal(await ok(repo, ['rev-parse', 'HEAD']), head) // repo chính không bị đụng
  assert.ok(!existsSync(join(repo, 'rej.txt')))
  assert.ok(messages.some((m) => m.type === 'review' && m.review.id === res.review.id))
  assert.ok(messages.some((m) => m.type === 'task' && m.task.id === t.id && m.task.status === 'failed'))

  await rejects(r.rejectTask(t.id), 409, /không ở trạng thái Review/)
  assert.deepEqual(db.reviews.byTask(t.id).map((x) => x.action), ['reject'])
})

// ---------------------------------------------------------------- nhận xét theo file/dòng (G3)

test('request changes kèm nhận xét theo dòng: Claude nhận file:dòng + nội dung dòng, review lưu nhận xét', async () => {
  const t = await reviewTask('Nhận xét dòng', { 'a.ts': 'const x = 1\n', 'b.md': '# Tiêu đề\n' })
  const fake = fakeRunner(true)
  const comments = [
    { id: 'c2', path: 'b.md', text: 'Thêm phần mô tả' },
    { id: 'c1', path: 'a.ts', line: 1, side: 'new', snippet: 'const x = 1', text: 'Đổi tên x thành count' },
  ]
  const res = await r.requestChanges(t.id, '', fake.deps, comments)
  assert.equal(res.review.feedback, undefined)
  assert.equal(res.review.comments?.length, 2)
  assert.equal(db.reviews.byTask(t.id).at(-1)?.comments?.[1].snippet, 'const x = 1')
  const prompt = (fake.calls[0] as { feedback: string }).feedback
  assert.match(prompt, /1\. a\.ts:1\n   Dòng: `const x = 1`\n   Đổi tên x thành count/)
  assert.match(prompt, /2\. b\.md \(cả file\)\n   Thêm phần mô tả/)
})

test('request changes: không có nhận xét thì feedback vẫn bắt buộc; nhận xét rỗng / sai dòng → 400', async () => {
  const t = await reviewTask('Kiểm tra nhận xét', { 'c.txt': 'c\n' })
  const fake = fakeRunner(true)
  await rejects(r.requestChanges(t.id, '', fake.deps, []), 400, /yêu cầu sửa/)
  await rejects(r.requestChanges(t.id, '', fake.deps, [{ path: 'c.txt', text: '  ' }]), 400, /chưa có nội dung/)
  await rejects(r.requestChanges(t.id, '', fake.deps, [{ path: 'c.txt', line: 0, text: 'x' }]), 400, /số dòng/)
  await rejects(r.requestChanges(t.id, 'abc', fake.deps, [{ path: 'c.txt', text: 'ok' }]), 400, /ít nhất/)
  assert.equal(fake.calls.length, 0)
})

test('reviewFiles: đọc file trong worktree, chặn đường dẫn ra ngoài / .git; sửa .md thì commit trên nhánh task', async () => {
  const rf = await import('./reviewFiles.ts')
  const t = await reviewTask('Sửa tài liệu', { 'doc.md': '# Cũ\n', 'code.ts': 'x\n' })
  assert.equal(rf.readTaskFile(t.id, 'doc.md').content, '# Cũ\n')
  for (const bad of ['../x.md', '/etc/passwd', 'C:/x.md', '.git/config', ''])
    assert.throws(() => rf.readTaskFile(t.id, bad), (e: Error & { statusCode?: number }) => e.statusCode === 400)
  assert.throws(() => rf.readTaskFile(t.id, 'khong-co.md'), (e: Error & { statusCode?: number }) => e.statusCode === 404)

  await rejects(rf.saveTaskFile(t.id, 'code.ts', 'y\n'), 400, /Markdown/)
  const before = await ok(t.worktreePath!, ['rev-list', '--count', 'HEAD'])
  assert.deepEqual(await rf.saveTaskFile(t.id, 'doc.md', '# Mới\n'), { committed: true })
  assert.equal(Number(await ok(t.worktreePath!, ['rev-list', '--count', 'HEAD'])), Number(before) + 1)
  assert.match(await ok(t.worktreePath!, ['log', '-1', '--format=%s']), /sửa tay khi review \(doc\.md\)/)
  assert.equal(readFileSync(join(t.worktreePath!, 'doc.md'), 'utf8'), '# Mới\n')

  db.tasks.patch(t.id, { status: 'done' })
  await rejects(rf.saveTaskFile(t.id, 'doc.md', 'z'), 409, /không ở trạng thái Review/)
})
