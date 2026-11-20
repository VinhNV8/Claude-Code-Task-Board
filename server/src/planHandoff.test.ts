// SPEC-PLAN-HANDOFF: luồng qua API thật (DB in-memory, không spawn agent).
//   Phần A: planMode khi tạo task, duyệt kế hoạch, góp ý, chỉ kế hoạch, chuyển dữ liệu `plan` cũ (A5).
//   Phần B: mở trong Claude Code, khoá task, extension nhận việc, đưa về Review.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard plan handoff '))
process.env.TASKBOARD_DB = ':memory:'
const { db, migrateLegacyPlan, projects, reviews, runs, settings, tasks } = await import('./db.ts')
const { setLauncherForTest } = await import('./runner.ts')
const { setAdapterForTest } = await import('./agents/index.ts')
const { claudeAdapter } = await import('./agents/claude.ts')
const { routes } = await import('./routes.ts')
const { EXECUTE_FEEDBACK, PLAN_INSTRUCTION } = await import('../../web/src/lib/planMode.ts')
const { handoffs } = await import('./handoff.ts')
const { default: Fastify } = await import('fastify')
import type { Task } from './types.ts'

const launched: number[] = []
setLauncherForTest((t) => {
  launched.push(t.id)
  tasks.patch(t.id, { status: 'running' })
})
setAdapterForTest('claude', { ...claudeAdapter, findBin: () => ({ path: 'C:\\Tools\\claude.exe', source: 'test' }) })
const app = Fastify()
await app.register(routes)
after(async () => {
  setLauncherForTest()
  setAdapterForTest('claude')
  await app.close()
})

settings.set({ ...settings.get(), maxParallel: 5 })
const DIR = process.env.TASKBOARD_DATA!
const project = (id: string, o: object = {}) =>
  projects.upsert({
    id,
    name: id,
    repoPath: DIR,
    mainBranch: 'main',
    permissionMode: 'auto',
    allowedTools: [],
    maxParallel: 5,
    budgetAction: 'warn',
    deliveryMode: 'worktree',
    ...o,
  })
project('p')
project('pf', { defaultPlanMode: 'first' })
// Project chỉ chạy 1 task một lúc và đang bận: Yêu cầu sửa / Góp ý vào hàng đợi, không spawn agent thật.
project('busy', { maxParallel: 1 })
tasks.create({ projectId: 'busy', title: 'đang chạy', prompt: 'giữ slot của project', status: 'running', priority: 'normal', permissionMode: 'auto', tags: [] })

async function api<T = Record<string, unknown>>(method: string, url: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object })
  return { status: res.statusCode, body: res.json() as T & { error?: string; code?: string } }
}

/** Giả lập lượt Kế hoạch đã chạy xong: run phase plan có kết quả, task ở Review. */
function planned(projectId: string, planMode: 'first' | 'only', plan = '## Các bước\n1. Sửa a.ts') {
  const t = tasks.create({ projectId, title: `t-${randomUUID()}`, prompt: 'yêu cầu đủ dài', status: 'review', priority: 'normal', permissionMode: 'auto', tags: [], planMode })
  const run = runs.create({ id: randomUUID(), taskId: t.id, kind: 'initial', sessionId: 's1', startedAt: 1, agent: 'claude', phase: 'plan' })
  runs.finish(run.id, { endedAt: 2, exitCode: 0, summary: plan })
  return tasks.patch(t.id, { planPhase: 'plan', sessionId: 's1' })!
}

test('tạo task: planMode gửi lên / mặc định của project / mức quyền `plan` cũ thành "Chỉ kế hoạch" (A5)', async () => {
  const base = { projectId: 'p', title: 'T', prompt: 'Làm việc gì đó đủ dài' }
  assert.equal((await api<Task>('POST', '/api/tasks', { ...base, planMode: 'Kế hoạch trước' })).body.planMode, 'first')
  assert.equal((await api<Task>('POST', '/api/tasks', base)).body.planMode, undefined, 'project mặc định: làm luôn')
  assert.equal((await api<Task>('POST', '/api/tasks', { ...base, projectId: 'pf' })).body.planMode, 'first', 'mặc định của project')
  const legacy = (await api<Task>('POST', '/api/tasks', { ...base, permissionMode: 'plan' })).body
  assert.equal(legacy.planMode, 'only')
  assert.equal(legacy.permissionMode, 'auto', 'mức quyền theo project, lượt Kế hoạch vẫn chạy mode plan')
  const bad = await api('POST', '/api/tasks', { ...base, planMode: 'lung tung' })
  assert.equal(bad.status, 400)
})

