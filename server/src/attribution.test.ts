// FR-64: mode Ghi thẳng chỉ ghi nhận thay đổi của chính task. FR-63: project mới có git mặc định Nhánh git riêng.
// DB in-memory, thư mục tạm thật, snapshot git thật; không spawn agent.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard-attr-'))
process.env.TASKBOARD_DB = ':memory:'
const { events, projects, runs, tasks } = await import('./db.ts')
const { activityOf, splitByActivity, WINDOW_MARGIN_MS } = await import('./attribution.ts')
const { snapshotTree, taskDiff } = await import('./git.ts')
const { captureChanges } = await import('./capture.ts')
const { routes, defaultDeliveryMode } = await import('./routes.ts')
const { default: Fastify } = await import('fastify')
import type { FileDiff, LogEvent, Project } from './types.ts'

const app = Fastify()
await app.register(routes)
after(async () => {
  await app.close()
})

const ev = (runId: string, ts: number, e: Partial<LogEvent> & { type: LogEvent['type'] }) => ({ id: String(ts), runId, ts, ...e }) as LogEvent
const fd = (path: string, status: FileDiff['status'] = 'modified', oldPath?: string): FileDiff => ({ path, status, oldPath, additions: 1, deletions: 0, hunks: [] })

// ---------------------------------------------------------------- hàm thuần

test('activityOf: tool ghi file → đường dẫn tương đối; lệnh shell → cửa sổ thời gian; Codex dùng startedAt; làm tay → cả lần chạy', () => {
  const runList = [
    { id: 'r1', kind: 'initial' as const, startedAt: 1000, endedAt: 9000 },
    { id: 'r2', kind: 'manual' as const, startedAt: 20_000, endedAt: 30_000 },
  ]
  const evs: Record<string, LogEvent[]> = {
    r1: [
      ev('r1', 1100, { type: 'tool_use', tool: 'Write', input: '/repo/docs/a.md' }),
      ev('r1', 1200, { type: 'tool_use', tool: 'Edit', input: 'docs/b.md, docs/c.md' }),
      ev('r1', 1300, { type: 'tool_use', tool: 'Read', input: 'src/x.ts' }),
      ev('r1', 2000, { type: 'tool_use', tool: 'Bash', input: 'npm run build' }),
      ev('r1', 2500, { type: 'tool_result', tool: 'Bash', output: 'ok' }),
      ev('r1', 5000, { type: 'tool_use', tool: 'Bash', input: 'rm dist/old.js', startedAt: 4000 } as Partial<LogEvent> & { type: 'tool_use' }),
      ev('r1', 5000, { type: 'tool_result', tool: 'Bash', output: '' }),
    ],
    r2: [],
  }
  const act = activityOf(runList, (id) => evs[id], '/repo', 99_000)
  assert.deepEqual(act.writes, ['docs/a.md', 'docs/b.md', 'docs/c.md'])
  assert.deepEqual(act.windows, [
    [2000 - WINDOW_MARGIN_MS, 2500 + WINDOW_MARGIN_MS],
    [4000 - WINDOW_MARGIN_MS, 5000 + WINDOW_MARGIN_MS],
    [20_000 - WINDOW_MARGIN_MS, 30_000 + WINDOW_MARGIN_MS],
  ])
  assert.match(act.shellText, /rm dist\/old\.js/)
})

test('splitByActivity: file ghi bằng tool, file đổi trong lúc chạy lệnh, file xoá bằng lệnh là của task; còn lại là thay đổi khác', () => {
  const act = { writes: ['docs/a.md', 'docs/renamed-from.md'], windows: [[10_000, 12_000]] as [number, number][], shellText: 'rm dist/old.js' }
  const mtimes: Record<string, number> = { 'build/out.txt': 11_000, 'src/x.ts': 50_000, 'docs/a.md': 50_000 }
  const files = [fd('docs/a.md'), fd('build/out.txt', 'added'), fd('src/x.ts'), fd('dist/old.js', 'deleted'), fd('lib/gone.ts', 'deleted'), fd('docs/new.md', 'modified', 'docs/renamed-from.md')]
  const { own, foreign } = splitByActivity(files, act, (p) => mtimes[p], false)
  assert.deepEqual(own.map((f) => f.path), ['docs/a.md', 'build/out.txt', 'dist/old.js', 'docs/new.md'])
  assert.deepEqual(foreign, ['src/x.ts', 'lib/gone.ts'])
})

test('splitByActivity: so đường dẫn không phân biệt hoa thường trên Windows', () => {
  const act = { writes: ['Docs/A.md'], windows: [], shellText: '' }
  assert.deepEqual(splitByActivity([fd('docs/a.md')], act, () => undefined, true).own.length, 1)
  assert.deepEqual(splitByActivity([fd('docs/a.md')], act, () => undefined, false).own.length, 0)
})

// ---------------------------------------------------------------- tích hợp: snapshot thật, chốt lúc run xong

const repo = join(process.env.TASKBOARD_DATA!, 'direct-repo')
mkdirSync(join(repo, 'docs'), { recursive: true })
mkdirSync(join(repo, 'src'), { recursive: true })
writeFileSync(join(repo, 'src', 'x.ts'), 'export const x = 1\n')
const P: Project = { id: 'pd', name: 'pd', repoPath: repo, mainBranch: 'main', permissionMode: 'acceptEdits', allowedTools: [], maxParallel: 1, budgetAction: 'warn', deliveryMode: 'direct' }
projects.upsert(P)

