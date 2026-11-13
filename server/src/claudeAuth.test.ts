// Chế độ xác thực Claude (subscription / API key): mã hoá key, gộp cài đặt, môi trường tiến trình con,
// kiểm tra key, và budget là giới hạn cứng ở chế độ API key. DB in-memory, không gọi mạng, không spawn Claude.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'

process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard auth '))
process.env.TASKBOARD_DB = ':memory:'
delete process.env.TASKBOARD_ANTHROPIC_API_KEY
delete process.env.TASKBOARD_SECRET_KEY
const { claudeApiKey, db, projects, runs, settings, tasks } = await import('./db.ts')
const { pump, setLauncherForTest } = await import('./runner.ts')
const svc = await import('./budgetService.ts')
const { runCap } = await import('./budget.ts')
const { claudeEnv } = await import('./claude.ts')
const { SecretBoxError, decryptSecret, encryptSecret, loadOrCreateKey, parseKey } = await import('./secretBox.ts')
const auth = await import('./claudeAuth.ts')
const { routes } = await import('./routes.ts')
const { default: Fastify } = await import('fastify')
import type { Project, Settings, Task } from './types.ts'
import type { MakeClient } from './claudeAuth.ts'

const KEY = `sk-ant-api03-${'a'.repeat(40)}WXYZ`
const KEY2 = `sk-ant-api03-${'b'.repeat(40)}LAST`

const launched: number[] = []
setLauncherForTest((t) => {
  launched.push(t.id)
  tasks.patch(t.id, { status: 'running' })
})
const app = Fastify()
await app.register(routes)
after(async () => {
  setLauncherForTest()
  await app.close()
})

// ---------------------------------------------------------------- secretBox

test('secretBox: mã hoá rồi giải mã đúng; mỗi lần mã hoá ra chuỗi khác; sai khoá hoặc sửa dữ liệu thì báo lỗi', () => {
  const k = randomBytes(32)
  const a = encryptSecret(KEY, k)
  const b = encryptSecret(KEY, k)
  assert.notEqual(a, b)
  assert.ok(!a.includes(KEY))
  assert.equal(decryptSecret(a, k), KEY)
  assert.throws(() => decryptSecret(a, randomBytes(32)), SecretBoxError)
  const parts = a.split(':')
  parts[3] = Buffer.from('xxxx').toString('base64')
  assert.throws(() => decryptSecret(parts.join(':'), k), SecretBoxError)
  assert.throws(() => decryptSecret('rác', k), SecretBoxError)
})

test('secretBox: khoá từ hex/base64, sai độ dài thì báo lỗi; tự tạo file khoá lần đầu và đọc lại đúng khoá đó', () => {
  const k = randomBytes(32)
  assert.deepEqual(parseKey(k.toString('hex')), k)
  assert.deepEqual(parseKey(k.toString('base64')), k)
  assert.throws(() => parseKey('abcd'), SecretBoxError)
  const dir = mkdtempSync(join(tmpdir(), 'taskboard key '))
  const first = loadOrCreateKey(dir, {})
  assert.equal(readFileSync(join(dir, 'secret.key'), 'utf8'), first.toString('hex'))
  assert.deepEqual(loadOrCreateKey(dir, {}), first)
  assert.deepEqual(loadOrCreateKey(dir, { TASKBOARD_SECRET_KEY: k.toString('hex') }), k)
})

// ---------------------------------------------------------------- hàm thuần

test('validateApiKey / mergeAuth: kiểm tra định dạng, giữ nguyên / xoá / đặt key mới, chế độ lạ bị từ chối', () => {
  assert.equal(auth.validateApiKey(`  ${KEY} `), KEY)
  assert.throws(() => auth.validateApiKey('abc'), auth.ClaudeAuthError)
  assert.throws(() => auth.validateApiKey(123), auth.ClaudeAuthError)
  assert.deepEqual(auth.mergeAuth('subscription', undefined), { mode: 'subscription', apiKey: undefined })
  assert.deepEqual(auth.mergeAuth('subscription', { mode: 'apiKey' }), { mode: 'apiKey', apiKey: undefined })
  assert.deepEqual(auth.mergeAuth('apiKey', { apiKey: null }), { mode: 'apiKey', apiKey: null })
  assert.deepEqual(auth.mergeAuth('apiKey', { apiKey: '  ' }), { mode: 'apiKey', apiKey: null })
  assert.deepEqual(auth.mergeAuth('apiKey', { apiKey: KEY }), { mode: 'apiKey', apiKey: KEY })
  assert.throws(() => auth.mergeAuth('apiKey', { mode: 'oauth' as never }), auth.ClaudeAuthError)
})

