// M5 (SPEC-MULTI-AGENT): AntigravityAdapter qua ACP. Hàm thuần + chạy thật qua runner với `agy acp` giả
// (server/fixtures/antigravity/fake-acp.mjs): đủ mức quyền qua PermissionBroker, gửi lý do từ chối ở lượt nối tiếp,
// lưu session id, resume, mất phiên, hết quota, cấu hình strict riêng của Task Board.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'taskboard agy '))
process.env.TASKBOARD_DATA = root
process.env.TASKBOARD_DB = ':memory:'
const dir = join(root, 'proj g')
mkdirSync(dir)
const FAKE = join(import.meta.dirname, '..', '..', 'fixtures', 'antigravity', 'fake-acp.mjs')

const { events, projects, runs, settings, tasks } = await import('../db.ts')
const { decidePermission, initPermissions, listPermissions } = await import('../permissions.ts')
const { startRun } = await import('../runner.ts')
const { setAdapterForTest } = await import('./index.ts')
const { agyEnv, antigravityAdapter, ensureAgySettings, findAgyBin } = await import('./antigravity.ts')
const { toAction } = await import('./antigravityDriver.ts')
import type { PermissionMode, Task } from '../types.ts'

initPermissions()
settings.set({ ...settings.get(), maxParallel: 5 })
let scenario = 'ok'
setAdapterForTest('antigravity', {
  ...antigravityAdapter,
  findBin: () => ({ path: process.execPath, source: 'test' }),
  prepare: (o) => ({ ok: true, args: [FAKE], env: { ...agyEnv({ TASKBOARD_TASK_ID: String(o.task.id) }), FAKE_AGY: scenario }, cleanup: () => {} }),
})
after(() => setAdapterForTest('antigravity'))

function project(id: string, mode: PermissionMode, allowedTools: string[] = []) {
  projects.upsert({ id, name: id, repoPath: dir, mainBranch: 'main', permissionMode: mode, allowedTools, maxParallel: 5, budgetAction: 'warn', deliveryMode: 'direct', defaultAgent: 'antigravity' })
}
project('gm', 'manual')
project('ge', 'acceptEdits', ['Bash(npm install)'])
project('gp', 'plan')

const newTask = (projectId: string, mode: PermissionMode) =>
  tasks.create({ projectId, title: `g-${mode}`, prompt: 'Cài gói rồi tạo file hello.txt', status: 'queued', priority: 'normal', permissionMode: mode, tags: [] })
async function until<T>(fn: () => T | undefined, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Hết giờ chờ: ${what}`)
}
const pendingOf = (taskId: number, tool: string) =>
  until(() => listPermissions().find((p) => p.taskId === taskId && p.status === 'pending' && p.tool === tool), `yêu cầu ${tool} của #${taskId}`)
const settled = (id: number, statuses: Task['status'][], nRuns = 1) =>
  until(() => {
    const t = tasks.get(id)!
    return statuses.includes(t.status) && runs.byTask(id).length >= nRuns && runs.byTask(id).at(-1)?.endedAt ? t : undefined
  }, `task #${id} về ${statuses.join('/')}`)
const log = (runId: string) => events.byRun(runId).map((e) => JSON.stringify(e)).join('\n')

test('toAction: toolCall của agy → thao tác chuẩn', () => {
  assert.deepEqual(toAction({ kind: 'execute', title: 'x', rawInput: { CommandLine: 'npm test' } }), { kind: 'shell', command: 'npm test' })
  assert.deepEqual(toAction({ kind: 'edit', rawInput: { Path: 'C:/a/b.txt', Content: 'hi' } }), { kind: 'edit', path: 'C:/a/b.txt' })
  assert.deepEqual(toAction({ kind: 'read', rawInput: { AbsolutePath: '/x/y' } }), { kind: 'read', path: '/x/y' })
  assert.deepEqual(toAction({ kind: 'fetch', rawInput: { Url: 'https://a.dev' } }), { kind: 'web', url: 'https://a.dev' })
  assert.deepEqual(toAction({ kind: 'think', title: 'Nghĩ' }), { kind: 'other', tool: 'Nghĩ' })
})

test('findAgyBin / ensureAgySettings: tìm ~/.gemini/bin/agy, ghi toolPermission strict, giữ khoá khác', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-home '))
  const exe = process.platform === 'win32' ? 'agy.exe' : 'agy'
  mkdirSync(join(home, '.gemini', 'bin'), { recursive: true })
  writeFileSync(join(home, '.gemini', 'bin', exe), '')
  const bin = findAgyBin(true, home)
  assert.equal(bin?.source, 'gemini-bin')
  findAgyBin(true) // xoá cache trỏ vào home giả

  const file = ensureAgySettings(home)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { toolPermission: 'strict' })
  writeFileSync(file, JSON.stringify({ toolPermission: 'always-proceed', theme: 'dark' }))
  ensureAgySettings(home)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { toolPermission: 'strict', theme: 'dark' })
  assert.equal(existsSync(join(home, '.gemini', 'antigravity-cli', 'settings.json')), false, 'không đụng cấu hình của người dùng')
})

