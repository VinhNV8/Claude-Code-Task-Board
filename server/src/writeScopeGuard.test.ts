// FR-49 (chặn cứng): ghi file ngoài phạm vi ghi bị từ chối ngay ở cả hai cổng duyệt quyền. DB in-memory, không spawn agent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard-scopeguard-'))
process.env.TASKBOARD_DB = ':memory:'
const { projects, runs, tasks } = await import('./db.ts')
const { decidePermission, initPermissions, listPermissions, requestPermission } = await import('./permissions.ts')
const { relToCwd, scopeViolation, writePathOf } = await import('./writeScopeGuard.ts')
const { awaitPermission } = await import('./permissionBroker.ts')
const { buildClaudeArgs, effectivePermissionMode } = await import('./permissionTool.ts')
import type { PermissionMode } from './types.ts'

initPermissions()
const ROOT = process.env.TASKBOARD_DATA!

projects.upsert({
  id: 'p',
  name: 'P',
  repoPath: ROOT,
  mainBranch: 'main',
  permissionMode: 'acceptEdits',
  allowedTools: ['Read'],
  maxParallel: 1,
  budgetAction: 'warn',
  deliveryMode: 'direct',
})

function runningTask(permissionMode: PermissionMode, writeScope?: string[]) {
  const t = tasks.create({ projectId: 'p', title: 't', prompt: 'viết tài liệu', status: 'running', priority: 'normal', permissionMode, tags: [], writeScope })
  runs.create({ id: `run-${t.id}`, taskId: t.id, kind: 'initial', sessionId: 's', startedAt: Date.now() })
  return t
}

test('relToCwd: tuyệt đối trong cwd, tương đối, ngoài cwd, không phân biệt hoa thường trên Windows', () => {
  assert.equal(relToCwd('/repo/docs/a.md', '/repo', false), 'docs/a.md')
  assert.equal(relToCwd('docs/a.md', '/repo', false), 'docs/a.md')
  assert.equal(relToCwd('/other/a.md', '/repo', false), undefined)
  assert.equal(relToCwd('/repo/../etc/x', '/repo', false), undefined)
  assert.equal(relToCwd('C:\\Repo\\Docs\\a.md', 'c:/repo', true), 'Docs/a.md')
  assert.equal(relToCwd('/repox/a.md', '/repo', false), undefined)
})

test('scopeViolation: trả file vi phạm đầu tiên; không có phạm vi thì luôn hợp lệ; thiếu đường dẫn thì đóng an toàn', () => {
  assert.equal(scopeViolation(['/repo/src/a.ts'], '/repo', undefined), undefined)
  assert.equal(scopeViolation(['/repo/docs/a.md', '/repo/README.md'], '/repo', ['docs/**', '*.md']), undefined)
  assert.equal(scopeViolation(['/repo/docs/a.md', '/repo/src/b.ts'], '/repo', ['docs/**']), 'src/b.ts')
  assert.equal(scopeViolation(['/elsewhere/x.md'], '/repo', ['*.md']), '/elsewhere/x.md')
  assert.equal(scopeViolation([undefined], '/repo', ['docs/**']), '(không rõ đường dẫn)')
  assert.equal(scopeViolation([], '/repo', ['docs/**']), '(không rõ đường dẫn)')
})

test('writePathOf: chỉ tool ghi file', () => {
  assert.equal(writePathOf('Edit', { file_path: '/r/a' }), '/r/a')
  assert.equal(writePathOf('NotebookEdit', { notebook_path: '/r/n.ipynb' }), '/r/n.ipynb')
  assert.equal(writePathOf('Read', { file_path: '/r/a' }), undefined)
  assert.equal(writePathOf('Bash', { command: 'echo > a' }), undefined)
})

test('Claude CLI: task có phạm vi ghi ở acceptEdits/Auto chạy manual để mọi lệnh ghi qua backend', () => {
  assert.equal(effectivePermissionMode('acceptEdits', true, true), 'manual')
  assert.equal(effectivePermissionMode('auto', true, true), 'manual')
  assert.equal(effectivePermissionMode('manual', true, true), 'manual')
  assert.equal(effectivePermissionMode('plan', true, true), 'plan')
  // Không có prompt tool (phương án dự phòng): không chặn được, giữ như cũ (chỉ còn cảnh báo ở Review)
  assert.equal(effectivePermissionMode('acceptEdits', false, true), 'acceptEdits')
  // Không có phạm vi: như cũ
  assert.equal(effectivePermissionMode('acceptEdits', true, false), 'acceptEdits')
  assert.equal(effectivePermissionMode('auto', true, false), 'acceptEdits')
  const args = buildClaudeArgs({ sessionId: 's', resume: false, permissionMode: 'auto', allowedTools: [], mcpConfigPath: '/tmp/mcp.json', writeScoped: true })
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'manual')
})

