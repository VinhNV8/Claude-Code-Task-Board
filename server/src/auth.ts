// Truy cập từ xa an toàn (PLAN 4.7, NFR-04).
// - Mặc định chỉ lắng nghe 127.0.0.1, không cần đăng nhập.
// - Khi lắng nghe địa chỉ khác loopback (ví dụ IP Tailscale) thì bắt buộc đăng nhập bằng token:
//   POST /api/auth/login đặt cookie HttpOnly; mọi /api và /ws đều kiểm tra cookie (hoặc header Bearer).
// - Route nội bộ /api/internal/* và /api/hooks/* chỉ nhận kết nối trực tiếp từ localhost
//   (đã có token nội bộ riêng, không dùng cookie).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'

export class AuthConfigError extends Error {}

export const COOKIE_NAME = 'taskboard_session'
export const SESSION_DAYS = 30
export const MIN_TOKEN_LENGTH = 16

// ------------------------------------------------------------ cấu hình lắng nghe

export interface ListenConfig {
  /** Địa chỉ chính (Fastify listen) */
  host: string
  /** Địa chỉ phụ, ví dụ IP Tailscale */
  extraHosts: string[]
  /** Bắt buộc đăng nhập */
  authRequired: boolean
  /** Token đăng nhập (null khi không bật) */
  authToken: string | null
}

export function isLoopbackHost(h: string) {
  const x = h.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return x === 'localhost' || x === '::1' || /^127\.\d+\.\d+\.\d+$/.test(x) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(x)
}

/** Địa chỉ của socket client có phải localhost không (IPv4, IPv6, IPv4-mapped). */
export function isLoopbackAddress(addr: string | undefined) {
  return !!addr && addr !== 'localhost' && isLoopbackHost(addr)
}

const WILDCARD = new Set(['0.0.0.0', '::'])

/**
 * Đọc cấu hình từ biến môi trường:
 * - HOST (mặc định 127.0.0.1): địa chỉ chính.
 * - REMOTE_HOST: thêm địa chỉ cho truy cập từ xa, ví dụ `100.101.102.103` (IP Tailscale); nhiều địa chỉ cách nhau dấu phẩy.
 * - TASKBOARD_AUTH_TOKEN: token đăng nhập, ≥ 16 ký tự. Bắt buộc khi có địa chỉ không phải loopback.
 *   Đặt token khi chỉ chạy local cũng bật đăng nhập (tiện để thử).
 */
export function resolveListenConfig(env: Record<string, string | undefined>): ListenConfig {
  const host = (env.HOST ?? '').trim() || '127.0.0.1'
  const extra = (env.REMOTE_HOST ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^\[|\]$/g, ''))
    .filter(Boolean)
  for (const h of [host, ...extra])
    if (h !== 'localhost' && !isIP(h.replace(/^\[|\]$/g, '')))
      throw new AuthConfigError(`Địa chỉ lắng nghe không hợp lệ: "${h}" (cần là địa chỉ IP, ví dụ IP Tailscale 100.x.y.z)`)

  // Địa chỉ phụ trùng địa chỉ chính hoặc đã nằm trong 0.0.0.0/:: thì bỏ.
  const extraHosts = WILDCARD.has(host) ? [] : [...new Set(extra)].filter((h) => h !== host)
  // Route nội bộ (MCP permission, hook) gọi về 127.0.0.1 nên luôn phải lắng nghe loopback.
  if (!isLoopbackHost(host) && !WILDCARD.has(host) && !extraHosts.includes('127.0.0.1')) extraHosts.unshift('127.0.0.1')

  const remote = [host, ...extraHosts].some((h) => !isLoopbackHost(h))
  const raw = (env.TASKBOARD_AUTH_TOKEN ?? '').trim()
  if (remote && !raw)
    throw new AuthConfigError(
      `Đang mở truy cập từ xa (${[host, ...extraHosts].filter((h) => !isLoopbackHost(h)).join(', ')}) nhưng chưa đặt TASKBOARD_AUTH_TOKEN. ` +
        'Bắt buộc có token đăng nhập khi mở ra mạng ngoài (NFR-04).',
    )
  if (raw && raw.length < MIN_TOKEN_LENGTH)
    throw new AuthConfigError(`TASKBOARD_AUTH_TOKEN quá ngắn: cần ít nhất ${MIN_TOKEN_LENGTH} ký tự`)
  return { host, extraHosts, authRequired: !!raw, authToken: raw || null }
}

// ------------------------------------------------------------ token & phiên

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function checkToken(input: unknown, token: string) {
  return typeof input === 'string' && safeEqual(input.trim(), token)
}

const sign = (token: string, exp: number) => createHmac('sha256', token).update(`taskboard-session:${exp}`).digest('base64url')

/** Giá trị cookie phiên: `<hết hạn ms>.<hmac>`. Đổi token thì mọi phiên cũ mất hiệu lực. */
export function createSession(token: string, now = Date.now(), days = SESSION_DAYS) {
  const exp = now + days * 86_400_000
  return { value: `${exp}.${sign(token, exp)}`, maxAge: days * 86_400 }
}