test('defaultAuthMode / effectiveApiKey / publicAuth / resolveCredentials', () => {
  assert.equal(auth.defaultAuthMode({}), 'subscription')
  assert.equal(auth.defaultAuthMode({ TASKBOARD_DEFAULT_AUTH_MODE: 'apiKey' }), 'apiKey')
  assert.equal(auth.effectiveApiKey(KEY, {}), KEY)
  assert.equal(auth.effectiveApiKey(KEY, { TASKBOARD_ANTHROPIC_API_KEY: KEY2 }), KEY2) // biến môi trường ưu tiên
  assert.equal(auth.effectiveApiKey(undefined, {}), undefined)
  const pub = auth.publicAuth('apiKey', KEY, {})
  assert.deepEqual(pub, { mode: 'apiKey', hasApiKey: true, envApiKey: false, apiKeyHint: 'WXYZ' })
  assert.ok(!JSON.stringify(pub).includes(KEY))
  assert.deepEqual(auth.publicAuth('apiKey', undefined, { TASKBOARD_ANTHROPIC_API_KEY: KEY2 }), {
    mode: 'apiKey',
    hasApiKey: false,
    envApiKey: true,
    apiKeyHint: 'LAST',
  })
  assert.deepEqual(auth.resolveCredentials('subscription', KEY), { ok: true }) // gói: không truyền key
  assert.deepEqual(auth.resolveCredentials('apiKey', KEY), { ok: true, apiKey: KEY })
  const miss = auth.resolveCredentials('apiKey', undefined)
  assert.equal(miss.ok, false)
})

test('authFailureHint: hết credit / key sai có gợi ý, lỗi khác thì không', () => {
  assert.match(auth.authFailureHint('Your credit balance is too low to access the Anthropic API')!, /hết credit/)
  assert.match(auth.authFailureHint('Invalid API key · Please run /login')!, /không hợp lệ/)
  assert.match(auth.authFailureHint('{"type":"authentication_error"}')!, /không hợp lệ/)
  assert.equal(auth.authFailureHint('Tests failed'), undefined)
  assert.equal(auth.authFailureHint(undefined), undefined)
})

test('claudeEnv: chế độ gói bỏ mọi key; chế độ API key chỉ truyền đúng key được chọn', () => {
  const saved = { ...process.env }
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-khac'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok'
    process.env.TASKBOARD_ANTHROPIC_API_KEY = KEY2
    const sub = claudeEnv({ X: '1' })
    assert.equal(sub.ANTHROPIC_API_KEY, undefined)
    assert.equal(sub.ANTHROPIC_AUTH_TOKEN, undefined)
    assert.equal(sub.TASKBOARD_ANTHROPIC_API_KEY, undefined)
    assert.equal(sub.X, '1')
    const api = claudeEnv({}, { apiKey: KEY })
    assert.equal(api.ANTHROPIC_API_KEY, KEY)
    assert.equal(api.ANTHROPIC_AUTH_TOKEN, undefined)
    assert.equal(api.TASKBOARD_ANTHROPIC_API_KEY, undefined)
  } finally {
    process.env = saved
  }
})

test('runCap: nhỏ nhất giữa giới hạn task và budget còn lại; hết budget → 0; không có gì → không giới hạn', () => {
  assert.equal(runCap(undefined, undefined), undefined)
  assert.equal(runCap(2, undefined), 2)
  assert.equal(runCap(0, undefined), undefined) // 0 ở task = không đặt
  assert.equal(runCap(undefined, { spent: 3, budget: 10 }), 7)
  assert.equal(runCap(2, { spent: 3, budget: 10 }), 2)
  assert.equal(runCap(5, { spent: 9.5, budget: 10 }), 0.5)
  assert.equal(runCap(5, { spent: 12, budget: 10 }), 0)
  assert.equal(runCap(5, { spent: 3, budget: undefined }), 5)
})

// ---------------------------------------------------------------- kiểm tra key (SDK giả)

const failing = (err: unknown): MakeClient => () => ({ models: { list: () => Promise.reject(err) } }) as never
const headers = new Headers()

test('testApiKey: thành công; lỗi được dịch sang tiếng Việt và không chứa key', async () => {
  let usedKey = ''
  await auth.testApiKey(KEY, (k) => {
    usedKey = k
    return { models: { list: () => Promise.resolve({}) } } as never
  })
  assert.equal(usedKey, KEY)
  const cases: [unknown, RegExp][] = [
    [new Anthropic.AuthenticationError(401, undefined, `bad key ${KEY}`, headers), /không hợp lệ/],
    [new Anthropic.PermissionDeniedError(403, undefined, 'nope', headers), /không có quyền/],
    [new Anthropic.APIConnectionError({ message: 'offline' }), /Không kết nối/],
    [new Anthropic.InternalServerError(500, undefined, 'boom', headers), /500/],
  ]
  for (const [err, re] of cases) {
    await assert.rejects(auth.testApiKey(KEY, failing(err)), (e: Error) => {
      assert.ok(e instanceof auth.ClaudeAuthError)
      assert.match(e.message, re)
      assert.ok(!e.message.includes(KEY))
      return true
    })
  }
  // Bị giới hạn tốc độ nghĩa là key hợp lệ
  await auth.testApiKey(KEY, failing(new Anthropic.RateLimitError(429, undefined, 'slow', headers)))
})

