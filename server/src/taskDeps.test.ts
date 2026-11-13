// C-02 (FR-08): phụ thuộc giữa task với DB thật (in-memory): API, pump() bỏ qua task đang chờ,
// "Chạy ngay" 409 DEPS_PENDING, gợi ý từ văn bản, xử lý BLOCKED_BY. Launcher giả, không spawn Claude.
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard deps '))
process.env.TASKBOARD_DB = ':memory:'
const { events, projects, runs, settings, taskDeps, tasks } = await import('./db.ts')
const { handleBlocked, pump, setLauncherForTest } = await import('./runner.ts')
const { decideBlocked } = await import('./taskDeps.ts')
const { buildClaudeArgs } = await import('./permissionTool.ts')
const { BLOCKED_BY_INSTRUCTION } = await import('../../web/src/lib/deps.ts')
const { routes } = await import('./routes.ts')
const { default: Fastify } = await import('fastify')
import type { Task } from './types.ts'

const launched: number[] = []
setLauncherForTest((t) => {
  launched.push(t.id)
  tasks.patch(t.id, { status: 'running' }) // giữ slot như runner thật
})
const app = Fastify()
await app.register(routes)
after(async () => {
  setLauncherForTest()
  await app.close()
})

settings.set({ ...settings.get(), maxParallel: 5 })
for (const id of ['p1', 'p2'])
  projects.upsert({
    id,
    name: id,
    repoPath: process.env.TASKBOARD_DATA!,
    mainBranch: 'main',
    permissionMode: 'acceptEdits',
    allowedTools: [],
    maxParallel: 5,
    budgetAction: 'warn',
  })

