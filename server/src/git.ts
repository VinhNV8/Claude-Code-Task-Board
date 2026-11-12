// Thao tác git cho review flow (PLAN mục 2.1): mỗi task chạy trong worktree riêng trên nhánh claude/task-<id>.
// Luôn gọi git bằng execFile + mảng tham số (đường dẫn có dấu cách trên Windows vẫn đúng).
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DATA_DIR } from './db.ts'
import type { Project } from './types.ts'

export interface GitResult {
  stdout: string
  stderr: string
  code: number
}

/** Chạy `git -C <cwd> ...args`. Không throw khi exit code khác 0 (kể cả khi không tìm thấy git: code = -1). */
export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((res) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return res({ stdout, stderr, code: 0 })
        const code = typeof err.code === 'number' ? err.code : -1
        res({ stdout: stdout ?? '', stderr: stderr || err.message, code })
      },
    )
  })
}

const errText = (r: GitResult) => (r.stderr || r.stdout).trim() || `git thoát với mã ${r.code}`

export const taskBranch = (taskId: number) => `claude/task-${taskId}`
export const worktreeDir = (projectId: string, taskId: number) => resolve(join(DATA_DIR, 'worktrees', projectId, String(taskId)))

export interface Worktree {
  branch: string
  path: string
}

/**
 * Tạo nhánh `claude/task-<id>` từ mainBranch và worktree tại data/worktrees/<projectId>/<taskId>.
 * Chạy lại khi worktree/nhánh đã tồn tại thì tái sử dụng.
 */
export async function createWorktree(project: Pick<Project, 'id' | 'repoPath' | 'mainBranch'>, taskId: number): Promise<Worktree> {
  const branch = taskBranch(taskId)
  const path = worktreeDir(project.id, taskId)
  const repo = project.repoPath

  if (!existsSync(repo)) throw new Error(`Không tìm thấy thư mục repo: ${repo}`)
  const isRepo = await git(repo, ['rev-parse', '--git-dir'])
  if (isRepo.code !== 0) throw new Error(`Thư mục ${repo} không phải git repo: ${errText(isRepo)}`)

  // Worktree đã có và đang ở đúng nhánh → dùng lại
  if (existsSync(path)) {
    const head = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (head.code === 0 && head.stdout.trim() === branch) return { branch, path }
  }

  // Dọn đăng ký worktree đã bị xoá thư mục, nếu không `worktree add` sẽ báo nhánh đang được checkout ở nơi khác
  await git(repo, ['worktree', 'prune'])
  mkdirSync(dirname(path), { recursive: true })

  const hasBranch = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0
  let add: GitResult
  if (hasBranch) add = await git(repo, ['worktree', 'add', path, branch])
  else {
    const hasMain = await git(repo, ['rev-parse', '--verify', '--quiet', `${project.mainBranch}^{commit}`])
    if (hasMain.code !== 0) throw new Error(`Repo không có nhánh chính "${project.mainBranch}" (hoặc chưa có commit nào)`)
    add = await git(repo, ['worktree', 'add', '-b', branch, path, project.mainBranch])
  }
  if (add.code !== 0) throw new Error(`git worktree add thất bại: ${errText(add)}`)
  return { branch, path }
}

/** Xoá worktree + nhánh của task. Bỏ qua lỗi nếu đã bị xoá trước đó. */
export async function removeWorktree(project: Pick<Project, 'id' | 'repoPath'>, taskId: number) {
  const path = worktreeDir(project.id, taskId)
  await git(project.repoPath, ['worktree', 'remove', '--force', path])
  await git(project.repoPath, ['branch', '-D', taskBranch(taskId)])
  await git(project.repoPath, ['worktree', 'prune'])
  // Thư mục còn sót (không được git đăng ký) nằm trong DATA_DIR của mình nên xoá được an toàn
  try {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true })
  } catch {
    /* file bị khoá trên Windows: bỏ qua */
  }
}

/** Đưa worktree về đúng mainBranch hiện tại (dùng cho Retry). Worktree đã mất thì tạo lại. */
export async function resetWorktree(project: Pick<Project, 'id' | 'repoPath' | 'mainBranch'>, taskId: number): Promise<Worktree> {
  const wt = await createWorktree(project, taskId)
  const path = wt.path
  const reset = await git(path, ['reset', '--hard', project.mainBranch])
  if (reset.code !== 0) throw new Error(`Không reset được worktree: ${errText(reset)}`)
  const clean = await git(path, ['clean', '-fd'])
  if (clean.code !== 0) throw new Error(`Không dọn được worktree: ${errText(clean)}`)
  return wt
}

/** `git add -A` rồi commit. Trả về true nếu có commit mới, false nếu không có thay đổi. */
export async function commitAll(worktreePath: string, message: string): Promise<boolean> {
  const add = await git(worktreePath, ['add', '-A'])
  if (add.code !== 0) throw new Error(`git add thất bại: ${errText(add)}`)
  const diff = await git(worktreePath, ['diff', '--cached', '--quiet'])
  if (diff.code === 0) return false
  if (diff.code !== 1) throw new Error(`git diff thất bại: ${errText(diff)}`)
  const commit = await git(worktreePath, [
    '-c', 'user.name=Claude Task Board',
    '-c', 'user.email=taskboard@localhost',
    'commit', '-q', '-m', message,
  ])
  if (commit.code !== 0) throw new Error(`git commit thất bại: ${errText(commit)}`)
  return true
}

/** Số commit nhánh hiện tại của worktree đi trước mainBranch (Claude có thể tự commit trong lúc chạy). */
export async function commitsAhead(worktreePath: string, mainBranch: string): Promise<number> {
  const r = await git(worktreePath, ['rev-list', '--count', `${mainBranch}..HEAD`])
  if (r.code !== 0) throw new Error(`Không đếm được commit của nhánh task: ${errText(r)}`)
  return Number(r.stdout.trim()) || 0
}

/** Trạng thái repo chính: đang ở nhánh nào, có sạch không, và danh sách file chưa commit. */
export async function mainRepoStatus(project: Pick<Project, 'repoPath'>) {
  const b = await git(project.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (b.code !== 0) throw new Error(`Không đọc được nhánh của repo chính: ${errText(b)}`)
  const s = await git(project.repoPath, ['status', '--porcelain'])
  if (s.code !== 0) throw new Error(`Không đọc được trạng thái repo chính: ${errText(s)}`)
  // Mỗi dòng dạng "XY path" (không trim cả chuỗi vì X có thể là dấu cách)
  const changes = s.stdout
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.slice(3))
  return { branch: b.stdout.trim(), clean: changes.length === 0, changes }
}

export type MergeResult = { ok: true } | { ok: false; conflicts: string[]; error: string }

/**
 * `git merge --no-ff <branch> -m <message>` trong repo chính.
 * Thất bại (conflict hoặc lỗi khác) thì `git merge --abort` để repo chính trở lại như trước.
 */
export async function mergeBranch(repoPath: string, branch: string, message: string): Promise<MergeResult> {
  const m = await git(repoPath, ['merge', '--no-ff', '--no-edit', branch, '-m', message])
  if (m.code === 0) return { ok: true }
  const u = await git(repoPath, ['diff', '--name-only', '--diff-filter=U'])
  const conflicts = u.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  // Chỉ abort khi git thực sự đang dở merge (MERGE_HEAD tồn tại)
  if ((await git(repoPath, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).code === 0)
    await git(repoPath, ['merge', '--abort'])
  return { ok: false, conflicts, error: errText(m) }
}
