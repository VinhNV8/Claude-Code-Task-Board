import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseArgs, sendNotification, toPayload } from './notification.ts'

const calls: { body: any; token?: string; url?: string }[] = []
let status = 200
const backend = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    calls.push({ body: JSON.parse(raw || '{}'), token: req.headers['x-taskboard-token'] as string | undefined, url: req.url })
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(status === 200 ? { ok: true } : { error: 'Token nội bộ không hợp lệ' }))
  })
})
await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r))
const port = (backend.address() as AddressInfo).port
after(() => backend.close())

test('parseArgs: đọc tham số dòng lệnh, task id dự phòng từ env', () => {
  assert.deepEqual(parseArgs(['--port', '4000', '--token', 't', '--task', '5'], {}), {
    taskId: '5',
    port: 4000,
    token: 't',
    timeoutMs: 5000,
  })
  const cfg = parseArgs([], { TASKBOARD_TASK_ID: '9' })
  assert.equal(cfg.taskId, '9')
  assert.equal(cfg.port, 3001)
  assert.equal(cfg.token, undefined)
})

test('toPayload: lấy message/title/notification_type từ JSON hook', () => {
  const raw = JSON.stringify({
    session_id: 'sess',
    hook_event_name: 'Notification',
    message: 'Claude needs your permission to use Bash',
    title: 'Permission needed',
    notification_type: 'permission_prompt',
  })
  assert.deepEqual(toPayload(raw, '3'), {
    taskId: '3',
    message: 'Claude needs your permission to use Bash',
    title: 'Permission needed',
    notificationType: 'permission_prompt',
    sessionId: 'sess',
  })
  assert.equal(toPayload('{}', '3'), undefined)
  assert.equal(toPayload('', '3'), undefined)
  assert.equal(toPayload('văn bản thường', '3')?.message, 'văn bản thường')
})

test('sendNotification: POST về /api/hooks/notification kèm token', async () => {
  calls.length = 0
  status = 200
  const err = await sendNotification({ taskId: '3', message: 'hi' }, { taskId: '3', port, token: 'tok', timeoutMs: 2000 })
  assert.equal(err, undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/hooks/notification')
  assert.equal(calls[0].token, 'tok')
  assert.deepEqual(calls[0].body, { taskId: '3', message: 'hi' })
})

test('sendNotification: lỗi HTTP hoặc mất kết nối không throw', async () => {
  status = 401
  const e1 = await sendNotification({ taskId: '3', message: 'hi' }, { taskId: '3', port, token: 'sai', timeoutMs: 2000 })
  assert.match(e1 ?? '', /HTTP 401/)
  const failing = (async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof fetch
  const e2 = await sendNotification({ taskId: '3', message: 'hi' }, { taskId: '3', port, token: 't', timeoutMs: 2000 }, failing)
  assert.match(e2 ?? '', /ECONNREFUSED/)
  status = 200
})
