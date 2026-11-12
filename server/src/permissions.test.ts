import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// DB riêng trong bộ nhớ cho test (phải đặt trước khi import db.ts)
process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard-perm-'))
process.env.TASKBOARD_DB = ':memory:'
const { projects, runs, settings, tasks } = await import('./db.ts')
const { bus } = await import('./bus.ts')
const { decidePermission, initPermissions, listPermissions, requestPermission } = await import('./permissions.ts')
const { updateTask } = await import('./runner.ts')

initPermissions()
const sent: { type: string }[] = []
bus.on('message', (m) => sent.push(m))

projects.upsert({
  id: 'p',
  name: 'P',
  repoPath: process.env.TASKBOARD_DATA!,
  mainBranch: 'main',
  permissionMode: 'acceptEdits',
  allowedTools: ['Read', 'Bash(npm test:*)'],
  maxParallel: 1,
})

/** Task đang chạy có một run mở (giống lúc Claude CLI đang chạy). */
function runningTask() {
  const t = tasks.create({ projectId: 'p', title: 't', prompt: 'x', status: 'running', priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
  runs.create({ id: `run-${t.id}`, taskId: t.id, kind: 'initial', sessionId: 's', startedAt: Date.now() })
  return t
}

const bash = (command: string) => ({ command })

test('khớp allowlist → cho phép ngay, không tạo yêu cầu', async () => {
  const t = runningTask()
  const r = await requestPermission({ taskId: t.id, toolName: 'Bash', input: bash('npm test -- x') })
  assert.deepEqual(r, { decision: 'allow', updatedInput: bash('npm test -- x') })
  assert.equal(listPermissions().filter((p) => p.taskId === t.id).length, 0)
  assert.equal(tasks.get(t.id)!.status, 'running')
})

test('ngoài allowlist → Needs Input, long-poll trả pending, rồi nhận quyết định Cho phép', async () => {
  const t = runningTask()
  const first = await requestPermission({ taskId: t.id, toolName: 'Bash', input: bash('rm -rf dist') }, 20)
  assert.ok('status' in first && first.status === 'pending')
  const id = (first as { requestId: string }).requestId
  assert.equal(tasks.get(t.id)!.status, 'needs_input')
  assert.ok(sent.some((m) => m.type === 'permission'))

  const poll = requestPermission({ taskId: t.id, toolName: 'Bash', input: bash('rm -rf dist'), requestId: id }, 5_000)
  const req = decidePermission(id, 'allow')
  assert.equal(req.status, 'allowed')
  assert.deepEqual(await poll, { decision: 'allow', updatedInput: bash('rm -rf dist') })
  assert.equal(tasks.get(t.id)!.status, 'running')
  // Gọi lại sau khi đã quyết định vẫn nhận đúng kết quả
  assert.equal(((await requestPermission({ taskId: t.id, toolName: 'Bash', input: {}, requestId: id })) as { decision: string }).decision, 'allow')
  assert.throws(() => decidePermission(id, 'deny'), /đã được xử lý/)
})

test('Từ chối → deny kèm lý do', async () => {
  const t = runningTask()
  const p = requestPermission({ taskId: t.id, toolName: 'WebFetch', input: { url: 'https://x.test' } }, 5_000)
  const id = listPermissions().find((r) => r.taskId === t.id && r.status === 'pending')!.id
  decidePermission(id, 'deny')
  const r = await p
  assert.equal((r as { decision: string }).decision, 'deny')
  assert.match((r as { message: string }).message, /từ chối WebFetch/)
})

test('Luôn cho phép → thêm quy tắc vào project, lần sau tự cho phép ngay trong run', async () => {
  const t = runningTask()
  const cmd = bash('git log --oneline | head -5')
  const p = requestPermission({ taskId: t.id, toolName: 'Bash', input: cmd }, 5_000)
  const pending = listPermissions().find((r) => r.taskId === t.id && r.status === 'pending')!
  assert.deepEqual(pending.rules, ['Bash(git log:*)', 'Bash(head:*)'])
  decidePermission(pending.id, 'always')
  assert.equal(((await p) as { decision: string }).decision, 'allow')
  assert.ok(projects.get('p')!.allowedTools.includes('Bash(git log:*)'))
  assert.equal(((await requestPermission({ taskId: t.id, toolName: 'Bash', input: cmd }, 20)) as { decision: string }).decision, 'allow')
})

test('quá permissionTimeoutMin → tự từ chối', async () => {
  const t = runningTask()
  settings.set({ ...settings.get(), permissionTimeoutMin: 0.001 }) // 60ms
  const r = await requestPermission({ taskId: t.id, toolName: 'Bash', input: bash('curl x') }, 5_000)
  settings.set({ ...settings.get(), permissionTimeoutMin: 30 })
  assert.match((r as { message: string }).message, /Hết thời gian/)
  assert.equal(listPermissions().find((x) => x.taskId === t.id)!.status, 'timeout')
  assert.equal(tasks.get(t.id)!.status, 'running')
})

test('task dừng khi đang chờ → huỷ yêu cầu', async () => {
  const t = runningTask()
  const p = requestPermission({ taskId: t.id, toolName: 'Bash', input: bash('make deploy') }, 5_000)
  updateTask(t.id, { status: 'failed', failReason: 'Đã dừng bởi người dùng' })
  assert.equal(((await p) as { decision: string }).decision, 'deny')
  assert.equal(listPermissions().find((x) => x.taskId === t.id)!.status, 'denied')
})

test('task không chạy → 409', async () => {
  const t = tasks.create({ projectId: 'p', title: 't', prompt: 'x', status: 'backlog', priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
  await assert.rejects(requestPermission({ taskId: t.id, toolName: 'Bash', input: bash('ls') }), { statusCode: 409 })
})

test('end-to-end: MCP server ↔ route HTTP thật (token, pending, quyết định từ web)', async () => {
  const { default: Fastify } = await import('fastify')
  const { routes } = await import('./routes.ts')
  const { INTERNAL_TOKEN } = await import('./config.ts')
  const { requestDecision } = await import('./mcp/permission.ts')
  const app = Fastify()
  await app.register(routes)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as { port: number }).port
  const cfg = { taskId: '', port, token: INTERNAL_TOKEN, timeoutMs: 10_000, requestTimeoutMs: 5_000, maxNetworkErrors: 3, retryDelayMs: 10 }
  try {
    const t = runningTask()
    cfg.taskId = String(t.id)

    // khớp allowlist
    assert.deepEqual(await requestDecision({ tool_name: 'Read', input: { file_path: 'a' } }, cfg), { behavior: 'allow', updatedInput: { file_path: 'a' } })

    // sai token → deny, không treo
    const bad = await requestDecision({ tool_name: 'Bash', input: bash('ls') }, { ...cfg, token: 'x' })
    assert.equal(bad.behavior, 'deny')

    // ngoài allowlist → web duyệt qua POST /api/permissions/:id
    const pending = requestDecision({ tool_name: 'Bash', input: bash('docker ps') }, cfg)
    let req
    for (let i = 0; i < 50 && !req; i++) {
      await new Promise((r) => setTimeout(r, 10))
      req = listPermissions().find((p) => p.taskId === t.id && p.status === 'pending')
    }
    assert.ok(req)
    const state = await app.inject({ method: 'GET', url: '/api/state' })
    assert.ok(state.json().permissions.some((p: { id: string }) => p.id === req!.id))
    const res = await app.inject({ method: 'POST', url: `/api/permissions/${req!.id}`, payload: { decision: 'always' } })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: bash('docker ps') })
    assert.ok(projects.get('p')!.allowedTools.includes('Bash(docker ps:*)'))

    const invalid = await app.inject({ method: 'POST', url: `/api/permissions/${req!.id}`, payload: { decision: 'maybe' } })
    assert.equal(invalid.statusCode, 400)
  } finally {
    await app.close()
  }
})