test('Kế hoạch trước: Approve bị chặn, "Duyệt và thực hiện" lưu bản đã sửa, task Queued ở giai đoạn Thực hiện (AC-44, AC-45)', async () => {
  const t = planned('p', 'first')
  const approve = await api('POST', `/api/tasks/${t.id}/review`, { action: 'approve' })
  assert.equal(approve.status, 409)
  assert.match(approve.body.error!, /Duyệt và thực hiện/)

  launched.length = 0
  const r = await api<{ task: Task }>('POST', `/api/tasks/${t.id}/review`, { action: 'approve_plan', plan: '## Các bước\n1. Sửa b.ts' })
  assert.equal(r.status, 200, r.body.error)
  const after = tasks.get(t.id)!
  assert.equal(after.planPhase, 'execute')
  assert.equal(after.approvedPlan, '## Các bước\n1. Sửa b.ts')
  assert.equal(after.pendingFeedback, EXECUTE_FEEDBACK, 'lượt kế tiếp là resume đúng phiên của lượt Kế hoạch')
  assert.deepEqual(launched, [t.id], 'D3: vào hàng đợi rồi pump chạy khi có slot')
  assert.equal(reviews.byTask(t.id).at(-1)?.action, 'approve_plan')
  assert.match(reviews.byTask(t.id).at(-1)?.feedback ?? '', /Đã sửa kế hoạch/)
})

test('Duyệt không sửa: dùng nguyên kết quả lượt Kế hoạch; kế hoạch trống thì báo lỗi', async () => {
  const t = planned('busy', 'first', '## KH gốc')
  const r = await api('POST', `/api/tasks/${t.id}/review`, { action: 'approve_plan' })
  assert.equal(r.status, 200, r.body.error)
  assert.equal(tasks.get(t.id)!.approvedPlan, '## KH gốc')
  assert.equal(tasks.get(t.id)!.status, 'queued')
  const empty = planned('busy', 'first', '')
  assert.equal((await api('POST', `/api/tasks/${empty.id}/review`, { action: 'approve_plan' })).status, 400)
})

test('Góp ý ở bước kế hoạch: lập lại kế hoạch, vẫn kèm chỉ dẫn lập kế hoạch (AC-46)', async () => {
  const t = planned('busy', 'first')
  const r = await api<{ queued: boolean }>('POST', `/api/tasks/${t.id}/review`, { action: 'request_changes', feedback: 'Bỏ bước 3 đi' })
  assert.equal(r.status, 200, r.body.error)
  assert.equal(r.body.queued, true)
  const after = tasks.get(t.id)!
  assert.ok(after.pendingFeedback?.includes('Bỏ bước 3 đi'))
  assert.ok(after.pendingFeedback?.includes(PLAN_INSTRUCTION))
  assert.equal(after.planPhase, 'plan')
})

test('Chỉ kế hoạch: Chấp nhận là Done, không có lượt Thực hiện (AC-48)', async () => {
  const t = planned('p', 'only')
  assert.equal((await api('POST', `/api/tasks/${t.id}/review`, { action: 'approve_plan' })).status, 409)
  const r = await api('POST', `/api/tasks/${t.id}/review`, { action: 'approve' })
  assert.equal(r.status, 200, r.body.error)
  assert.equal(tasks.get(t.id)!.status, 'done')
})