test('Claude, Edit automatically: ghi ngoài phạm vi bị từ chối ngay, ghi trong phạm vi được tự cho phép', async () => {
  const t = runningTask('acceptEdits', ['docs/**'])
  const out = await requestPermission({ taskId: t.id, toolName: 'Edit', input: { file_path: join(ROOT, 'src', 'app.ts') } }, 20)
  assert.ok('decision' in out && out.decision === 'deny')
  assert.match((out as { message: string }).message, /src\/app\.ts nằm ngoài phạm vi ghi/)
  assert.equal(tasks.get(t.id)!.status, 'running') // không vào Needs Input
  const inside = { file_path: join(ROOT, 'docs', 'guide.md') }
  assert.deepEqual(await requestPermission({ taskId: t.id, toolName: 'Write', input: inside }, 20), { decision: 'allow', updatedInput: inside })
  assert.equal(listPermissions().filter((p) => p.taskId === t.id).length, 0)
})

test('Claude, Auto: ngoài phạm vi vẫn bị từ chối dù mode Auto tự duyệt mọi thứ', async () => {
  const t = runningTask('auto', ['docs/**'])
  const out = await requestPermission({ taskId: t.id, toolName: 'MultiEdit', input: { file_path: join(ROOT, 'package.json') } }, 20)
  assert.ok('decision' in out && out.decision === 'deny')
  const inside = { file_path: join(ROOT, 'docs', 'a.md') }
  assert.deepEqual(await requestPermission({ taskId: t.id, toolName: 'Edit', input: inside }, 20), { decision: 'allow', updatedInput: inside })
})

test('Claude, Manual: ngoài phạm vi bị từ chối ngay; trong phạm vi vẫn chờ người duyệt', async () => {
  const t = runningTask('manual', ['docs/**'])
  const out = await requestPermission({ taskId: t.id, toolName: 'Edit', input: { file_path: join(ROOT, 'src', 'x.ts') } }, 20)
  assert.ok('decision' in out && out.decision === 'deny')
  const pending = await requestPermission({ taskId: t.id, toolName: 'Edit', input: { file_path: join(ROOT, 'docs', 'x.md') } }, 20)
  assert.ok('status' in pending && pending.status === 'pending')
  decidePermission((pending as { requestId: string }).requestId, 'deny')
})

test('task không có phạm vi ghi: không đổi hành vi (ghi ở mức Manual vẫn chờ người duyệt)', async () => {
  const t = runningTask('manual')
  const pending = await requestPermission({ taskId: t.id, toolName: 'Edit', input: { file_path: join(ROOT, 'src', 'x.ts') } }, 20)
  assert.ok('status' in pending && pending.status === 'pending')
  decidePermission((pending as { requestId: string }).requestId, 'deny')
})

test('Codex/Antigravity: cổng chung từ chối khi có file ngoài phạm vi, kể cả file thứ hai của một lần sửa', async () => {
  let asked = 0
  const deps = {
    requestPermission: async () => {
      asked++
      return { decision: 'allow' as const, updatedInput: {} }
    },
  }
  const ctx = { mode: 'acceptEdits' as const, cwd: '/repo', writeScope: ['docs/**'] }
  const multi = await awaitPermission({ taskId: 1, kind: 'edit', path: '/repo/docs/a.md', paths: ['/repo/docs/a.md', '/repo/src/b.ts'] }, ctx, deps)
  assert.equal(multi.allow, false)
  assert.match((multi as { message: string }).message, /src\/b\.ts/)
  const one = await awaitPermission({ taskId: 1, kind: 'write', path: '/repo/src/new.ts' }, ctx, deps)
  assert.equal(one.allow, false)
  assert.equal(asked, 0) // không hỏi backend, không có yêu cầu chờ duyệt
  // Trong phạm vi: acceptEdits tự cho phép như trước
  assert.deepEqual(await awaitPermission({ taskId: 1, kind: 'edit', path: '/repo/docs/a.md', paths: ['/repo/docs/a.md'] }, ctx, deps), { allow: true })
  // Lệnh shell không bị phạm vi ghi chặn (đi tiếp tới backend)
  assert.deepEqual(await awaitPermission({ taskId: 1, kind: 'shell', command: 'npm test' }, ctx, deps), { allow: true })
  assert.equal(asked, 1)
})