export function verifySession(value: string | undefined, token: string, now = Date.now()) {
  if (!value) return false
  const m = /^(\d{1,16})\.([A-Za-z0-9_-]+)$/.exec(value)
  if (!m) return false
  const exp = Number(m[1])
  return exp > now && safeEqual(m[2], sign(token, exp))
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (!k || k in out) continue
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim())
    } catch {
      out[k] = part.slice(i + 1).trim()
    }
  }
  return out
}

export function sessionCookie(value: string, maxAge: number, secure: boolean) {
  return [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`, ...(secure ? ['Secure'] : [])].join('; ')
}

// ------------------------------------------------------------ phân loại route

const pathOf = (url: string) => url.split('?')[0]

/** Route nội bộ: chỉ cho phép kết nối trực tiếp từ localhost. */
export const isInternalPath = (url: string) => /^\/api\/(internal|hooks)(\/|$)/.test(pathOf(url))

/** Route cần đăng nhập: toàn bộ /api (trừ /api/auth/*) và /ws. File tĩnh của giao diện thì không. */
export function needsAuth(url: string) {
  const p = pathOf(url)
  if (p === '/ws' || p.startsWith('/ws/')) return true
  if (p !== '/api' && !p.startsWith('/api/')) return false
  return !/^\/api\/auth\/(login|logout|status)$/.test(p) && !isInternalPath(p)
}

/** Request đi thẳng từ localhost, không qua reverse proxy (ví dụ `tailscale serve`). */
export function isDirectLocal(remoteAddress: string | undefined, headers: Record<string, unknown>) {
  if (!isLoopbackAddress(remoteAddress)) return false
  return !headers['x-forwarded-for'] && !headers['forwarded'] && !headers['x-real-ip']
}

// ------------------------------------------------------------ chống dò token

export function createLoginLimiter(max = 10, windowMs = 15 * 60_000) {
  const fails = new Map<string, number[]>()
  const recent = (key: string, now: number) => (fails.get(key) ?? []).filter((t) => now - t < windowMs)
  return {
    /** Số ms phải chờ nếu đang bị khoá, 0 nếu được thử. */
    blockedFor(key: string, now = Date.now()) {
      const list = recent(key, now)
      return list.length >= max ? windowMs - (now - list[0]) : 0
    },
    fail(key: string, now = Date.now()) {
      const list = recent(key, now)
      list.push(now)
      fails.set(key, list)
    },
    reset(key: string) {
      fails.delete(key)
    },
  }
}

// ------------------------------------------------------------ plugin Fastify

function reject(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).header('cache-control', 'no-store').send({ error })
}

export function registerAuth(app: FastifyInstance, cfg: Pick<ListenConfig, 'authRequired' | 'authToken'>) {
  const token = cfg.authToken
  const limiter = createLoginLimiter()

  const authenticated = (req: FastifyRequest) => {
    if (!cfg.authRequired || !token) return true
    if (verifySession(parseCookies(req.headers.cookie)[COOKIE_NAME], token)) return true
    const h = req.headers.authorization
    return typeof h === 'string' && h.startsWith('Bearer ') && checkToken(h.slice(7), token)
  }

  const isSecure = (req: FastifyRequest) =>
    req.protocol === 'https' || (isLoopbackAddress(req.raw.socket.remoteAddress) && req.headers['x-forwarded-proto'] === 'https')

  app.addHook('onRequest', async (req, reply) => {
    if (isInternalPath(req.url)) {
      if (!isDirectLocal(req.raw.socket.remoteAddress, req.headers)) return reject(reply, 403, 'Route nội bộ chỉ chấp nhận kết nối từ localhost')
      return
    }
    if (needsAuth(req.url) && !authenticated(req)) return reject(reply, 401, 'Chưa đăng nhập hoặc phiên đã hết hạn')
  })

  app.get('/api/auth/status', async (req, reply) => {
    reply.header('cache-control', 'no-store')
    return { required: cfg.authRequired, authenticated: authenticated(req) }
  })

  app.post<{ Body: { token?: unknown } }>('/api/auth/login', async (req, reply) => {
    if (!cfg.authRequired || !token) return { ok: true }
    const key = req.ip
    const wait = limiter.blockedFor(key)
    if (wait > 0) return reject(reply, 429, `Nhập sai quá nhiều lần. Thử lại sau ${Math.ceil(wait / 60_000)} phút.`)
    if (!checkToken(req.body?.token, token)) {
      limiter.fail(key)
      app.log.warn(`Đăng nhập thất bại từ ${key}`)
      return reject(reply, 401, 'Token không đúng')
    }
    limiter.reset(key)
    const s = createSession(token)
    reply.header('set-cookie', sessionCookie(s.value, s.maxAge, isSecure(req)))
    return { ok: true }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    reply.header('set-cookie', sessionCookie('', 0, isSecure(req)))
    return { ok: true }
  })
}
