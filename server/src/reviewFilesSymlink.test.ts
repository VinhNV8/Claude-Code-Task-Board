// resolveInWorktree: symlink/junction trỏ ra ngoài thư mục task không được đọc/ghi (rò file như ~/.ssh qua Review/xem trước HTML).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'taskboard symlink test '))
process.env.TASKBOARD_DB = ':memory:'
process.env.TASKBOARD_DATA = join(root, 'data')
const { resolveInWorktree } = await import('./reviewFiles.ts')

after(() => rmSync(root, { recursive: true, force: true }))

const worktree = join(root, 'worktree')
const outside = join(root, 'outside')
mkdirSync(join(worktree, 'docs'), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(worktree, 'docs', 'a.md'), '# a\n')
writeFileSync(join(outside, 'id_rsa'), 'SECRET')

/** Tạo liên kết; Windows: thư mục dùng junction (không cần quyền admin), file cần Developer Mode → bỏ qua nếu không được. */
function link(target: string, path: string, type: 'dir' | 'file') {
  try {
    symlinkSync(target, path, type === 'dir' && process.platform === 'win32' ? 'junction' : type)
    return true
  } catch {
    return false
  }
}

test('file thường trong worktree: trả về đường dẫn thật', () => {
  assert.equal(resolveInWorktree(worktree, 'docs/a.md'), realpathSync.native(join(worktree, 'docs', 'a.md')))
  // Chưa có file: vẫn trả đường dẫn (nơi gọi tự báo 404)
  assert.match(resolveInWorktree(worktree, 'docs/new.md'), /new\.md$/)
})

test('thư mục liên kết (junction/symlink) ra ngoài worktree bị chặn', () => {
  assert.ok(link(outside, join(worktree, 'leak'), 'dir'), 'không tạo được junction')
  assert.throws(() => resolveInWorktree(worktree, 'leak/id_rsa'), /symlink/)
})

test('liên kết trỏ vào bên trong worktree vẫn dùng được', () => {
  assert.ok(link(join(worktree, 'docs'), join(worktree, 'docs-link'), 'dir'))
  assert.equal(resolveInWorktree(worktree, 'docs-link/a.md'), realpathSync.native(join(worktree, 'docs', 'a.md')))
})

test('file symlink ra ngoài worktree bị chặn', (t) => {
  if (!link(join(outside, 'id_rsa'), join(worktree, 'notes.md'), 'file')) return t.skip('máy không cho tạo symlink file (Windows cần Developer Mode)')
  assert.throws(() => resolveInWorktree(worktree, 'notes.md'), /symlink/)
})

test('liên kết vào .git bị chặn', () => {
  mkdirSync(join(worktree, '.git'), { recursive: true })
  writeFileSync(join(worktree, '.git', 'config'), '[core]\n')
  assert.ok(link(join(worktree, '.git'), join(worktree, 'gitdir'), 'dir'))
  assert.throws(() => resolveInWorktree(worktree, 'gitdir/config'), /\.git/)
})
