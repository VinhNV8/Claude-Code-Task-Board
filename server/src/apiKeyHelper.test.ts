// Chế độ API key: CLI lấy key qua apiKeyHelper thay vì biến môi trường (apiKeyBroker.ts, hooks/apikey.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard apikey '))
process.env.TASKBOARD_DB = ':memory:'
const { checkKeyToken, issueKeyToken, revokeKeyToken } = await import('./apiKeyBroker.ts')
const { buildHookSettings } = await import('./hookSettings.ts')
const helper = await import('./hooks/apikey.ts')
const { claudeEnv } = await import('./claude.ts')
const { routes } = await import('./routes.ts')
const { default: Fastify } = await import('fastify')

test('broker: token theo task, so khớp chính xác, huỷ thì hết hiệu lực', () => {
  const t1 = issueKeyToken(1)
  const t2 = issueKeyToken(2)
  assert.notEqual(t1, t2)
  assert.equal(checkKeyToken(1, t1), true)
  assert.equal(checkKeyToken(1, t2), false) // token của task khác
  assert.equal(checkKeyToken(1, t1.slice(0, -1)), false)
  assert.equal(checkKeyToken(1, undefined), false)
  const t1b = issueKeyToken(1) // cấp lại: token cũ hết hiệu lực
  assert.equal(checkKeyToken(1, t1), false)
  assert.equal(checkKeyToken(1, t1b), true)
  revokeKeyToken(1)
  assert.equal(checkKeyToken(1, t1b), false)
  assert.equal(checkKeyToken(3, 'x'), false)
})

test('settings của run: chỉ có apiKeyHelper ở chế độ API key; lệnh không chứa key', () => {
  const base = { taskId: 7, port: 3001, token: 'internal', nodePath: '/bin/node', tsxLoader: 'file:///tsx.mjs', platform: 'linux' as const }
  assert.equal('apiKeyHelper' in buildHookSettings(base), false)
  const s = buildHookSettings({ ...base, apiKeyToken: 'runtoken123' }) as { apiKeyHelper?: string }
  assert.ok(s.apiKeyHelper)
  assert.match(s.apiKeyHelper!, /hooks[\\/]apikey\.ts' '--port' '3001' '--task' '7' '--token' 'runtoken123'$/)
  assert.ok(!s.apiKeyHelper!.includes('internal'), 'không dùng token nội bộ của MCP/hook')
})

test('claudeEnv: không truyền key qua môi trường, kể cả key có sẵn trên máy', () => {
  const prev = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-ant-from-shell'
  try {
    const env = claudeEnv({ TASKBOARD_TASK_ID: '1' })
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    assert.equal(env.TASKBOARD_TASK_ID, '1')
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = prev
  }
})

test('script helper: đọc tham số, gọi backend với token, in key; lỗi thì ném', async () => {
  const c = helper.parseArgs(['--port', '4000', '--task', '9', '--token', 'tk'])
  assert.deepEqual(c, { port: 4000, taskId: '9', token: 'tk' })
  let seen: { url: string; token: string | null } | undefined
  const ok = (async (url: string, init?: RequestInit) => {
    seen = { url, token: new Headers(init?.headers).get('x-taskboard-key-token') }
    return new Response('sk-ant-api03-key\n', { status: 200 })
  }) as typeof fetch
  assert.equal(await helper.fetchKey(c, ok), 'sk-ant-api03-key')
  assert.deepEqual(seen, { url: 'http://127.0.0.1:4000/api/internal/api-key?task=9', token: 'tk' })

  const denied = (async () => new Response('{}', { status: 401 })) as typeof fetch
  await assert.rejects(helper.fetchKey(c, denied), /401/)
  await assert.rejects(helper.fetchKey(helper.parseArgs([]), ok), /Thiếu/)
})

test('route /api/internal/api-key: từ chối khi task không chạy, sai token hoặc thiếu token', async () => {
  const app = Fastify()
  await app.register(routes)
  try {
    const token = issueKeyToken(42)
    for (const headers of [{ 'x-taskboard-key-token': token }, { 'x-taskboard-key-token': 'sai' }, {}]) {
      const res = await app.inject({ url: '/api/internal/api-key?task=42', headers })
      assert.equal(res.statusCode, 401) // task 42 không chạy → không cấp
      assert.ok(!res.body.includes('sk-ant'))
    }
    assert.equal((await app.inject({ url: '/api/internal/api-key?task=abc' })).statusCode, 401)
  } finally {
    revokeKeyToken(42)
    await app.close()
  }
})
