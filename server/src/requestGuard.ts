// Chặn trang web lạ điều khiển server qua trình duyệt của người dùng.
// Server lắng nghe 127.0.0.1 và (mặc định) không cần đăng nhập, nên phải tự chặn hai kiểu tấn công từ trình duyệt:
// - DNS rebinding: trang evil.com trỏ tên miền của nó về 127.0.0.1 rồi đọc/ghi API như cùng origin.
//   → Chỉ nhận header Host là localhost/loopback hoặc địa chỉ đã cấu hình (khi chưa bật đăng nhập).
// - Request chéo trang (CSRF, cross-site WebSocket hijacking): trang lạ gửi POST "simple request" hoặc mở /ws.
//   → Request ghi (khác GET/HEAD/OPTIONS) và kết nối WebSocket phải đến từ chính origin của server.
// Client không phải trình duyệt (curl, extension VS Code, script MCP/hook) không gửi Origin nên không bị ảnh hưởng.
import type { FastifyInstance } from 'fastify'
import { isLoopbackAddress, isLoopbackHost, type ListenConfig } from './auth.ts'

export interface GuardConfig {
  /** Đã bật đăng nhập bằng token: cookie/token đã chặn DNS rebinding, bỏ qua kiểm tra Host. */
  authRequired: boolean
  /** Tên host được nhận thêm ngoài loopback (địa chỉ lắng nghe, TASKBOARD_ALLOWED_HOSTS). Chữ thường, không có cổng. */
  allowedHosts: string[]
  /** Origin được phép gửi request ghi ngoài chính origin của server (TASKBOARD_ALLOWED_ORIGINS). */
  allowedOrigins: string[]
}

const WILDCARD = new Set(['0.0.0.0', '::'])
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

function normalizeOrigin(o: string) {
  try {
    return new URL(o).origin.toLowerCase()
  } catch {
    return undefined
  }
}

export function guardConfig(listen: Pick<ListenConfig, 'host' | 'extraHosts' | 'authRequired'>, env: NodeJS.ProcessEnv = process.env): GuardConfig {
  const hosts = [listen.host, ...listen.extraHosts, ...list(env.TASKBOARD_ALLOWED_HOSTS)]
    .map((h) => h.toLowerCase().replace(/^\[|\]$/g, ''))
    .filter((h) => !WILDCARD.has(h))
  return {
    authRequired: listen.authRequired,
    allowedHosts: [...new Set(hosts)],
    allowedOrigins: list(env.TASKBOARD_ALLOWED_ORIGINS)
      .map(normalizeOrigin)
      .filter((o): o is string => !!o),
  }
}

/** Tên host trong header Host (bỏ cổng, bỏ ngoặc IPv6), chữ thường. */
export function hostName(host: string | undefined) {
  const h = host?.trim().toLowerCase()
  if (!h) return undefined
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end > 0 ? h.slice(1, end) : undefined
  }
  const parts = h.split(':')
  return parts.length > 2 ? h : parts[0] // IPv6 không ngoặc: giữ nguyên
}

export function isAllowedHost(host: string | undefined, cfg: GuardConfig) {
  const name = hostName(host)
  if (!name) return false
  return isLoopbackHost(name) || cfg.allowedHosts.includes(name)
}

export interface OriginContext {
  origin: string | undefined
  host: string | undefined
  /** Header X-Forwarded-Host, chỉ tin khi request đến từ loopback (reverse proxy cùng máy như `tailscale serve`). */
  forwardedHost?: string
  fromLoopback: boolean
}

/** Origin của trình duyệt có phải chính server (hoặc được cấu hình cho phép) không. Không có Origin: không phải trình duyệt. */
export function isAllowedOrigin(c: OriginContext, cfg: GuardConfig) {
  if (c.origin === undefined) return true
  const o = normalizeOrigin(c.origin)
  if (!o || c.origin === 'null') return false
  if (cfg.allowedOrigins.includes(o)) return true
  const originHost = new URL(o).host
  if (c.host && originHost === c.host.trim().toLowerCase()) return true
  const fwd = c.forwardedHost?.split(',')[0]?.trim().toLowerCase()
  return c.fromLoopback && !!fwd && originHost === fwd
}

export interface GuardRequest extends OriginContext {
  method: string
  /** Yêu cầu nâng cấp WebSocket. */
  upgrade: boolean
}

/** Lý do từ chối, hoặc undefined nếu cho qua. */
export function checkRequest(r: GuardRequest, cfg: GuardConfig): string | undefined {
  if (!cfg.authRequired && !isAllowedHost(r.host, cfg))
    return `Không chấp nhận Host "${r.host ?? ''}". Chỉ truy cập qua localhost/127.0.0.1, hoặc thêm tên vào TASKBOARD_ALLOWED_HOSTS.`
  if ((r.upgrade || !SAFE_METHODS.has(r.method.toUpperCase())) && !isAllowedOrigin(r, cfg))
    return `Không chấp nhận request từ trang khác (${r.origin}). Thêm origin vào TASKBOARD_ALLOWED_ORIGINS nếu đây là trang của bạn.`
  return undefined
}

export function registerRequestGuard(app: FastifyInstance, cfg: GuardConfig) {
  app.addHook('onRequest', async (req, reply) => {
    const header = (name: string) => {
      const v = req.headers[name]
      return Array.isArray(v) ? v[0] : v
    }
    const reason = checkRequest(
      {
        method: req.method,
        upgrade: header('upgrade')?.toLowerCase() === 'websocket',
        origin: header('origin'),
        host: header('host'),
        forwardedHost: header('x-forwarded-host'),
        fromLoopback: isLoopbackAddress(req.raw.socket.remoteAddress),
      },
      cfg,
    )
    if (reason) {
      req.log.warn({ host: header('host'), origin: header('origin'), url: req.url }, 'request bị chặn')
      return reply.code(403).send({ error: reason })
    }
  })
}