// ---------------------------------------------------------------- DB + API

test('API settings: lưu key mã hoá trong DB, không bao giờ trả key ra; xoá key; key sai định dạng bị từ chối', async () => {
  const put = (auth: unknown) => app.inject({ method: 'PUT', url: '/api/settings', payload: { auth } })
  let res = await put({ mode: 'apiKey', apiKey: KEY })
  assert.equal(res.statusCode, 200)
  assert.ok(!res.body.includes(KEY))
  const s = res.json() as Settings
  assert.deepEqual(s.auth, { mode: 'apiKey', hasApiKey: true, envApiKey: false, apiKeyHint: 'WXYZ' })

  const raw = (db.prepare("SELECT value FROM settings WHERE key = 'claude_api_key'").get() as { value: string }).value
  assert.ok(!raw.includes(KEY)) // lưu dạng mã hoá
  assert.equal(claudeApiKey.get(), KEY)
  const app_ = (db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string }).value
  assert.deepEqual(JSON.parse(app_).auth, { mode: 'apiKey' }) // chỉ lưu chế độ

  const state = await app.inject({ method: 'GET', url: '/api/state' })
  assert.ok(!state.body.includes(KEY))

  res = await put({ apiKey: 'sai' })
  assert.equal(res.statusCode, 400)
  assert.equal(claudeApiKey.get(), KEY) // giữ nguyên key cũ

  res = await put({ apiKey: null })
  assert.equal(res.statusCode, 200)
  assert.equal((res.json() as Settings).auth.hasApiKey, false)
  assert.equal(claudeApiKey.get(), undefined)

  res = await app.inject({ method: 'POST', url: '/api/settings/claude-auth/test', payload: {} })
  assert.equal(res.statusCode, 400) // chưa có key

  res = await put({ mode: 'subscription' })
  assert.equal((res.json() as Settings).auth.mode, 'subscription')
})

// ---------------------------------------------------------------- budget cứng ở chế độ API key

function mkProject(id: string, p: Partial<Project>) {
  return projects.upsert({
    id,
    name: id.toUpperCase(),
    repoPath: process.env.TASKBOARD_DATA!,
    mainBranch: 'main',
    permissionMode: 'acceptEdits',
    allowedTools: [],
    maxParallel: 5,
    budgetAction: 'warn', deliveryMode: 'worktree',
    ...p,
  })
}
const mkTask = (projectId: string, status: Task['status'] = 'queued') =>
  tasks.create({ projectId, title: 't', prompt: 'làm gì đó', status, priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
function spend(projectId: string, costUsd: number) {
  const t = mkTask(projectId, 'done')
  const id = randomUUID()
  runs.create({ id, taskId: t.id, kind: 'initial', startedAt: Date.now() })
  runs.finish(id, { endedAt: Date.now(), exitCode: 0, costUsd })
}
const setMode = (mode: Settings['auth']['mode']) => settings.set({ ...settings.get(), maxParallel: 5, auth: { ...settings.get().auth, mode } })

test('Chế độ API key: project "chỉ cảnh báo" vượt budget cũng bị tạm dừng; chế độ gói vẫn chạy', () => {
  mkProject('hw', { budgetAction: 'warn', deliveryMode: 'worktree', monthlyBudgetUsd: 5 })
  spend('hw', 6)

  setMode('subscription')
  svc.refreshBudgets()
  assert.equal(svc.isProjectBlocked('hw'), false)

  setMode('apiKey')
  svc.refreshBudgets()
  assert.equal(svc.isProjectBlocked('hw'), true)
  const t = mkTask('hw')
  launched.length = 0
  pump()
  assert.ok(!launched.includes(t.id))
  assert.ok(svc.budgetWakeAt() !== undefined)

  setMode('subscription')
  svc.refreshBudgets()
  pump()
  assert.ok(launched.includes(t.id))
})

test('runBudgetCap: chế độ API key cộng budget còn lại vào trần của run; chế độ gói chỉ dùng giới hạn của task', () => {
  mkProject('cap', { budgetAction: 'pause', monthlyBudgetUsd: 10 })
  spend('cap', 7)
  setMode('subscription')
  svc.refreshBudgets()
  assert.equal(svc.runBudgetCap('cap', undefined), undefined)
  assert.equal(svc.runBudgetCap('cap', 5), 5)
  setMode('apiKey')
  svc.refreshBudgets()
  assert.equal(svc.runBudgetCap('cap', undefined), 3)
  assert.equal(svc.runBudgetCap('cap', 1), 1)
  // Project không đặt budget: chỉ giới hạn theo task
  mkProject('free', {})
  svc.refreshBudgets()
  assert.equal(svc.runBudgetCap('free', undefined), undefined)
  setMode('subscription')
})
