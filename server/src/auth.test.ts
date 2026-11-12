import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {
  AuthConfigError,
  COOKIE_NAME,
  createLoginLimiter,
  createSession,
  isDirectLocal,
  isInternalPath,
  isLoopbackAddress,
  needsAuth,
  parseCookies,
  registerAuth,
  resolveListenConfig,
  verifySession,
} from './auth.ts'

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345'

test('resolveListenConfig: mặc định chỉ 127.0.0.1, không cần đăng nhập', () => {
  assert.deepEqual(resolveListenConfig({}), { host: '127.0.0.1', extraHosts: [], authRequired: false, authToken: null })
})

test('resolveListenConfig: REMOTE_HOST bắt buộc token và luôn giữ 127.0.0.1', () => {
  assert.throws(() => resolveListenConfig({ REMOTE_HOST: '100.64.0.5' }), AuthConfigError)
  const c = resolveListenConfig({ REMOTE_HOST: '100.64.0.5', TASKBOARD_AUTH_TOKEN: TOKEN })
  assert.deepEqual(c, { host: '127.0.0.1', extraHosts: ['100.64.0.5'], authRequired: true, authToken: TOKEN })
})

test('resolveListenConfig: HOST không phải loopback cũng bắt buộc token, thêm 127.0.0.1 cho route nội bộ', () => {
  assert.throws(() => resolveListenConfig({ HOST: '0.0.0.0' }), /TASKBOARD_AUTH_TOKEN/)
  assert.deepEqual(resolveListenConfig({ HOST: '0.0.0.0', REMOTE_HOST: '100.64.0.5', TASKBOARD_AUTH_TOKEN: TOKEN }).extraHosts, [])
  assert.deepEqual(resolveListenConfig({ HOST: '100.64.0.5', TASKBOARD_AUTH_TOKEN: TOKEN }).extraHosts, ['127.0.0.1'])
})

test('resolveListenConfig: token ngắn hoặc địa chỉ sai bị từ chối', () => {
  assert.throws(() => resolveListenConfig({ REMOTE_HOST: '100.64.0.5', TASKBOARD_AUTH_TOKEN: 'short' }), /quá ngắn/)
  assert.throws(() => resolveListenConfig({ REMOTE_HOST: 'my-pc.tailnet', TASKBOARD_AUTH_TOKEN: TOKEN }), /không hợp lệ/)
  // Chỉ local nhưng có token: bật đăng nhập
  assert.equal(resolveListenConfig({ TASKBOARD_AUTH_TOKEN: TOKEN }).authRequired, true)
  // Nhiều địa chỉ, có IPv6, bỏ trùng
  assert.deepEqual(
    resolveListenConfig({ REMOTE_HOST: '100.64.0.5, [fd7a:115c::1],100.64.0.5', TASKBOARD_AUTH_TOKEN: TOKEN }).extraHosts,
    ['100.64.0.5', 'fd7a:115c::1'],
  )
})

test('session: hợp lệ, hết hạn, sai chữ ký, đổi token', () => {
  const now = 1_700_000_000_000
  const s = createSession(TOKEN, now, 1)
  assert.equal(verifySession(s.value, TOKEN, now + 1000), true)
  assert.equal(verifySession(s.value, TOKEN, now + 86_400_001), false)
  assert.equal(verifySession(s.value, TOKEN + 'x', now), false)
  assert.equal(verifySession(s.value.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), TOKEN, now), false)
  assert.equal(verifySession('9999999999999.', TOKEN, now), false)
  assert.equal(verifySession(undefined, TOKEN, now), false)
})

test('parseCookies', () => {
  assert.deepEqual(parseCookies('a=1; b = x%20y ;c'), { a: '1', b: 'x y' })
  assert.deepEqual(parseCookies(undefined), {})
})

test('phân loại route', () => {
  assert.equal(needsAuth('/api/state'), true)
  assert.equal(needsAuth('/api/health?x=1'), true)
  assert.equal(needsAuth('/ws'), true)
  assert.equal(needsAuth('/api/auth/login'), false)
  assert.equal(needsAuth('/api/auth/status'), false)
  assert.equal(needsAuth('/'), false)
  assert.equal(needsAuth('/assets/index.js'), false)
  assert.equal(needsAuth('/apix'), false)
  assert.equal(isInternalPath('/api/internal/permissions'), true)
  assert.equal(isInternalPath('/api/hooks/notification?a=1'), true)
  assert.equal(isInternalPath('/api/hooksx'), false)
})

