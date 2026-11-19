// M3 (SPEC-MULTI-AGENT): CodexAdapter. Hàm thuần + chạy thật qua runner với `codex app-server` giả
// (server/fixtures/codex/fake-app-server.mjs, đúng giao thức P0-SPIKE): đủ 4 mức quyền qua PermissionBroker,
// lệnh bọc PowerShell được bóc ra cho allowlist, hỏi lại người dùng, hết hạn mức, lưu thread id, resume, mất phiên.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'taskboard codex '))
process.env.TASKBOARD_DATA = root
process.env.TASKBOARD_DB = ':memory:'
const dir = join(root, 'proj c')
mkdirSync(dir)
const FAKE = join(import.meta.dirname, '..', '..', 'fixtures', 'codex', 'fake-app-server.mjs')

const { events, projects, runs, settings, tasks } = await import('../db.ts')
const { answerQuestion, decidePermission, initPermissions, listPermissions } = await import('../permissions.ts')
const { startRun } = await import('../runner.ts')
const { setAdapterForTest } = await import('./index.ts')
const { codexAdapter, codexEnv, codexFromExtensions } = await import('./codex.ts')
const { codexPolicy, errorCode, pickModel, unwrapShell } = await import('./codexDriver.ts')
import type { PermissionMode, Task } from '../types.ts'

initPermissions()
settings.set({ ...settings.get(), maxParallel: 5 })
let scenario = 'ok'
setAdapterForTest('codex', {
  ...codexAdapter,
  findBin: () => ({ path: process.execPath, source: 'test' }),
  prepare: (o) => ({ ok: true, args: [FAKE], env: { ...codexEnv({ TASKBOARD_TASK_ID: String(o.task.id) }), FAKE_CODEX: scenario }, cleanup: () => {} }),
})
after(() => setAdapterForTest('codex'))

function project(id: string, mode: PermissionMode, allowedTools: string[] = []) {
  projects.upsert({ id, name: id, repoPath: dir, mainBranch: 'main', permissionMode: mode, allowedTools, maxParallel: 5, budgetAction: 'warn', deliveryMode: 'direct', defaultAgent: 'codex' })
}
project('cm', 'manual')
project('ce', 'acceptEdits', ['Bash(npm install)'])
project('cp', 'plan')

const newTask = (projectId: string, mode: PermissionMode, prompt = 'Cài gói rồi tạo file hello.txt') =>
  tasks.create({ projectId, title: `t-${mode}`, prompt, status: 'queued', priority: 'normal', permissionMode: mode, tags: [] })

async function until<T>(fn: () => T | undefined, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Hết giờ chờ: ${what}`)
}
const pendingOf = (taskId: number, tool?: string) =>
  until(() => listPermissions().find((p) => p.taskId === taskId && p.status === 'pending' && (!tool || p.tool === tool)), `yêu cầu duyệt ${tool ?? ''} của #${taskId}`)
const settled = (id: number, statuses: Task['status'][]) =>
  until(() => {
    const t = tasks.get(id)!
    return statuses.includes(t.status) && runs.byTask(id).at(-1)?.endedAt ? t : undefined
  }, `task #${id} về ${statuses.join('/')}`)
const texts = (runId: string) => events.byRun(runId).map((e) => JSON.stringify(e))

test('unwrapShell: bóc vỏ PowerShell / bash của Codex, giữ nguyên lệnh không bọc', () => {
  assert.equal(unwrapShell(`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'echo taskboard-gate-check'`), 'echo taskboard-gate-check')
  assert.equal(unwrapShell(`powershell.exe -NoProfile -Command "npm test -- --watch=false"`), 'npm test -- --watch=false')
  assert.equal(unwrapShell(`/bin/bash -lc 'git status && git log -1'`), 'git status && git log -1')
  assert.equal(unwrapShell('npm test'), 'npm test')
  assert.equal(unwrapShell(`cmd.exe /c dir`), 'dir')
})

test('codexPolicy / pickModel / errorCode', () => {
  assert.deepEqual(codexPolicy('plan'), { sandbox: 'read-only', approvalPolicy: 'untrusted' })
  for (const m of ['manual', 'acceptEdits', 'auto'] as const) assert.deepEqual(codexPolicy(m), { sandbox: 'workspace-write', approvalPolicy: 'untrusted' })
  const list = [{ id: 'a' }, { id: 'b', isDefault: true }]
  assert.deepEqual(pickModel(list, undefined), { model: 'b' })
  assert.deepEqual(pickModel(list, 'a'), { model: 'a' })
  assert.equal(pickModel(list, 'gpt-5.4').model, 'b')
  assert.match(pickModel(list, 'gpt-5.4').note!, /không có trong tài khoản Codex/)
  assert.deepEqual(pickModel([], undefined), { model: undefined })
  assert.equal(errorCode('usageLimitExceeded'), 'usageLimitExceeded')
  assert.equal(errorCode({ httpConnectionFailed: { httpStatusCode: 502 } }), 'httpConnectionFailed')
  assert.equal(errorCode(null), undefined)
})

test('codexFromExtensions: lấy bản extension openai.chatgpt mới nhất; codexEnv bỏ key của mọi nhà cung cấp', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home '))
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex'
  for (const [editor, ver] of [['.vscode', '26.1021.22027'], ['.vscode', '26.1111.21308'], ['.cursor', '26.1106.1']] as const) {
    const bin = join(home, editor, 'extensions', `openai.chatgpt-${ver}-win32-x64`, 'bin', 'windows-x86_64')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, exe), '')
  }
  assert.match(codexFromExtensions(home)!, /openai\.chatgpt-26\.1111\.21308/)
  assert.equal(codexFromExtensions(join(home, 'none')), undefined)

  process.env.OPENAI_API_KEY = 'sk-x'
  process.env.ANTHROPIC_API_KEY = 'sk-ant'
  const env = codexEnv({ A: '1' })
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.A, '1')
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
})

