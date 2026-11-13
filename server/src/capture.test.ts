import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Thư mục tạm có dấu cách để kiểm tra đường dẫn trên Windows.
const root = mkdtempSync(join(tmpdir(), 'taskboard capture test '))
process.env.TASKBOARD_DATA = join(root, 'data') // phải đặt trước khi import db.ts
const repo = join(root, 'my repo')

const g = await import('./git.ts')
const c = await import('./capture.ts')

const project = { id: 'proj', repoPath: repo, mainBranch: 'main' }

async function ok(cwd: string, args: string[]) {
  const r = await g.git(cwd, args)
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

before(async () => {
  mkdirSync(repo, { recursive: true })
  await ok(repo, ['-c', 'init.defaultBranch=main', 'init'])
  await ok(repo, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  assert.equal(await g.commitAll(repo, 'initial'), true)
})

after(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {}
})

test('runNumber & commitMessage', () => {
  const rs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.equal(c.runNumber(rs, 'a'), 1)
  assert.equal(c.runNumber(rs, 'c'), 3)
  assert.equal(c.runNumber(rs, 'x'), 4)
  assert.equal(c.commitMessage({ id: 7, title: 'Tạo file hello.txt' }, 2), 'task #7: Tạo file hello.txt (run 2)')
})

test('ensureWorktree: chưa có thì tạo, có rồi thì dùng lại', async () => {
  const wt = await c.ensureWorktree({ id: 1, branch: undefined, worktreePath: undefined }, project)
  assert.equal(wt.created, true)
  assert.equal(wt.branch, 'claude/task-1')
  assert.ok(existsSync(join(wt.path, 'README.md')))

  const again = await c.ensureWorktree({ id: 1, branch: wt.branch, worktreePath: wt.path }, project)
  assert.deepEqual(again, { branch: wt.branch, path: wt.path, created: false })
  await g.removeWorktree(project, 1)
})

test('ensureWorktree: repo không hợp lệ thì throw lỗi rõ ràng', async () => {
  await assert.rejects(
    c.ensureWorktree({ id: 9, branch: undefined, worktreePath: undefined }, { ...project, repoPath: join(root, 'khong-co') }),
    /Không tìm thấy thư mục repo/,
  )
})

test('captureChanges: có thay đổi → hasChanges, 1 commit trên nhánh task, repo chính không đổi', async () => {
  const wt = await c.ensureWorktree({ id: 2, branch: undefined, worktreePath: undefined }, project)
  writeFileSync(join(wt.path, 'hello.txt'), 'hello\n')
  assert.deepEqual(await c.captureChanges({ id: 2, title: 'Tạo file hello.txt', worktreePath: wt.path }, project, 1), { hasChanges: true })
  assert.equal(await ok(repo, ['rev-list', '--count', 'main..claude/task-2']), '1')
  assert.equal(await ok(repo, ['log', '-1', '--format=%s', 'claude/task-2']), 'task #2: Tạo file hello.txt (run 1)')
  assert.ok(!existsSync(join(repo, 'hello.txt')))
  assert.equal(await ok(repo, ['status', '--porcelain']), '')

  // Run sau (Request changes) không sửa gì nhưng nhánh đã có commit → vẫn review, worktree giữ nguyên.
  assert.deepEqual(await c.captureChanges({ id: 2, title: 'x', worktreePath: wt.path }, project, 2), { hasChanges: true })
  assert.ok(existsSync(wt.path))
  await g.removeWorktree(project, 2)
})

test('captureChanges: Claude tự commit → hasChanges', async () => {
  const wt = await c.ensureWorktree({ id: 3, branch: undefined, worktreePath: undefined }, project)
  writeFileSync(join(wt.path, 'self.txt'), 'x\n')
  assert.equal(await g.commitAll(wt.path, 'claude tự commit'), true)
  assert.deepEqual(await c.captureChanges({ id: 3, title: 't', worktreePath: wt.path }, project, 1), { hasChanges: true })
  await g.removeWorktree(project, 3)
})

test('captureChanges: không có thay đổi → hasChanges false, vẫn giữ worktree để duyệt output / Request changes', async () => {
  const wt = await c.ensureWorktree({ id: 4, branch: undefined, worktreePath: undefined }, project)
  assert.deepEqual(await c.captureChanges({ id: 4, title: 't', worktreePath: wt.path }, project, 1), { hasChanges: false })
  assert.ok(existsSync(wt.path))
  assert.equal((await g.git(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/claude/task-4'])).code, 0)
  await g.removeWorktree(project, 4)
})
