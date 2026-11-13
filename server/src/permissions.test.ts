import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// DB riêng trong bộ nhớ cho test (phải đặt trước khi import db.ts)
process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard-perm-'))
process.env.TASKBOARD_DB = ':memory:'
const { events, projects, runs, settings, tasks } = await import('./db.ts')
const { bus, broadcast } = await import('./bus.ts')
const { decidePermission, decidePermissionsBatch, expireOverdue, initPermissions, listPermissions, requestPermission, setPermissionClock } = await import('./permissions.ts')
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
  budgetAction: 'warn' as const,
  deliveryMode: 'worktree' as const,
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
  // vẫn ghi lại vào log của run để truy vết
  const logged = events.byRun(`run-${t.id}`).map((e) => (e as { text?: string }).text ?? '')
  assert.ok(logged.some((s) => /Tự động cho phép Bash\(npm test -- x\)/.test(s)), logged.join('\n'))
})

test('quy tắc đường dẫn tương đối tính từ worktree của task', async () => {
  const t = runningTask()
  const wt = join(process.env.TASKBOARD_DATA!, 'worktrees', `task-${t.id}`)
  updateTask(t.id, { worktreePath: wt })
  projects.upsert({ ...projects.get('p')!, allowedTools: [...projects.get('p')!.allowedTools, 'Edit(src/**)'] })
  try {
    const inside = { file_path: join(wt, 'src', 'a.ts') }
    assert.deepEqual(await requestPermission({ taskId: t.id, toolName: 'Write', input: inside }), { decision: 'allow', updatedInput: inside })
    const outside = await requestPermission({ taskId: t.id, toolName: 'Edit', input: { file_path: join(wt, 'package.json') } }, 20)
    assert.ok('status' in outside && outside.status === 'pending')
    decidePermission((outside as { requestId: string }).requestId, 'deny')
  } finally {
    projects.upsert({ ...projects.get('p')!, allowedTools: projects.get('p')!.allowedTools.filter((r) => r !== 'Edit(src/**)') })
  }
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

test('Từ chối không có lý do → giữ message cũ', async () => {
  const t = runningTask()
  const p = requestPermission({ taskId: t.id, toolName: 'Bash', input: bash('npm i lodash') }, 5_000)
  const id = pendingOf(t.id)[0].id
  const req = decidePermission(id, 'deny', '   ')
  assert.equal(req.denyReason, undefined)
  assert.equal(((await p) as { message: string }).message, 'Người dùng đã từ chối Bash trên Task Board.')
})

test('Từ chối có lý do → message cho Claude chứa lý do, lưu deny_reason', async () => {
  const t = runningTask()
  const p = requestPermission({ taskId: t.id, toolName: 'Bash', input: bash('npm i lodash') }, 5_000)
  const id = pendingOf(t.id)[0].id
  const req = decidePermission(id, 'deny', '  Dùng pnpm thay npm  ')
  assert.equal(req.denyReason, 'Dùng pnpm thay npm')
  const r = (await p) as { decision: string; message: string }
  assert.equal(r.decision, 'deny')
  assert.equal(
    r.message,
    'Người dùng đã từ chối Bash trên Task Board. Lý do: Dùng pnpm thay npm. Hãy điều chỉnh cách làm theo lý do này, không thử lại đúng thao tác vừa bị từ chối.',
  )
  assert.equal(listPermissions().find((x) => x.id === id)!.denyReason, 'Dùng pnpm thay npm')
  // long-poll gọi lại sau khi đã quyết định vẫn nhận lý do
  const again = (await requestPermission({ taskId: t.id, toolName: 'Bash', input: {}, requestId: id })) as { message: string }
  assert.match(again.message, /Lý do: Dùng pnpm thay npm/)
})

test('lý do quá 500 ký tự → 400, yêu cầu vẫn chờ', async () => {
  const t = runningTask()
  const r = (await requestPermission({ taskId: t.id, toolName: 'Bash', input: bash('npm i x') }, 20)) as { requestId: string }
  assert.throws(() => decidePermission(r.requestId, 'deny', 'a'.repeat(501)), { statusCode: 400 })
  assert.equal(pendingOf(t.id).length, 1)
  decidePermission(r.requestId, 'deny', 'a'.repeat(500))
})

test('duyệt hàng loạt: cho phép nhiều task, id đã xử lý/không tồn tại → skipped', async () => {
  const [a, b, c] = [runningTask(), runningTask(), runningTask()]
  const cmd = bash('npm run build')
  const ps = [a, b, c].map((t) => requestPermission({ taskId: t.id, toolName: 'Bash', input: cmd }, 5_000))
  const ids = [a, b, c].map((t) => pendingOf(t.id)[0].id)
  decidePermission(ids[2], 'deny') // đã xử lý trước khi batch
  const res = decidePermissionsBatch([...ids, ids[0], 'perm-khong-co'], 'allow')
  assert.deepEqual(res, { decided: 2, skipped: 2 })
  const out = await Promise.all(ps)
  assert.deepEqual(out.map((r) => (r as { decision: string }).decision), ['allow', 'allow', 'deny'])
  assert.equal(tasks.get(a.id)!.status, 'running')
  assert.equal(tasks.get(b.id)!.status, 'running')
})

test('duyệt hàng loạt: từ chối kèm lý do', async () => {
  const [a, b] = [runningTask(), runningTask()]
  const ps = [a, b].map((t) => requestPermission({ taskId: t.id, toolName: 'Bash', input: bash('npm i axios') }, 5_000))
  const ids = [a, b].map((t) => pendingOf(t.id)[0].id)
  assert.deepEqual(decidePermissionsBatch(ids, 'deny', 'Không cài thêm thư viện'), { decided: 2, skipped: 0 })
  for (const r of await Promise.all(ps)) assert.match((r as { message: string }).message, /Lý do: Không cài thêm thư viện\./)
})

test('duyệt hàng loạt: always hoặc ids sai → 400', async () => {
  const t = runningTask()
  const r = (await requestPermission({ taskId: t.id, toolName: 'Bash', input: bash('npm ci') }, 20)) as { requestId: string }
  assert.throws(() => decidePermissionsBatch([r.requestId], 'always'), { statusCode: 400 })
  assert.throws(() => decidePermissionsBatch('x', 'allow'), { statusCode: 400 })
  assert.throws(() => decidePermissionsBatch([], 'allow'), { statusCode: 400 })
  assert.equal(pendingOf(t.id).length, 1)
  decidePermission(r.requestId, 'deny')
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

test('mode Auto: tự duyệt lệnh ngoài allowlist, lệnh rủi ro cao vẫn chờ người', async () => {
  const t = runningTask()
  updateTask(t.id, { permissionMode: 'auto' })
  const cmd = bash('npm install lodash')
  assert.deepEqual(await requestPermission({ taskId: t.id, toolName: 'Bash', input: cmd }), { decision: 'allow', updatedInput: cmd })
  assert.equal(listPermissions().filter((p) => p.taskId === t.id).length, 0)
  const logged = events.byRun(`run-${t.id}`).map((e) => (e as { text?: string }).text ?? '')
  assert.ok(logged.some((s) => /mode Auto/.test(s)), logged.join('\n'))

  const risky = await requestPermission({ taskId: t.id, toolName: 'Bash', input: bash('git push') }, 20)
  assert.ok('status' in risky && risky.status === 'pending')
  assert.equal(tasks.get(t.id)!.status, 'needs_input')
  decidePermission((risky as { requestId: string }).requestId, 'deny')
})

test('rủi ro cao: khớp allowlist vẫn chờ duyệt tay, không cho "Luôn cho phép" (AC-10)', async () => {
  const t = runningTask()
  const cmd = bash('npm test && git push')
  projects.upsert({ ...projects.get('p')!, allowedTools: [...projects.get('p')!.allowedTools, 'Bash(git push:*)'] })
  try {
    const first = await requestPermission({ taskId: t.id, toolName: 'Bash', input: cmd }, 20)
    assert.ok('status' in first && first.status === 'pending')
    assert.equal(tasks.get(t.id)!.status, 'needs_input')
    const req = listPermissions().find((r) => r.id === first.requestId)!
    assert.equal(req.risk, 'high')
    assert.deepEqual(req.riskReasons, ['Đẩy code lên remote'])

    assert.throws(() => decidePermission(req.id, 'always'), (e: { statusCode: number; message: string }) => {
      assert.equal(e.statusCode, 400)
      assert.match(e.message, /Lệnh rủi ro cao không thể đặt Luôn cho phép/)
      return true
    })
    assert.equal(listPermissions().find((r) => r.id === req.id)!.status, 'pending', 'yêu cầu vẫn chờ sau khi bị từ chối "always"')
    // Vẫn được Cho phép một lần
    assert.equal(decidePermission(req.id, 'allow').status, 'allowed')
  } finally {
    projects.upsert({ ...projects.get('p')!, allowedTools: projects.get('p')!.allowedTools.filter((r) => r !== 'Bash(git push:*)') })
  }
})

test('rủi ro: Edit ngoài worktree → high, trong worktree → normal', async () => {
  const t = runningTask()
  const wt = join(process.env.TASKBOARD_DATA!, 'work trees', `task-${t.id}`)
  updateTask(t.id, { worktreePath: wt })
  const outside = (await requestPermission({ taskId: t.id, toolName: 'Edit', input: { file_path: join(wt, '..', 'x.ts') } }, 20)) as { requestId: string }
  const inside = (await requestPermission({ taskId: t.id, toolName: 'Edit', input: { file_path: join(wt, 'a b.ts') } }, 20)) as { requestId: string }
  const byId = (id: string) => listPermissions().find((r) => r.id === id)!
  assert.equal(byId(outside.requestId).risk, 'high')
  assert.deepEqual(byId(outside.requestId).riskReasons, ['Ghi file ngoài thư mục task'])
  assert.equal(byId(inside.requestId).risk, 'normal')
  assert.equal(byId(inside.requestId).riskReasons, undefined)
  decidePermission(outside.requestId, 'deny')
  decidePermission(inside.requestId, 'deny')
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

/** Đồng hồ giả cho hạn chờ; luôn trả về đồng hồ thật sau mỗi test. */
function fakeClock(start = 1_700_000_000_000) {
  const c = { t: start, advance: (ms: number) => (c.t += ms) }
  setPermissionClock(() => c.t)
  return c
}
function pendingOf(taskId: number) {
  return listPermissions().filter((x) => x.taskId === taskId && x.status === 'pending')
}

test('đồng hồ giả: lưu timeout_at theo permissionTimeoutMin, quá hạn → timeout, deny cho Claude, broadcast', async (t) => {
  t.after(() => setPermissionClock())
  const clock = fakeClock()
  settings.set({ ...settings.get(), permissionTimeoutMin: 30 })
  const task = runningTask()
  const p = requestPermission({ taskId: task.id, toolName: 'Bash', input: bash('npm publish') }, 5_000)
  const [req] = pendingOf(task.id)
  assert.equal(req.createdAt, clock.t)
  assert.equal(req.timeoutAt, clock.t + 30 * 60_000)
  assert.equal(tasks.get(task.id)!.status, 'needs_input')

  clock.advance(30 * 60_000 - 1)
  assert.equal(expireOverdue(), 0, 'chưa tới hạn thì không đóng')
  assert.equal(pendingOf(task.id).length, 1)

  const before = sent.length
  clock.advance(1)
  assert.equal(expireOverdue(), 1)
  const r = (await p) as { decision: string; message: string }
  assert.equal(r.decision, 'deny')
  assert.match(r.message, /Hết thời gian chờ duyệt quyền/)
  const pushed = sent.slice(before).filter((m) => m.type === 'permission') as unknown as { permission: { id: string; status: string } }[]
  assert.ok(pushed.some((m) => m.permission.id === req.id && m.permission.status === 'timeout'))
  assert.equal(listPermissions().find((x) => x.id === req.id)!.status, 'timeout')
  assert.equal(tasks.get(task.id)!.status, 'running')
  assert.throws(() => decidePermission(req.id, 'allow'), /đã được xử lý/)
})

test('đồng hồ giả: MCP gọi lại long-poll sau hạn → đóng timeout ngay, không chờ timer', async (t) => {
  t.after(() => setPermissionClock())
  const clock = fakeClock()
  settings.set({ ...settings.get(), permissionTimeoutMin: 5 })
  const task = runningTask()
  const first = (await requestPermission({ taskId: task.id, toolName: 'WebFetch', input: { url: 'https://z.test' } }, 10)) as { requestId: string }
  assert.ok(first.requestId)
  clock.advance(5 * 60_000)
  const r = (await requestPermission({ taskId: task.id, toolName: 'WebFetch', input: {}, requestId: first.requestId }, 5_000)) as { message: string }
  assert.match(r.message, /Hết thời gian chờ duyệt quyền/)
  assert.equal(listPermissions().find((x) => x.id === first.requestId)!.status, 'timeout')
  settings.set({ ...settings.get(), permissionTimeoutMin: 30 })
})

test('permissionTimeoutMin rất lớn (> 24,8 ngày) không làm setTimeout tràn số và từ chối ngay', async () => {
  settings.set({ ...settings.get(), permissionTimeoutMin: 60 * 24 * 40 })
  const task = runningTask()
  const r = await requestPermission({ taskId: task.id, toolName: 'Bash', input: bash('sleep 1') }, 50)
  settings.set({ ...settings.get(), permissionTimeoutMin: 30 })
  assert.ok('status' in r && r.status === 'pending')
  assert.equal(pendingOf(task.id).length, 1)
  decidePermission(r.requestId, 'deny')
})

test('khởi động lại server → yêu cầu còn treo được đóng như timeout và broadcast', async () => {
  const task = runningTask()
  const p = requestPermission({ taskId: task.id, toolName: 'Bash', input: bash('terraform apply') }, 5_000)
  const [req] = pendingOf(task.id)
  const before = sent.length
  initPermissions() // mô phỏng lần khởi động sau
  assert.equal(listPermissions().find((x) => x.id === req.id)!.status, 'timeout')
  assert.match(((await p) as { message: string }).message, /Hết thời gian chờ duyệt quyền/)
  assert.ok(sent.slice(before).some((m) => m.type === 'permission'))
  // Long-poll gọi lại sau khi khởi động vẫn nhận deny
  const again = (await requestPermission({ taskId: task.id, toolName: 'Bash', input: {}, requestId: req.id })) as { decision: string }
  assert.equal(again.decision, 'deny')
})

test('task dừng khi đang chờ → huỷ yêu cầu', async () => {
  const t = runningTask()
  const p = requestPermission({ taskId: t.id, toolName: 'Bash', input: bash('make deploy') }, 5_000)
  updateTask(t.id, { status: 'failed', failReason: 'Đã dừng bởi người dùng' })
  assert.equal(((await p) as { decision: string }).decision, 'deny')
  assert.equal(listPermissions().find((x) => x.taskId === t.id)!.status, 'denied')
})

test('tiến trình Claude kết thúc khi đang chờ → huỷ yêu cầu, task về Running để runner chốt kết quả', async () => {
  const t = runningTask()
  const p = requestPermission({ taskId: t.id, toolName: 'Bash', input: bash('docker compose up') }, 5_000)
  const p2 = requestPermission({ taskId: t.id, toolName: 'WebFetch', input: { url: 'https://y.test' } }, 5_000)
  assert.equal(tasks.get(t.id)!.status, 'needs_input')
  assert.equal(listPermissions().filter((x) => x.taskId === t.id && x.status === 'pending').length, 2)

  // Giống runner.finish(): đóng run rồi broadcast
  broadcast({ type: 'run', run: runs.finish(`run-${t.id}`, { endedAt: Date.now(), exitCode: 0 }) })
  for (const r of [await p, await p2]) {
    assert.equal((r as { decision: string }).decision, 'deny')
  }
  assert.ok(listPermissions().filter((x) => x.taskId === t.id).every((x) => x.status === 'denied'))
  assert.equal(tasks.get(t.id)!.status, 'running')
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

    // FR-46: route batch (always → 400, id đã xử lý → skipped) và deny kèm lý do qua HTTP
    const always = await app.inject({ method: 'POST', url: '/api/permissions/batch', payload: { ids: [req!.id], decision: 'always' } })
    assert.equal(always.statusCode, 400)
    const batch = await app.inject({ method: 'POST', url: '/api/permissions/batch', payload: { ids: [req!.id], decision: 'allow' } })
    assert.deepEqual(batch.json(), { decided: 0, skipped: 1 })

    const denied = requestDecision({ tool_name: 'Bash', input: bash('npm install left-pad') }, cfg)
    let req2
    for (let i = 0; i < 50 && !req2; i++) {
      await new Promise((r) => setTimeout(r, 10))
      req2 = listPermissions().find((p) => p.taskId === t.id && p.status === 'pending')
    }
    const d = await app.inject({ method: 'POST', url: `/api/permissions/${req2!.id}`, payload: { decision: 'deny', reason: 'Dùng pnpm thay npm' } })
    assert.equal(d.json().denyReason, 'Dùng pnpm thay npm')
    const out = await denied
    assert.equal(out.behavior, 'deny')
    assert.match((out as { message: string }).message, /Lý do: Dùng pnpm thay npm/)
  } finally {
    await app.close()
  }
})