test('manual: lệnh và sửa file đi qua Needs Input; Allow lệnh, Deny file kèm lý do; lưu thread id, agent, log', async () => {
  scenario = 'ok'
  const t = newTask('cm', 'manual')
  startRun(t, 'initial')
  const cmd = await pendingOf(t.id, 'Bash')
  assert.match(cmd.input, /^npm install$/, 'lệnh đã bóc vỏ PowerShell')
  assert.equal(tasks.get(t.id)!.status, 'needs_input')
  decidePermission(cmd.id, 'allow')
  const file = await pendingOf(t.id, 'Write')
  assert.match(file.input, /hello\.txt/)
  decidePermission(file.id, 'deny', 'Không tạo file này')
  const done = await settled(t.id, ['review', 'failed'])
  assert.equal(done.status, 'review', done.failReason)
  const run = runs.byTask(t.id).at(-1)!
  assert.match(run.summary!, /^done: accept\/decline/)
  assert.equal(run.agent, 'codex')
  assert.equal(run.sessionId, 'th-1')
  assert.equal(tasks.get(t.id)!.sessionId, 'th-1')
  assert.equal(run.model, 'gpt-fake')
  assert.equal(run.contextTokens, 1234)
  const log = texts(run.id).join('\n')
  assert.match(log, /Codex xin quyền Bash\(npm install\)/)
  assert.match(log, /"tool_use","tool":"Bash","input":"npm install"/)
  assert.match(log, /Từ chối sửa file: hello\.txt \(.*Không tạo file này/)
})

test('acceptEdits + allowlist: không cần người duyệt (lệnh khớp allowlist, file trong thư mục task)', async () => {
  scenario = 'ok'
  const t = newTask('ce', 'acceptEdits')
  startRun(t, 'initial')
  const done = await settled(t.id, ['review', 'failed'])
  assert.equal(done.status, 'review', done.failReason)
  assert.match(runs.byTask(t.id).at(-1)!.summary!, /^done: accept\/accept/)
  assert.equal(listPermissions().filter((p) => p.taskId === t.id).length, 0)
})

test('plan: lệnh và sửa file bị từ chối tự động, không hỏi người', async () => {
  scenario = 'ok'
  const t = newTask('cp', 'plan')
  startRun(t, 'initial')
  const done = await settled(t.id, ['review', 'failed'])
  assert.equal(done.status, 'review', done.failReason)
  assert.match(runs.byTask(t.id).at(-1)!.summary!, /^done: decline\/decline/)
  assert.equal(listPermissions().filter((p) => p.taskId === t.id).length, 0)
})

test('hỏi lại người dùng (FR-40): câu hỏi của Codex hiện như AskUserQuestion, đáp án quay về Codex', async () => {
  scenario = 'question'
  const t = newTask('ce', 'acceptEdits')
  startRun(t, 'initial')
  const q = await pendingOf(t.id, 'AskUserQuestion')
  assert.equal(q.questions?.[0]?.question, 'Dùng database nào?')
  assert.deepEqual(q.questions?.[0]?.options.map((o) => o.label), ['SQLite', 'Postgres'])
  answerQuestion(q.id, { 'Dùng database nào?': 'Postgres' })
  const done = await settled(t.id, ['review', 'failed'])
  assert.equal(done.status, 'review', done.failReason)
  assert.equal(runs.byTask(t.id).at(-1)!.summary, 'Chọn: Postgres')
})

test('hết hạn mức (usageLimitExceeded): task tự quay lại hàng đợi, chờ tới giờ reset', async () => {
  scenario = 'ratelimit'
  const t = newTask('ce', 'acceptEdits')
  startRun(t, 'initial')
  const q = await until(() => {
    const x = tasks.get(t.id)!
    return x.status === 'queued' && x.notBefore ? x : undefined
  }, 'task quay lại hàng đợi')
  assert.ok(q.notBefore! >= Date.now() + 2 * 3600_000 - 60_000, `notBefore ${q.notBefore} phải sau giờ reset (≈ 2 giờ nữa)`)
  assert.equal(runs.byTask(t.id).at(-1)!.failKind, 'rate_limit')
  assert.match(texts(runs.byTask(t.id).at(-1)!.id).join('\n'), /giới hạn sử dụng của gói Codex/)
  tasks.patch(t.id, { status: 'failed', notBefore: null })
})

test('resume: Request changes chạy tiếp đúng thread; mất thread → tự chạy lại trên phiên mới kèm yêu cầu gốc', async () => {
  scenario = 'ok'
  const t = newTask('ce', 'acceptEdits')
  startRun(t, 'initial')
  await settled(t.id, ['review'])
  startRun(tasks.get(t.id)!, 'resume', 'Sửa lại tên biến')
  await until(() => (runs.byTask(t.id).length === 2 && tasks.get(t.id)!.status === 'review' && runs.byTask(t.id)[1].endedAt ? true : undefined), 'run resume xong')
  const r2 = runs.byTask(t.id)[1]
  assert.equal(r2.kind, 'resume')
  assert.match(r2.summary!, /\| Sửa lại tên biến/, 'resume đúng phiên: chỉ gửi feedback')

  // Thread không còn: driver báo mất phiên → runner chạy lại trên phiên mới (prompt gốc + feedback)
  tasks.patch(t.id, { sessionId: 'th-gone' })
  startRun(tasks.get(t.id)!, 'resume', 'Thêm test')
  await until(() => (runs.byTask(t.id).length === 4 && runs.byTask(t.id)[3].endedAt && tasks.get(t.id)!.status === 'review' ? true : undefined), 'chạy lại sau khi mất phiên')
  const [, , lost, fresh] = runs.byTask(t.id)
  assert.equal(lost.failKind, 'infra')
  assert.match(texts(lost.id).join('\n'), /Không tìm thấy phiên Codex cũ/)
  assert.match(fresh.summary!, /\| Cài gói rồi tạo file hello\.txt/, 'phiên mới gửi kèm prompt gốc')
  assert.equal(tasks.get(t.id)!.sessionId, 'th-1')
})

test('watchdog (P0-SPIKE CD3): sửa file đã duyệt mà treo → ngắt lượt, chạy tiếp một lần trong cùng thread', async () => {
  scenario = 'stall'
  process.env.TASKBOARD_CODEX_WATCHDOG_MS = '300'
  try {
    const t = newTask('ce', 'acceptEdits')
    startRun(t, 'initial')
    const done = await settled(t.id, ['review', 'failed'])
    assert.equal(done.status, 'review', done.failReason)
    const run = runs.byTask(t.id).at(-1)!
    assert.match(run.summary!, /^recovered: Lần sửa file vừa rồi bị treo/)
    assert.match(texts(run.id).join('\n'), /Codex sửa file quá 0 giây chưa xong/)
    assert.equal(runs.byTask(t.id).length, 1, 'chạy tiếp trong cùng run, không tạo run mới')
  } finally {
    delete process.env.TASKBOARD_CODEX_WATCHDOG_MS
  }
})
