import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project } from './types.ts'

// Thư mục tạm có dấu cách để kiểm tra đường dẫn trên Windows.
const root = mkdtempSync(join(tmpdir(), 'taskboard git test '))
process.env.TASKBOARD_DATA = join(root, 'data') // phải đặt trước khi import db.ts
const repo = join(root, 'my repo')

const g = await import('./git.ts')

const project: Project = {
  id: 'proj',
  name: 'Proj',
  repoPath: repo,
  mainBranch: 'main',
  permissionMode: 'acceptEdits',
  allowedTools: [],
  maxParallel: 1,
}

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
  // File SQLite còn mở trên Windows có thể khiến xoá thất bại: bỏ qua, thư mục temp sẽ được dọn sau.
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {}
})

test('git() không throw khi exit code khác 0', async () => {
  const r = await g.git(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/khong-ton-tai'])
  assert.notEqual(r.code, 0)
})

test('mainRepoStatus: nhánh và trạng thái sạch', async () => {
  assert.deepEqual(await g.mainRepoStatus(project), { branch: 'main', clean: true, changes: [] })
  writeFileSync(join(repo, 'dirty.txt'), 'x')
  assert.deepEqual(await g.mainRepoStatus(project), { branch: 'main', clean: false, changes: ['dirty.txt'] })
  rmSync(join(repo, 'dirty.txt'))
})

test('createWorktree tạo nhánh + worktree, gọi lại thì tái sử dụng', async () => {
  const wt = await g.createWorktree(project, 1)
  assert.equal(wt.branch, 'claude/task-1')
  assert.equal(wt.path, join(process.env.TASKBOARD_DATA!, 'worktrees', 'proj', '1'))
  assert.ok(existsSync(join(wt.path, 'README.md')))
  assert.equal(await ok(wt.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'claude/task-1')

  writeFileSync(join(wt.path, 'keep.txt'), 'giữ nguyên')
  const again = await g.createWorktree(project, 1)
  assert.deepEqual(again, wt)
  assert.ok(existsSync(join(wt.path, 'keep.txt')), 'chạy lại không được tạo mới worktree')
  rmSync(join(wt.path, 'keep.txt'))
})

test('commitAll: có thay đổi thì commit, không có thì false', async () => {
  const { path } = await g.createWorktree(project, 1)
  assert.equal(await g.commitAll(path, 'không có gì'), false)

  writeFileSync(join(path, 'feature.txt'), 'new feature\n')
  assert.equal(await g.commitAll(path, 'task #1: feature (run 1)'), true)
  assert.equal(await ok(path, ['log', '-1', '--format=%s|%an|%ae']), 'task #1: feature (run 1)|Claude Task Board|taskboard@localhost')
  assert.equal(await ok(path, ['status', '--porcelain']), '')
  // Commit nằm trên nhánh task, repo chính không đổi.
  assert.equal(await ok(repo, ['rev-list', '--count', 'main..claude/task-1']), '1')
  assert.ok(!existsSync(join(repo, 'feature.txt')))
})

test('resetWorktree đưa worktree về đúng main hiện tại', async () => {
  const { path } = await g.createWorktree(project, 1)
  writeFileSync(join(path, 'untracked.txt'), 'rác')
  writeFileSync(join(path, 'README.md'), 'sửa dở\n')

  // main tiến thêm một commit sau khi worktree được tạo.
  writeFileSync(join(repo, 'main2.txt'), 'main moved\n')
  assert.equal(await g.commitAll(repo, 'main moves'), true)

  await g.resetWorktree(project, 1)
  assert.equal(await ok(path, ['rev-parse', 'HEAD']), await ok(repo, ['rev-parse', 'main']))
  assert.equal(await ok(path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'claude/task-1')
  assert.ok(!existsSync(join(path, 'untracked.txt')))
  assert.ok(!existsSync(join(path, 'feature.txt')))
  assert.ok(existsSync(join(path, 'main2.txt')))
  assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), 'hello\n')
})

test('removeWorktree xoá worktree + nhánh, gọi lại không lỗi', async () => {
  const { path } = await g.createWorktree(project, 1)
  await g.removeWorktree(project, 1)
  assert.ok(!existsSync(path))
  assert.equal((await g.git(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/claude/task-1'])).code, 1)
  assert.doesNotMatch(await ok(repo, ['worktree', 'list']), /task/)

  await g.removeWorktree(project, 1) // đã xoá rồi: không throw
})

test('createWorktree tái sử dụng nhánh có sẵn khi thư mục worktree đã mất', async () => {
  const { path } = await g.createWorktree(project, 2)
  writeFileSync(join(path, 'two.txt'), '2\n')
  assert.equal(await g.commitAll(path, 'task #2'), true)
  rmSync(path, { recursive: true, force: true }) // mất thư mục, nhánh vẫn còn

  const wt = await g.createWorktree(project, 2)
  assert.ok(existsSync(join(wt.path, 'two.txt')), 'phải checkout lại nhánh cũ, giữ commit')
  await g.removeWorktree(project, 2)
})

test('resetWorktree tạo lại worktree nếu đã bị xoá', async () => {
  await g.removeWorktree(project, 3)
  const { path } = await g.resetWorktree(project, 3)
  assert.equal(await ok(path, ['rev-parse', 'HEAD']), await ok(repo, ['rev-parse', 'main']))
  await g.removeWorktree(project, 3)
})