test('manual: lệnh và sửa file qua Needs Input; Allow cả hai → task Review, lưu session id, model, log', async () => {
  scenario = 'ok'
  const t = newTask('gm', 'manual')
  startRun(t, 'initial')
  const c = await pendingOf(t.id, 'Bash')
  assert.match(c.input, /npm install/)
  decidePermission(c.id, 'allow')
  const e = await pendingOf(t.id, 'Edit')
  assert.match(e.input, /hello\.txt/)
  decidePermission(e.id, 'allow')
  const done = await settled(t.id, ['review', 'failed'])
  assert.equal(done.status, 'review', done.failReason)
  const run = runs.byTask(t.id).at(-1)!
  assert.match(run.summary!, /^done \|/)
  assert.equal(run.agent, 'antigravity')
  assert.equal(run.sessionId, 'sess-1')
  assert.equal(tasks.get(t.id)!.sessionId, 'sess-1')
  assert.equal(run.model, 'gemini-fake')
  assert.equal(run.contextTokens, 4321)
  assert.match(log(run.id), /Antigravity xin quyền Bash\(npm install\)/)
  assert.match(log(run.id), /"tool_use","tool":"Bash","input":"npm install"/)
})

test('từ chối kèm lý do: agy kết thúc lượt, Task Board gửi lý do ở lượt nối tiếp', async () => {
  scenario = 'ok'
  const t = newTask('gm', 'manual')
  startRun(t, 'initial')
  const c = await pendingOf(t.id, 'Bash')
  decidePermission(c.id, 'deny', 'Không cài thêm gói')
  const done = await settled(t.id, ['review', 'failed'])
  assert.equal(done.status, 'review', done.failReason)
  const run = runs.byTask(t.id).at(-1)!
  assert.match(run.summary!, /^followup: Các thao tác sau đã bị từ chối/)
  assert.match(log(run.id), /Không cài thêm gói/)
})

test('acceptEdits + allowlist: không cần người duyệt; plan: tự từ chối, gửi lý do tối đa 2 lần rồi kết thúc', async () => {
  scenario = 'ok'
  const a = newTask('ge', 'acceptEdits')
  startRun(a, 'initial')
  const da = await settled(a.id, ['review', 'failed'])
  assert.equal(da.status, 'review', da.failReason)
  assert.match(runs.byTask(a.id).at(-1)!.summary!, /^done \|/)
  assert.equal(listPermissions().filter((p) => p.taskId === a.id).length, 0)

  const p = newTask('gp', 'plan')
  startRun(p, 'initial')
  const dp = await settled(p.id, ['review', 'failed'])
  assert.equal(dp.status, 'review', dp.failReason)
  assert.match(runs.byTask(p.id).at(-1)!.summary!, /^followup:/)
  assert.equal(listPermissions().filter((x) => x.taskId === p.id).length, 0)
})

test('resume đúng phiên; mất phiên → chạy lại trên phiên mới kèm yêu cầu gốc', async () => {
  scenario = 'ok'
  const t = newTask('ge', 'acceptEdits')
  startRun(t, 'initial')
  await settled(t.id, ['review'])
  startRun(tasks.get(t.id)!, 'resume', 'Sửa lại tên biến')
  await settled(t.id, ['review'], 2)
  assert.match(runs.byTask(t.id)[1].summary!, /Sửa lại tên biến$/)

  tasks.patch(t.id, { sessionId: 'sess-gone' })
  startRun(tasks.get(t.id)!, 'resume', 'Thêm test')
  await settled(t.id, ['review'], 4)
  const [, , lost, fresh] = runs.byTask(t.id)
  assert.equal(lost.failKind, 'infra')
  assert.match(log(lost.id), /Không tìm thấy phiên Antigravity cũ/)
  assert.equal(fresh.agent, 'antigravity')
  assert.equal(tasks.get(t.id)!.sessionId, 'sess-1')
})

test('hết quota (RESOURCE_EXHAUSTED): task quay lại hàng đợi chờ giờ reset', async () => {
  scenario = 'quota'
  const t = newTask('ge', 'acceptEdits')
  startRun(t, 'initial')
  const q = await until(() => (tasks.get(t.id)!.status === 'queued' && tasks.get(t.id)!.notBefore ? tasks.get(t.id) : undefined), 'chờ giờ reset')
  assert.ok(q!.notBefore! > Date.now())
  assert.equal(runs.byTask(t.id).at(-1)!.failKind, 'rate_limit')
  assert.match(log(runs.byTask(t.id).at(-1)!.id), /giới hạn sử dụng của gói Antigravity/)
})