test('A5: dữ liệu mức quyền `plan` cũ chuyển thành planMode, không task nào bị nới quyền (AC-49)', () => {
  project('legacy', { permissionMode: 'acceptEdits' })
  db.prepare("UPDATE projects SET permission_mode = 'plan' WHERE id = 'legacy'").run()
  const mk = (status: Task['status']) => {
    const t = tasks.create({ projectId: 'legacy', title: status, prompt: 'yêu cầu đủ dài', status, priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
    db.prepare("UPDATE tasks SET permission_mode = 'plan' WHERE id = ?").run(t.id)
    return t.id
  }
  const backlog = mk('backlog')
  const review = mk('review')
  migrateLegacyPlan()
  const p = projects.get('legacy')!
  assert.equal(p.permissionMode, 'manual')
  assert.equal(p.defaultPlanMode, 'only')
  for (const id of [backlog, review]) {
    const t = tasks.get(id)!
    assert.equal(t.planMode, 'only')
    assert.equal(t.permissionMode, 'manual')
  }
  assert.equal(tasks.get(backlog)!.planPhase, undefined)
  assert.equal(tasks.get(review)!.planPhase, 'plan')
})

// ---------------------------------------------------------------- Phần B

function reviewTask() {
  const t = tasks.create({ projectId: 'p', title: 'mở tay', prompt: 'yêu cầu đủ dài', status: 'review', priority: 'normal', permissionMode: 'auto', tags: [] })
  runs.create({ id: randomUUID(), taskId: t.id, kind: 'initial', sessionId: 'sess-1', startedAt: 1, agent: 'claude', requestedModel: 'sonnet' })
  return tasks.patch(t.id, { sessionId: 'sess-1' })!
}

test('mở trong Claude Code: trả lệnh resume đúng phiên, khoá task, chặn mọi thao tác chạy (FR-111, FR-113, AC-53)', async () => {
  const t = reviewTask()
  const r = await api<{ requestId: string; command: { args: string[]; cwd: string; display: string } }>('POST', `/api/tasks/${t.id}/handoff`, { via: 'copy' })
  assert.equal(r.status, 200, r.body.error)
  assert.deepEqual(r.body.command.args, ['--resume', 'sess-1', '--model', 'sonnet'])
  assert.equal(r.body.command.cwd, DIR)
  assert.ok(r.body.command.display.startsWith(`cd "${DIR}"`) || r.body.command.display.startsWith(`cd ${DIR}`))
  const state = await api<{ tasks: Task[] }>('GET', '/api/state')
  assert.equal(state.body.tasks.find((x) => x.id === t.id)?.handoff?.via, 'copy')

  for (const [method, url, body] of [
    ['POST', `/api/tasks/${t.id}/review`, { action: 'approve' }],
    ['POST', `/api/tasks/${t.id}/review`, { action: 'request_changes', feedback: 'sửa đi nào' }],
    ['POST', `/api/tasks/${t.id}/review`, { action: 'reject' }],
    ['POST', `/api/tasks/${t.id}/handoff`, { via: 'copy' }],
  ] as const)
    assert.equal((await api(method, url, body)).status, 409, url)

  const end = await api<Task>('POST', `/api/tasks/${t.id}/handoff/end`, {})
  assert.equal(end.status, 200, end.body.error)
  assert.equal(tasks.get(t.id)!.status, 'review')
  assert.equal(handoffs.get(t.id), undefined)
  const manual = runs.byTask(t.id).at(-1)!
  assert.equal(manual.kind, 'manual', 'FR-115: lịch sử có lượt làm tay')
  assert.equal(manual.costUsd, undefined, 'D9: chi phí không rõ, không ghi 0')
})

test('extension: long-poll thấy yêu cầu, chỉ lần claim đầu thành công, requestId cũ không mở khoá lần mới (AC-56, AC-57)', async () => {
  const t = reviewTask()
  const start = await api<{ requestId: string }>('POST', `/api/tasks/${t.id}/handoff`, { via: 'extension' })
  const wait = await api<{ pending: { taskId: number; requestId: string; repoPath: string }[] }>('GET', '/api/handoffs/wait')
  assert.deepEqual(
    wait.body.pending.find((p) => p.taskId === t.id),
    { taskId: t.id, requestId: start.body.requestId, repoPath: DIR },
  )
  const claim = await api<{ file: string; args: string[] }>('POST', `/api/tasks/${t.id}/handoff/claim`, { requestId: start.body.requestId })
  assert.equal(claim.status, 200, claim.body.error)
  assert.equal(claim.body.file, 'C:\\Tools\\claude.exe')
  assert.equal((await api('POST', `/api/tasks/${t.id}/handoff/claim`, { requestId: start.body.requestId })).status, 409, 'cửa sổ thứ hai')
  assert.equal(tasks.get(t.id) && (await api<{ tasks: Task[] }>('GET', '/api/state')).body.tasks.find((x) => x.id === t.id)?.handoff?.claimed, true)
  assert.equal((await api('POST', `/api/tasks/${t.id}/handoff/end`, { requestId: 'cũ' })).status, 409)
  assert.equal((await api('POST', `/api/tasks/${t.id}/handoff/end`, { requestId: start.body.requestId })).status, 200)
})

test('task đang chạy / trong hàng đợi: phải xác nhận dừng; Backlog và agent chưa hỗ trợ thì không mở được (B3, AC-58)', async () => {
  const q = reviewTask()
  tasks.patch(q.id, { status: 'queued' })
  const ask = await api('POST', `/api/tasks/${q.id}/handoff`, { via: 'copy' })
  assert.equal(ask.status, 409)
  assert.equal(ask.body.code, 'NEEDS_STOP')
  assert.equal((await api('POST', `/api/tasks/${q.id}/handoff`, { via: 'copy', stop: true })).status, 200)
  assert.equal(tasks.get(q.id)!.status, 'failed', 'đã bỏ khỏi hàng đợi')
  assert.equal((await api('POST', `/api/tasks/${q.id}/retry`)).status, 409, 'đang khoá thì không Chạy lại được')

  const b = tasks.create({ projectId: 'p', title: 'mới', prompt: 'yêu cầu đủ dài', status: 'backlog', priority: 'normal', permissionMode: 'auto', tags: [] })
  assert.equal((await api('POST', `/api/tasks/${b.id}/handoff`, { via: 'copy' })).status, 409)

  const g = reviewTask()
  runs.create({ id: randomUUID(), taskId: g.id, kind: 'resume', sessionId: 'x', startedAt: 5, agent: 'antigravity' })
  assert.equal((await api('POST', `/api/tasks/${g.id}/handoff`, { via: 'copy' })).status, 409)
})
