// Đọc / sửa file trong worktree của task khi review (G3): Preview và Edit file Markdown.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { projects, tasks } from './db.ts'
import { commitAll } from './git.ts'
import { ReviewError, withLock } from './review.ts'
import { isMarkdownPath } from '../../web/src/lib/reviewComments.ts'
import type { Task } from './types.ts'

export const MAX_FILE_BYTES = 1024 * 1024

/**
 * Đường dẫn tuyệt đối của `rel` trong worktree. Từ chối đường dẫn tuyệt đối, đi ra ngoài worktree
 * (`..`) hoặc vào thư mục `.git`.
 */
export function resolveInWorktree(worktree: string, rel: unknown): string {
  const p = typeof rel === 'string' ? rel.trim() : ''
  if (!p) throw new ReviewError(400, 'Thiếu đường dẫn file')
  if (isAbsolute(p) || /^[a-zA-Z]:/.test(p)) throw new ReviewError(400, 'Đường dẫn file phải là đường dẫn tương đối trong repo')
  const root = resolve(worktree)
  const abs = resolve(root, p)
  const r = relative(root, abs)
  if (!r || r.startsWith('..') || isAbsolute(r)) throw new ReviewError(400, 'Đường dẫn file nằm ngoài thư mục của task')
  if (r.split(sep).some((seg) => seg.toLowerCase() === '.git')) throw new ReviewError(400, 'Không được truy cập thư mục .git')
  return abs
}

function worktreeOf(taskId: number): { task: Task; worktree: string } {
  const task = tasks.get(taskId)
  if (!task) throw new ReviewError(404, `Không tìm thấy task #${taskId}`)
  if (!task.worktreePath || !existsSync(task.worktreePath))
    throw new ReviewError(409, `Task #${taskId} không còn worktree (đã merge hoặc đã dọn)`)
  return { task, worktree: task.worktreePath }
}

/** Nội dung hiện tại của file trong worktree của task. */
export function readTaskFile(taskId: number, path: unknown): { path: string; content: string } {
  const { worktree } = worktreeOf(taskId)
  const abs = resolveInWorktree(worktree, path)
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new ReviewError(404, `Không tìm thấy file ${String(path)}`)
  if (statSync(abs).size > MAX_FILE_BYTES) throw new ReviewError(413, 'File lớn hơn 1 MB, không hiển thị được')
  return { path: String(path).trim(), content: readFileSync(abs, 'utf8') }
}

/**
 * Lưu nội dung file Markdown do người dùng sửa khi review, rồi commit trên nhánh task.
 * Chỉ khi task đang ở Review; cùng khoá với approve/request changes để không chạy chồng.
 */
export async function saveTaskFile(taskId: number, path: unknown, content: unknown): Promise<{ committed: boolean }> {
  const first = tasks.get(taskId)
  if (!first) throw new ReviewError(404, `Không tìm thấy task #${taskId}`)
  if (typeof content !== 'string') throw new ReviewError(400, 'Thiếu nội dung file')
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new ReviewError(413, 'Nội dung lớn hơn 1 MB')
  return withLock(first.projectId, async () => {
    const { task, worktree } = worktreeOf(taskId)
    if (task.status !== 'review') throw new ReviewError(409, `Task #${taskId} không ở trạng thái Review`)
    if (!projects.get(task.projectId)) throw new ReviewError(404, `Không tìm thấy project của task #${taskId}`)
    const rel = String(path).trim()
    if (!isMarkdownPath(rel)) throw new ReviewError(400, 'Chỉ sửa trực tiếp được file Markdown (.md)')
    const abs = resolveInWorktree(worktree, rel)
    if (!existsSync(abs)) throw new ReviewError(404, `Không tìm thấy file ${rel}`)
    writeFileSync(abs, content, 'utf8')
    const committed = await commitAll(worktree, `task #${task.id}: sửa tay khi review (${rel})`)
    return { committed }
  })
}