test('mode Ghi thẳng: diff của task chỉ có file task ghi; thay đổi của session khác nằm trong foreignFiles, kể cả sửa tiếp sau khi task xong', async () => {
  const baseRef = await snapshotTree(P)
  const t = tasks.create({ projectId: 'pd', title: 'viết tài liệu', prompt: 'viết tài liệu cho module', status: 'running', priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
  tasks.patch(t.id, { baseRef, worktreePath: repo })
  const t0 = Date.now()
  runs.create({ id: 'run-a', taskId: t.id, kind: 'initial', sessionId: 's', startedAt: t0 - 30_000 })
  // Agent: ghi docs/a.md bằng tool; chạy lệnh shell tạo build/out.txt
  events.add('run-a', { type: 'tool_use', tool: 'Write', input: 'docs/a.md' }, t0 - 25_000)
  writeFileSync(join(repo, 'docs', 'a.md'), '# Tài liệu\n')
  events.add('run-a', { type: 'tool_use', tool: 'Bash', input: 'node gen.js' }, t0 - 20_000)
  mkdirSync(join(repo, 'build'), { recursive: true })
  writeFileSync(join(repo, 'build', 'out.txt'), 'generated\n')
  utimesSync(join(repo, 'build', 'out.txt'), new Date(t0 - 19_500), new Date(t0 - 19_500))
  events.add('run-a', { type: 'tool_result', tool: 'Bash', output: 'ok' }, t0 - 19_000)
  // Session khác sửa src/x.ts lúc task không chạy lệnh nào
  writeFileSync(join(repo, 'src', 'x.ts'), 'export const x = 2 // session khác\n')
  utimesSync(join(repo, 'src', 'x.ts'), new Date(t0 - 10_000), new Date(t0 - 10_000))

  // Đang chạy: diff tính trực tiếp, đã lọc
  const live = await taskDiff(P, t.id)
  assert.deepEqual(live.map((f) => f.path).sort(), ['build/out.txt', 'docs/a.md'])

  // Run xong: chốt foreignFiles
  const cap = await captureChanges({ id: t.id, title: t.title, baseRef, worktreePath: repo }, P, 1)
  assert.equal(cap.hasChanges, true)
  tasks.patch(t.id, { status: 'review', headRef: cap.headRef })
  assert.deepEqual(tasks.get(t.id)!.foreignFiles, ['src/x.ts'])
  const done = await taskDiff(P, t.id)
  assert.deepEqual(done.map((f) => f.path).sort(), ['build/out.txt', 'docs/a.md'])

  // Sau khi task xong, session khác sửa tiếp src/x.ts: diff của task không đổi
  writeFileSync(join(repo, 'src', 'x.ts'), 'export const x = 3\n')
  assert.deepEqual((await taskDiff(P, t.id)).map((f) => f.path).sort(), ['build/out.txt', 'docs/a.md'])
})

test('mode Ghi thẳng: run chỉ có thay đổi của người khác → hasChanges = false, mọi file nằm trong foreignFiles', async () => {
  const baseRef = await snapshotTree(P)
  const t = tasks.create({ projectId: 'pd', title: 'phân tích', prompt: 'phân tích code hiện có', status: 'running', priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
  tasks.patch(t.id, { baseRef, worktreePath: repo })
  runs.create({ id: 'run-b', taskId: t.id, kind: 'initial', sessionId: 's', startedAt: Date.now() - 1000 })
  writeFileSync(join(repo, 'src', 'other.ts'), 'export {}\n')
  const cap = await captureChanges({ id: t.id, title: t.title, baseRef, worktreePath: repo }, P, 1)
  assert.equal(cap.hasChanges, false)
  assert.deepEqual(tasks.get(t.id)!.foreignFiles, ['src/other.ts'])
})

// ---------------------------------------------------------------- FR-63: mặc định Nhánh git riêng

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })

test('defaultDeliveryMode: git repo có commit → worktree; repo chưa có commit hoặc không có git → direct', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'tb-plain-'))
  assert.equal(await defaultDeliveryMode(plain), 'direct')
  const empty = mkdtempSync(join(tmpdir(), 'tb-empty-'))
  git(empty, 'init', '-q')
  assert.equal(await defaultDeliveryMode(empty), 'direct')
  const withCommit = mkdtempSync(join(tmpdir(), 'tb-git-'))
  git(withCommit, 'init', '-q')
  writeFileSync(join(withCommit, 'a.txt'), 'a')
  git(withCommit, 'add', '.')
  git(withCommit, 'commit', '-q', '-m', 'init')
  assert.equal(await defaultDeliveryMode(withCommit), 'worktree')
})

test('POST /api/projects không gửi deliveryMode: project mới tự chọn; project đã có giữ nguyên lựa chọn', async () => {
  const gitDir = mkdtempSync(join(tmpdir(), 'tb-git2-'))
  git(gitDir, 'init', '-q')
  writeFileSync(join(gitDir, 'a.txt'), 'a')
  git(gitDir, 'add', '.')
  git(gitDir, 'commit', '-q', '-m', 'init')
  const created = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'g', repoPath: gitDir } })).json() as Project
  assert.equal(created.deliveryMode, 'worktree')
  const plain = mkdtempSync(join(tmpdir(), 'tb-plain2-'))
  const p2 = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'd', repoPath: plain } })).json() as Project
  assert.equal(p2.deliveryMode, 'direct')
  // Sửa project đã có mà không gửi deliveryMode: giữ nguyên (không tự chuyển)
  const kept = (await app.inject({ method: 'POST', url: '/api/projects', payload: { ...p2, deliveryMode: undefined, name: 'd2' } })).json() as Project
  assert.equal(kept.deliveryMode, 'direct')
})
