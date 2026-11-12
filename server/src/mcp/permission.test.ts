import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createPermissionServer, configFromEnv, type PermissionConfig } from './permission.ts'

type Handler = (body: any, req: IncomingMessage, res: ServerResponse) => void
let handler: Handler = (_b, _q, res) => res.end()
const calls: { body: any; token?: string }[] = []

const backend = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    calls.push({ body, token: req.headers['x-taskboard-token'] as string | undefined })
    handler(body, req, res)
  })
})
await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r))
const port = (backend.address() as AddressInfo).port
after(() => backend.close())

const json = (res: ServerResponse, data: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

function cfg(over: Partial<PermissionConfig> = {}): PermissionConfig {
  return { taskId: 't1', port, token: 'secret', timeoutMs: 5_000, requestTimeoutMs: 2_000, maxNetworkErrors: 2, retryDelayMs: 10, ...over }
}

async function callApprove(c: PermissionConfig, args: Record<string, unknown>) {
  const server = createPermissionServer(c)
  const client = new Client({ name: 'test', version: '0.0.0' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(st), client.connect(ct)])
  try {
    const res: any = await client.callTool({ name: 'approve', arguments: args })
    assert.equal(res.content[0].type, 'text')
    return JSON.parse(res.content[0].text)
  } finally {
    await client.close()
    await server.close()
  }
}

const bashArgs = { tool_name: 'Bash', input: { command: 'npm install' }, tool_use_id: 'tu_1' }

test('tools/list: server taskboard có tool approve', async () => {
  const server = createPermissionServer(cfg())
  const client = new Client({ name: 'test', version: '0.0.0' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(st), client.connect(ct)])
  assert.equal(client.getServerVersion()?.name, 'taskboard')
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map((t) => t.name), ['approve'])
  await client.close()
})

test('allow: gửi đúng payload + token, trả updatedInput mặc định là input gốc', async () => {
  calls.length = 0
  handler = (_b, _q, res) => json(res, { decision: 'allow' })
  const out = await callApprove(cfg(), bashArgs)
  assert.deepEqual(out, { behavior: 'allow', updatedInput: { command: 'npm install' } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].token, 'secret')
  assert.deepEqual(calls[0].body, { taskId: 't1', toolName: 'Bash', input: { command: 'npm install' }, toolUseId: 'tu_1' })
})

test('allow kèm updatedInput từ backend', async () => {
  handler = (_b, _q, res) => json(res, { decision: 'allow', updatedInput: { command: 'npm ci' } })
  const out = await callApprove(cfg(), bashArgs)
  assert.deepEqual(out, { behavior: 'allow', updatedInput: { command: 'npm ci' } })
})

test('deny: trả message của backend', async () => {
  handler = (_b, _q, res) => json(res, { decision: 'deny', message: 'Không cho cài package' })
  const out = await callApprove(cfg(), bashArgs)
  assert.deepEqual(out, { behavior: 'deny', message: 'Không cho cài package' })
})

test('long-poll: pending thì gọi lại kèm requestId đến khi có quyết định', async () => {
  calls.length = 0
  let n = 0
  handler = (_b, _q, res) => {
    n++
    if (n < 3) json(res, { status: 'pending', requestId: 'r9' })
    else json(res, { decision: 'allow' })
  }
  const out = await callApprove(cfg(), bashArgs)
  assert.equal(out.behavior, 'allow')
  assert.equal(calls.length, 3)
  assert.equal(calls[0].body.requestId, undefined)
  assert.equal(calls[1].body.requestId, 'r9')
  assert.equal(calls[2].body.requestId, 'r9')
})

test('backend giữ kết nối quá requestTimeout: gọi lại, không coi là mất kết nối', async () => {
  let n = 0
  handler = (_b, _q, res) => {
    n++
    if (n === 1) setTimeout(() => res.destroyed || json(res, { status: 'pending' }), 500)
    else json(res, { decision: 'allow' })
  }
  const out = await callApprove(cfg({ requestTimeoutMs: 100, maxNetworkErrors: 1 }), bashArgs)
  assert.equal(out.behavior, 'allow')
})

test('mất kết nối backend: deny kèm lý do, không treo', async () => {
  const t0 = Date.now()
  const out = await callApprove(cfg({ port: 1 }), bashArgs)
  assert.equal(out.behavior, 'deny')
  assert.match(out.message, /Mất kết nối tới backend/)
  assert.ok(Date.now() - t0 < 4_000)
})

test('backend lỗi 5xx liên tục: deny sau maxNetworkErrors lần', async () => {
  calls.length = 0
  handler = (_b, _q, res) => json(res, { error: 'boom' }, 500)
  const out = await callApprove(cfg(), bashArgs)
  assert.equal(out.behavior, 'deny')
  assert.equal(calls.length, 2)
})

test('backend trả 401: deny ngay, không thử lại', async () => {
  calls.length = 0
  handler = (_b, _q, res) => json(res, { error: 'Sai token' }, 401)
  const out = await callApprove(cfg(), bashArgs)
  assert.equal(out.behavior, 'deny')
  assert.match(out.message, /HTTP 401/)
  assert.equal(calls.length, 1)
})

test('hết tổng thời gian chờ: deny', async () => {
  handler = (_b, _q, res) => setTimeout(() => res.destroyed || json(res, { status: 'pending' }), 50)
  const out = await callApprove(cfg({ timeoutMs: 300 }), bashArgs)
  assert.equal(out.behavior, 'deny')
  assert.match(out.message, /Hết thời gian/)
})

test('thiếu TASKBOARD_TASK_ID: deny, không gọi backend', async () => {
  calls.length = 0
  const out = await callApprove(cfg({ taskId: undefined }), bashArgs)
  assert.equal(out.behavior, 'deny')
  assert.equal(calls.length, 0)
})

test('configFromEnv đọc env và giá trị mặc định', () => {
  const c = configFromEnv({ TASKBOARD_TASK_ID: '42', TASKBOARD_PORT: '4000', TASKBOARD_TOKEN: 'x' })
  assert.equal(c.taskId, '42')
  assert.equal(c.port, 4000)
  assert.equal(c.token, 'x')
  assert.equal(c.timeoutMs, 30 * 60_000)
  assert.equal(configFromEnv({ TASKBOARD_PORT: 'abc' }).port, 3001)
})
