// Thao tác git cho review flow (PLAN mục 2.1): mỗi task chạy trong worktree riêng trên nhánh claude/task-<id>.
// Luôn gọi git bằng execFile + mảng tham số (đường dẫn có dấu cách trên Windows vẫn đúng).
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DATA_DIR } from './db.ts'
import { parseGitDiff } from '../../web/src/lib/diff.ts'
import type { FileDiff, Project } from './types.ts'

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

/** Như `git` nhưng stdout giữ nguyên bytes (đọc file nhị phân bằng `git show`). */
export function gitBuffer(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((res) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'buffer', maxBuffer }, (err, stdout, stderr) => {
      const errOut = stderr ? stderr.toString('utf8') : ''
      if (!err) return res({ stdout, stderr: errOut, code: 0 })
      res({ stdout: stdout ?? Buffer.alloc(0), stderr: errOut || err.message, code: typeof err.code === 'number' ? err.code : -1 })
    })
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
  // -z: tên file không bị quote/escape; liệt kê từng file chưa track (không gộp thành thư mục)
  const s = await git(project.repoPath, ['status', '--porcelain', '-z', '--untracked-files=all'])
  if (s.code !== 0) throw new Error(`Không đọc được trạng thái repo chính: ${errText(s)}`)
  return { branch: b.stdout.trim(), ...parsePorcelainZ(s.stdout) }
}

/**
 * Phân tích `git status --porcelain -z`: mỗi mục "XY path\0"; đổi tên/copy có thêm "đường dẫn cũ\0" ngay sau.
 * `changes`: mọi file chưa commit (kể cả tên cũ khi đổi tên); `staged`: file đã `git add` (cột X).
 */
export function parsePorcelainZ(out: string) {
  const parts = out.split('\0')
  const changes: string[] = []
  const staged: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]
    if (e.length < 4) continue
    const x = e[0]
    const y = e[1]
    const path = e.slice(3)
    changes.push(path)
    if (x !== ' ' && x !== '?' && x !== '!') staged.push(path)
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const old = parts[++i]
      if (old) changes.push(old)
    }
  }
  return { clean: changes.length === 0, changes, staged }
}

/** File nhánh task thay đổi so với điểm rẽ nhánh từ mainBranch (đổi tên tính cả tên cũ lẫn tên mới). */
export async function branchChangedFiles(repoPath: string, branch: string, mainBranch: string): Promise<string[]> {
  const r = await git(repoPath, ['diff', '--name-only', '-z', '--no-renames', `${mainBranch}...${branch}`])
  if (r.code !== 0) throw new Error(`Không đọc được danh sách file của nhánh "${branch}": ${errText(r)}`)
  return r.stdout.split('\0').filter(Boolean)
}

export type MergeResult = { ok: true } | { ok: false; conflicts: string[]; error: string }

/**
 * `git merge --no-ff <branch> -m <message>` trong repo chính.
 * Thất bại (conflict hoặc lỗi khác) thì `git merge --abort` để repo chính trở lại như trước.
 */
export async function mergeBranch(repoPath: string, branch: string, message: string): Promise<MergeResult> {
  // Repo chưa cấu hình danh tính thì git không tạo được merge commit: dùng danh tính của Task Board.
  const hasIdentity = (await git(repoPath, ['config', 'user.email'])).stdout.trim() !== ''
  const identity = hasIdentity ? [] : ['-c', 'user.name=Claude Task Board', '-c', 'user.email=taskboard@localhost']
  const m = await git(repoPath, [...identity, 'merge', '--no-ff', '--no-edit', branch, '-m', message])
  if (m.code === 0) return { ok: true }
  const u = await git(repoPath, ['diff', '--name-only', '--diff-filter=U'])
  const conflicts = u.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  // Chỉ abort khi git thực sự đang dở merge (MERGE_HEAD tồn tại)
  if ((await git(repoPath, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).code === 0)
    await git(repoPath, ['merge', '--abort'])
  return { ok: false, conflicts, error: errText(m) }
}

/**
 * Diff của nhánh task so với mainBranch (PLAN 2.3): `git diff <main>...claude/task-<id>`.
 * Nhánh không tồn tại (task chưa chạy hoặc đã dọn) → [].
 */
export async function taskDiff(project: Pick<Project, 'repoPath' | 'mainBranch'>, taskId: number): Promise<FileDiff[]> {
  const branch = taskBranch(taskId)
  const repo = project.repoPath
  if (!existsSync(repo)) return []
  const has = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  if (has.code !== 0) return []
  const r = await git(repo, [
    '-c', 'core.quotePath=false',
    'diff', '--no-color', '--no-ext-diff', '-M',
    `${project.mainBranch}...${branch}`, '--',
  ])
  if (r.code !== 0) throw new Error(`git diff thất bại: ${errText(r)}`)
  return parseGitDiff(r.stdout)
}
