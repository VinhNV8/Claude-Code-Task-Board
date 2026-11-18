// Chặn DNS rebinding và request chéo trang (requestGuard.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import { request } from 'node:http'
import { checkRequest, guardConfig, hostName, isAllowedHost, isAllowedOrigin, registerRequestGuard, type GuardRequest } from './requestGuard.ts'

const local = guardConfig({ host: '127.0.0.1', extraHosts: [], authRequired: false }, {})

const req = (r: Partial<GuardRequest>): GuardRequest => ({
  method: 'GET',
  upgrade: false,
  origin: undefined,
  host: '127.0.0.1:4000',
  fromLoopback: true,
  ...r,
})

test('hostName: bỏ cổng và ngoặc IPv6', () => {
  assert.equal(hostName('127.0.0.1:4000'), '127.0.0.1')
  assert.equal(hostName('LocalHost'), 'localhost')
  assert.equal(hostName('[::1]:4000'), '::1')
  assert.equal(hostName(''), undefined)
  assert.equal(hostName(undefined), undefined)
})

test('isAllowedHost: chỉ loopback và host đã cấu hình', () => {
  for (const h of ['127.0.0.1:4000', 'localhost:4000', '[::1]:4000', '127.0.0.5']) assert.equal(isAllowedHost(h, local), true, h)
  for (const h of ['evil.com', 'evil.com:4000', '127.0.0.1.evil.com', '192.168.1.5:4000', undefined]) assert.equal(isAllowedHost(h, local), false, String(h))

  const ts = guardConfig({ host: '127.0.0.1', extraHosts: ['100.64.1.2'], authRequired: false }, { TASKBOARD_ALLOWED_HOSTS: 'Box.tailnet.ts.net, ' })
  assert.equal(isAllowedHost('100.64.1.2:3000', ts), true)
  assert.equal(isAllowedHost('box.tailnet.ts.net', ts), true)
  // 0.0.0.0 không phải tên host hợp lệ để nhận
  assert.deepEqual(guardConfig({ host: '0.0.0.0', extraHosts: [], authRequired: true }, {}).allowedHosts, [])
})

test('isAllowedOrigin: cùng origin, origin cấu hình, hoặc proxy cùng máy', () => {
  const c = { host: '127.0.0.1:4000', fromLoopback: true }
  assert.equal(isAllowedOrigin({ ...c, origin: undefined }, local), true) // không phải trình duyệt
  assert.equal(isAllowedOrigin({ ...c, origin: 'http://127.0.0.1:4000' }, local), true)
  assert.equal(isAllowedOrigin({ ...c, origin: 'http://localhost:4000' }, local), false) // khác origin
  assert.equal(isAllowedOrigin({ ...c, origin: 'http://127.0.0.1:5173' }, local), false) // trang local khác cổng
  assert.equal(isAllowedOrigin({ ...c, origin: 'https://evil.com' }, local), false)
  assert.equal(isAllowedOrigin({ ...c, origin: 'null' }, local), false)
  assert.equal(isAllowedOrigin({ ...c, origin: 'not a url' }, local), false)

  // Reverse proxy cùng máy (tailscale serve) đổi Host nhưng giữ X-Forwarded-Host
  const proxied = { host: '127.0.0.1:3000', origin: 'https://box.tailnet.ts.net', forwardedHost: 'box.tailnet.ts.net' }
  assert.equal(isAllowedOrigin({ ...proxied, fromLoopback: true }, local), true)
  assert.equal(isAllowedOrigin({ ...proxied, fromLoopback: false }, local), false) // không tin header từ máy khác

  const extra = guardConfig({ host: '127.0.0.1', extraHosts: [], authRequired: false }, { TASKBOARD_ALLOWED_ORIGINS: 'https://Board.example.com/' })
  assert.equal(isAllowedOrigin({ ...c, origin: 'https://board.example.com' }, extra), true)
})

test('checkRequest: DNS rebinding bị chặn khi chưa bật đăng nhập; request ghi chéo trang luôn bị chặn', () => {
  assert.equal(checkRequest(req({}), local), undefined)
  assert.match(checkRequest(req({ host: 'rebind.evil.com:4000' }), local)!, /Host/)
  // Đã bật đăng nhập: cookie/token bảo vệ, chấp nhận mọi Host (vd. tên miền của tailscale serve)
  const auth = guardConfig({ host: '127.0.0.1', extraHosts: [], authRequired: true }, {})
  assert.equal(checkRequest(req({ host: 'box.tailnet.ts.net' }), auth), undefined)

  // GET chéo trang: trình duyệt không cho đọc (không có CORS) nên cho qua
  assert.equal(checkRequest(req({ origin: 'https://evil.com' }), local), undefined)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
    assert.match(checkRequest(req({ method, origin: 'https://evil.com' }), local)!, /trang khác/, method)
  assert.match(checkRequest(req({ upgrade: true, origin: 'https://evil.com' }), local)!, /trang khác/)
  assert.match(checkRequest(req({ method: 'POST', origin: 'https://evil.com' }), auth)!, /trang khác/)
  assert.equal(checkRequest(req({ method: 'POST', origin: 'http://127.0.0.1:4000' }), local), undefined)
  assert.equal(checkRequest(req({ method: 'POST' }), local), undefined) // curl, extension, script MCP
})

async function makeApp() {
  const app = Fastify()
  await app.register(fastifyWebsocket)
  registerRequestGuard(app, local)
  app.get('/api/x', async () => ({ ok: true }))
  app.post('/api/x', async () => ({ ok: true }))
  app.get('/ws', { websocket: true }, () => {})
  return app
}

test('server: chặn Host lạ và POST chéo trang bằng 403', async () => {
  const app = await makeApp()
  try {
    assert.equal((await app.inject({ url: '/api/x', headers: { host: '127.0.0.1:4000' } })).statusCode, 200)
    const rebind = await app.inject({ url: '/api/x', headers: { host: 'attacker.example:4000' } })
    assert.equal(rebind.statusCode, 403)
    assert.match(rebind.json().error, /Host/)
    const csrf = await app.inject({ method: 'POST', url: '/api/x', headers: { host: '127.0.0.1:4000', origin: 'https://attacker.example' } })
    assert.equal(csrf.statusCode, 403)
    const same = await app.inject({ method: 'POST', url: '/api/x', headers: { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000' } })
    assert.equal(same.statusCode, 200)
  } finally {
    await app.close()
  }
})

test('server: WebSocket từ trang khác bị từ chối, cùng origin thì kết nối được', async () => {
  const app = await makeApp()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as { port: number }).port
  // Gửi yêu cầu nâng cấp WebSocket thô: 101 là kết nối được, 403 là bị chặn
  const connect = (origin?: string) =>
    new Promise<number>((resolve, reject) => {
      const r = request({
        host: '127.0.0.1',
        port,
        path: '/ws',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          ...(origin ? { origin } : {}),
        },
      })
      r.once('upgrade', (res, socket) => (socket.destroy(), resolve(res.statusCode ?? 0)))
      r.once('response', (res) => (res.resume(), resolve(res.statusCode ?? 0)))
      r.once('error', reject)
      r.end()
    })
  try {
    assert.equal(await connect(`http://127.0.0.1:${port}`), 101)
    assert.equal(await connect(), 101)
    assert.equal(await connect('https://attacker.example'), 403)
  } finally {
    await app.close()
  }
})