const mk = (title: string, status: Task['status'] = 'backlog', projectId = 'p1') =>
  tasks.create({ projectId, title, prompt: 'làm gì đó đủ dài', status, priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
const inject = (method: 'POST' | 'PATCH' | 'DELETE' | 'GET', url: string, payload?: object) => app.inject({ method, url, payload })

beforeEach(() => {
  launched.length = 0
  // Các task cũ không còn chiếm slot / không bị pump lấy ra
  for (const t of tasks.all()) if (t.status === 'queued' || t.status === 'running') tasks.patch(t.id, { status: 'done' })
})

test('POST /api/tasks lưu dependsOn; task trả về có dependsOn; kiểm tra hợp lệ', async () => {
  const a = mk('[X-01] A')
  const res = await inject('POST', '/api/tasks', { projectId: 'p1', title: 'B', prompt: 'làm gì đó đủ dài', dependsOn: [a.id, a.id] })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().dependsOn, [a.id])
  assert.deepEqual(tasks.get(res.json().id)!.dependsOn, [a.id])

  const other = mk('khác project', 'backlog', 'p2')
  const bad = await inject('POST', '/api/tasks', { projectId: 'p1', title: 'C', prompt: 'làm gì đó đủ dài', dependsOn: [other.id] })
  assert.equal(bad.statusCode, 400)
  assert.match(bad.json().error, /project khác/)
  assert.equal((await inject('POST', '/api/tasks', { projectId: 'p1', title: 'C', prompt: 'làm gì đó đủ dài', dependsOn: [999999] })).statusCode, 400)
  assert.equal((await inject('POST', '/api/tasks', { projectId: 'p1', title: 'C', prompt: 'làm gì đó đủ dài', dependsOn: 'x' })).statusCode, 400)
})

test('PATCH: chặn vòng tròn và tự chờ chính nó; [] gỡ hết; đổi project khi còn liên kết bị chặn', async () => {
  const a = mk('A')
  const b = mk('B')
  assert.equal((await inject('PATCH', `/api/tasks/${b.id}`, { dependsOn: [a.id] })).statusCode, 200)
  const cyc = await inject('PATCH', `/api/tasks/${a.id}`, { dependsOn: [b.id] })
  assert.equal(cyc.statusCode, 400)
  assert.match(cyc.json().error, /vòng tròn/)
  assert.equal((await inject('PATCH', `/api/tasks/${a.id}`, { dependsOn: [a.id] })).statusCode, 400)
  // a đang được b chờ → không chuyển a sang project khác
  assert.equal((await inject('PATCH', `/api/tasks/${a.id}`, { projectId: 'p2' })).statusCode, 400)
  assert.equal((await inject('PATCH', `/api/tasks/${b.id}`, { projectId: 'p2' })).statusCode, 400)
  const cleared = await inject('PATCH', `/api/tasks/${b.id}`, { dependsOn: [] })
  assert.equal(cleared.json().dependsOn, undefined)
})

test('pump(): task chờ task chưa Done thì đứng yên, task độc lập chạy song song; task được chờ Done thì chạy', () => {
  const a = mk('A', 'queued')
  const b = mk('B', 'queued')
  const c = mk('C', 'queued')
  taskDeps.set(b.id, [a.id])
  pump()
  assert.deepEqual(launched.sort(), [a.id, c.id].sort())
  assert.equal(tasks.get(b.id)!.status, 'queued')

  // A sang Review: chưa đủ (R2)
  tasks.patch(a.id, { status: 'review' })
  launched.length = 0
  pump()
  assert.deepEqual(launched, [])
  // A Done → B chạy
  tasks.patch(a.id, { status: 'done' })
  pump()
  assert.deepEqual(launched, [b.id])
})

test('pump(): task được chờ Failed → task sau vẫn chờ; xoá task được chờ → liên kết mất, task sau chạy', () => {
  const a = mk('A', 'failed')
  const b = mk('B', 'queued')
  taskDeps.set(b.id, [a.id])
  pump()
  assert.deepEqual(launched, [])
  tasks.remove(a.id)
  assert.equal(tasks.get(b.id)!.dependsOn, undefined)
  pump()
  assert.deepEqual(launched, [b.id])
})

test('Chạy ngay khi còn chờ: 409 DEPS_PENDING; ignoreDeps gỡ phụ thuộc rồi chạy', async () => {
  const a = mk('A')
  const b = mk('B')
  taskDeps.set(b.id, [a.id])
  const r = await inject('POST', `/api/tasks/${b.id}/run`)
  assert.equal(r.statusCode, 409)
  assert.equal(r.json().code, 'DEPS_PENDING')
  assert.match(r.json().error, new RegExp(`#${a.id}`))
  assert.deepEqual(launched, [])

  const ok = await inject('POST', `/api/tasks/${b.id}/run`, { ignoreDeps: true })
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(launched, [b.id])
  assert.equal(tasks.get(b.id)!.dependsOn, undefined)
})

test('dep-suggest: gợi ý task được nhắc (#id / mã) cùng project, chưa Done, chưa có trong danh sách', async () => {
  const a = mk('[S-01] Phần nền')
  const done = mk('[S-02] Đã xong', 'done')
  const b = mk('[S-03] Đã chọn')
  mk('[S-01] Trùng mã khác project', 'backlog', 'p2')
  const res = await inject('POST', '/api/tasks/dep-suggest', {
    projectId: 'p1',
    title: 'Làm tiếp',
    prompt: `Sau S-01, S-02, S-03 và #${a.id}`,
    dependsOn: [b.id],
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(
    res.json().map((s: { id: number }) => s.id),
    [a.id],
  )
  assert.ok(!res.json().some((s: { id: number }) => s.id === done.id))
})

test('decideBlocked: requeue khi tìm được task chưa Done; fail khi không tìm thấy / đã Done / tạo vòng tròn', () => {
  const base = mk('[B-01] Nền')
  const self = mk('[B-02] Phụ thuộc', 'running')
  const d = decideBlocked(tasks.get(self.id)!, 'Không làm được.\nBLOCKED_BY: B-01; thiếu API')
  assert.equal(d?.action, 'requeue')
  assert.ok(d?.action === 'requeue' && d.deps.includes(base.id) && d.note.includes('thiếu API'))

  assert.equal(decideBlocked(tasks.get(self.id)!, 'Xong rồi'), null)
  const missing = decideBlocked(tasks.get(self.id)!, 'BLOCKED_BY: Z-99')
  assert.ok(missing?.action === 'fail' && /không tìm thấy/.test(missing.reason))

  const finished = mk('[B-03] Đã xong', 'done')
  const already = decideBlocked(tasks.get(self.id)!, `BLOCKED_BY: #${finished.id}`)
  assert.ok(already?.action === 'fail' && /đã Done/.test(already.reason))

  // base đang chờ self → self chờ base sẽ thành vòng tròn
  taskDeps.set(base.id, [self.id])
  const cyc = decideBlocked(tasks.get(self.id)!, 'BLOCKED_BY: B-01')
  assert.ok(cyc?.action === 'fail' && /vòng tròn/.test(cyc.reason))
  taskDeps.set(base.id, [])
})

test('handleBlocked: thêm phụ thuộc, task về Queued với session mới, ghi log; chưa có worktree thì không đụng repo', async () => {
  const base = mk('[H-01] Nền')
  const self = mk('[H-02] Sau', 'running')
  tasks.patch(self.id, { sessionId: 'old-session' })
  const runId = randomUUID()
  runs.create({ id: runId, taskId: self.id, kind: 'initial', startedAt: Date.now() })
  const d = decideBlocked(tasks.get(self.id)!, 'BLOCKED_BY: H-01; cần bảng mới')!
  await handleBlocked(self.id, runId, d)
  const t = tasks.get(self.id)!
  assert.equal(t.status, 'queued')
  assert.deepEqual(t.dependsOn, [base.id])
  assert.equal(t.sessionId, undefined)
  assert.ok(events.byRun(runId).some((e) => e.type === 'system' && /bị chặn bởi/.test(e.text)))
  // Còn chờ → pump không lấy ra
  pump()
  assert.ok(!launched.includes(self.id))

  // fail: task Failed kèm lý do
  const other = mk('[H-03] Khác', 'running')
  const r2 = randomUUID()
  runs.create({ id: r2, taskId: other.id, kind: 'initial', startedAt: Date.now() })
  await handleBlocked(other.id, r2, decideBlocked(tasks.get(other.id)!, 'BLOCKED_BY: Q-77')!)
  assert.equal(tasks.get(other.id)!.status, 'failed')
  assert.match(tasks.get(other.id)!.failReason!, /không tìm thấy/)
})

test('buildClaudeArgs: --append-system-prompt đứng trước --allowedTools', () => {
  const args = buildClaudeArgs({
    sessionId: 's',
    resume: false,
    permissionMode: 'acceptEdits',
    allowedTools: ['Read'],
    appendSystemPrompt: BLOCKED_BY_INSTRUCTION,
  })
  const i = args.indexOf('--append-system-prompt')
  assert.ok(i > 0)
  assert.equal(args[i + 1], BLOCKED_BY_INSTRUCTION)
  assert.ok(i < args.indexOf('--allowedTools'))
  assert.ok(!buildClaudeArgs({ sessionId: 's', resume: false, permissionMode: 'acceptEdits', allowedTools: [] }).includes('--append-system-prompt'))
})
