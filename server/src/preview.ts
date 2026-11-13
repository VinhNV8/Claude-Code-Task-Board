// Xem trước trang HTML tĩnh khi review (trường hợp A): server riêng trên cổng PREVIEW_PORT.
//
// An toàn: HTML do Claude viết có thể chạy JavaScript. Trang xem trước vì vậy
// - nằm trên origin khác Task Board (cổng khác) → không dùng chung cookie/localStorage, CORS chặn đọc API;
// - luôn có CSP `sandbox` (origin rỗng, không đọc cookie) + `form-action 'none'` + connect-src chỉ https/chính nó
//   → không gửi được request ghi dữ liệu tới API Task Board (http://127.0.0.1:<PORT>);
// - chỉ truy cập được bằng token ký HMAC, gắn với một task + một bên (Trước/Sau), hết hạn sau 30 phút.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PORT } from './config.ts'

export const PREVIEW_PORT = Number(process.env.PREVIEW_PORT ?? PORT + 10)
export const PREVIEW_TTL_MS = 30 * 60_000
/** Trang HTML và tài nguyên đi kèm tối đa 20 MB mỗi file. */
export const PREVIEW_MAX_BYTES = 20 * 1024 * 1024

export type PreviewSide = 'old' | 'new'

// Khoá ký đổi mỗi lần khởi động: link cũ hết hiệu lực sau khi restart (mở lại từ trang Review là có link mới)
const SECRET = randomBytes(32)

const sign = (payload: string, secret: Buffer) => createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 32)

/** Token dạng `<taskId>.<side>.<hết hạn, giây>.<chữ ký>`, dùng làm một đoạn trong URL. */
export function signPreviewToken(taskId: number, side: PreviewSide, now = Date.now(), secret: Buffer = SECRET): string {
  const payload = `${taskId}.${side}.${Math.floor((now + PREVIEW_TTL_MS) / 1000)}`
  return `${payload}.${sign(payload, secret)}`
}

export function verifyPreviewToken(token: string, now = Date.now(), secret: Buffer = SECRET): { taskId: number; side: PreviewSide } | null {
  const m = /^(\d+)\.(old|new)\.(\d+)\.([A-Za-z0-9_-]{32})$/.exec(token)
  if (!m) return null
  const expected = Buffer.from(sign(`${m[1]}.${m[2]}.${m[3]}`, secret))
  const got = Buffer.from(m[4])
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null
  if (Number(m[3]) * 1000 < now) return null
  return { taskId: Number(m[1]), side: m[2] as PreviewSide }
}

/**
 * `/p/<token>/<đường/dẫn>` → token + đường dẫn file trong repo. Thư mục (kết thúc `/` hoặc rỗng) → `index.html`.
 * Không tự chặn `..`: việc đó do `safeRepoPath`/`resolveInWorktree` lúc đọc file.
 */
export function parsePreviewUrl(url: string): { token: string; path: string } | null {
  const pathname = url.split(/[?#]/)[0]
  const m = /^\/p\/([^/]+)\/(.*)$/.exec(pathname)
  if (!m) return null
  let path: string
  try {
    path = m[2]
      .split('/')
      .map((s) => decodeURIComponent(s))
      .join('/')
  } catch {
    return null
  }
  if (path === '' || path.endsWith('/')) path += 'index.html'
  return { token: m[1], path }
}

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
}

export function previewMime(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path)
  return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream'
}

/**
 * CSP cho mọi response xem trước. `sandbox` không có allow-same-origin → origin rỗng (không cookie, không
 * localStorage, không đọc được gì của Task Board). Cho phép tài nguyên từ chính nó và https (CDN như Tailwind,
 * Google Fonts); chặn gửi form và chặn kết nối http khác (API Task Board chạy http://127.0.0.1).
 */
export function previewCsp(selfOrigin: string): string {
  const self = `'self' ${selfOrigin}`
  return [
    'sandbox allow-scripts allow-forms allow-modals allow-popups',
    `default-src ${self} https: data: blob:`,
    `script-src ${self} 'unsafe-inline' 'unsafe-eval' https: blob:`,
    `style-src ${self} 'unsafe-inline' https:`,
    `img-src ${self} https: data: blob:`,
    `font-src ${self} https: data:`,
    `media-src ${self} https: data: blob:`,
    `connect-src ${self} https:`,
    `frame-src ${self} https:`,
    "form-action 'none'",
    "base-uri 'self'",
  ].join('; ')
}

/**
 * Request ghi dữ liệu (POST/PUT/DELETE…) tới API chính mà đến từ trang xem trước (origin là cổng xem trước,
 * hoặc `null` của trang sandbox) thì chặn — lớp chặn thứ hai ngoài CSP.
 */
export function isPreviewOrigin(origin: string | undefined, previewPort = PREVIEW_PORT): boolean {
  if (!origin) return false
  if (origin === 'null') return true
  try {
    const u = new URL(origin)
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === previewPort
  } catch {
    return false
  }
}

type ReadFile = (taskId: number, path: string, side: PreviewSide) => Promise<Buffer>

const send = (res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
  res.end(body)
}

/** Handler HTTP cho server xem trước. `readFile` ném lỗi có `statusCode` (ReviewError) khi không đọc được. */
export function createPreviewHandler(readFile: ReadFile, now: () => number = Date.now) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Chỉ hỗ trợ GET', { allow: 'GET, HEAD' })
      const parsed = parsePreviewUrl(req.url ?? '')
      if (!parsed) return send(res, 404, 'Không tìm thấy')
      const access = verifyPreviewToken(parsed.token, now())
      if (!access) return send(res, 403, 'Link xem trước không hợp lệ hoặc đã hết hạn. Mở lại từ trang Review của task.')
      const data = await readFile(access.taskId, parsed.path, access.side)
      const host = /^[A-Za-z0-9.:[\]-]+$/.test(req.headers.host ?? '') ? req.headers.host! : `127.0.0.1:${PREVIEW_PORT}`
      const selfOrigin = `http://${host}`
      res.writeHead(200, {
        'content-type': previewMime(parsed.path),
        'content-length': String(data.length),
        'content-security-policy': previewCsp(selfOrigin),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      })
      res.end(req.method === 'HEAD' ? undefined : data)
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode
      if (status && status >= 400 && status < 500) return send(res, status, (e as Error).message)
      send(res, 500, 'Lỗi khi đọc file xem trước')
    }
  }
}