test('isLoopbackAddress / isDirectLocal', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(a), true, a)
  for (const a of ['100.64.0.5', '::ffff:100.64.0.5', '', undefined]) assert.equal(isLoopbackAddress(a), false, String(a))
  assert.equal(isDirectLocal('127.0.0.1', {}), true)
  assert.equal(isDirectLocal('127.0.0.1', { 'x-forwarded-for': '100.64.0.9' }), false)
})

test('createLoginLimiter: khoá sau khi sai nhiều lần, hết khoá theo thời gian', () => {
  const l = createLoginLimiter(3, 1000)
  for (let i = 0; i < 3; i++) l.fail('ip', 100 + i)
  assert.ok(l.blockedFor('ip', 200) > 0)
  assert.equal(l.blockedFor('other', 200), 0)
  assert.equal(l.blockedFor('ip', 1200), 0)
  l.fail('ip', 1300)
  l.reset('ip')
  assert.equal(l.blockedFor('ip', 1300), 0)
})

async function makeApp(authRequired: boolean) {
  const app = Fastify()
  registerAuth(app, { authRequired, authToken: authRequired ? TOKEN : null })
  app.get('/api/state', async () => ({ ok: true }))
  app.post('/api/internal/permissions', async () => ({ ok: true }))
  app.post('/api/hooks/notification', async () => ({ ok: true }))
  app.get('/', async () => 'html')
  await app.ready()
  return app
}

test('registerAuth: tắt đăng nhập thì /api mở, route nội bộ vẫn chỉ localhost', async () => {
  const app = await makeApp(false)
  assert.equal((await app.inject({ url: '/api/state', remoteAddress: '100.64.0.9' })).statusCode, 200)
  assert.deepEqual((await app.inject({ url: '/api/auth/status' })).json(), { required: false, authenticated: true })
  assert.equal((await app.inject({ method: 'POST', url: '/api/internal/permissions', remoteAddress: '100.64.0.9' })).statusCode, 403)
  await app.close()
})

test('registerAuth: bắt buộc đăng nhập', async () => {
  const app = await makeApp(true)
  // Chưa đăng nhập: /api bị chặn (kể cả từ localhost), trang tĩnh thì không
  assert.equal((await app.inject({ url: '/api/state' })).statusCode, 401)
  assert.equal((await app.inject({ url: '/' })).statusCode, 200)
  assert.deepEqual((await app.inject({ url: '/api/auth/status' })).json(), { required: true, authenticated: false })

  // Sai token
  const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: 'nope' }, remoteAddress: '100.64.0.9' })
  assert.equal(bad.statusCode, 401)
  assert.equal(bad.headers['set-cookie'], undefined)

  // Đúng token: cookie HttpOnly, SameSite=Strict
  const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: TOKEN }, remoteAddress: '100.64.0.9' })
  assert.equal(ok.statusCode, 200)
  const setCookie = String(ok.headers['set-cookie'])
  assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=`))
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  const cookie = setCookie.split(';')[0]

  const authed = await app.inject({ url: '/api/state', headers: { cookie }, remoteAddress: '100.64.0.9' })
  assert.equal(authed.statusCode, 200)
  assert.deepEqual((await app.inject({ url: '/api/auth/status', headers: { cookie } })).json(), { required: true, authenticated: true })
  // Header Bearer cũng được chấp nhận
  assert.equal((await app.inject({ url: '/api/state', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode, 200)
  // Cookie giả mạo
  assert.equal((await app.inject({ url: '/api/state', headers: { cookie: `${COOKIE_NAME}=99999999999999.abc` } })).statusCode, 401)

  // Đăng xuất xoá cookie
  const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })
  assert.match(String(out.headers['set-cookie']), /Max-Age=0/)

  // Route nội bộ: không cần cookie nhưng chỉ từ localhost và không qua proxy
  assert.equal((await app.inject({ method: 'POST', url: '/api/hooks/notification' })).statusCode, 200)
  assert.equal((await app.inject({ method: 'POST', url: '/api/hooks/notification', remoteAddress: '100.64.0.9', headers: { cookie } })).statusCode, 403)
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/internal/permissions', headers: { 'x-forwarded-for': '100.64.0.9' } })).statusCode,
    403,
  )
  await app.close()
})

test('registerAuth: khoá đăng nhập sau 10 lần sai', async () => {
  const app = await makeApp(true)
  for (let i = 0; i < 10; i++) await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: 'x' }, remoteAddress: '100.64.0.7' })
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: TOKEN }, remoteAddress: '100.64.0.7' })
  assert.equal(r.statusCode, 429)
  await app.close()
})
