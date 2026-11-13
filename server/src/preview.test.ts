// Test server xem trước trang HTML (preview.ts): token, URL, MIME, CSP, chặn origin, handler HTTP thật.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  PREVIEW_TTL_MS,
  createPreviewHandler,
  isPreviewOrigin,
  parsePreviewUrl,
  previewCsp,
  previewMime,
  signPreviewToken,
  verifyPreviewToken,
} from './preview.ts'

const NOW = 1_700_000_000_000
const KEY = Buffer.alloc(32, 7)

test('token: ký và xác thực, gắn task + bên, hết hạn sau TTL', () => {
  const tok = signPreviewToken(55, 'new', NOW, KEY)
  assert.match(tok, /^55\.new\.\d+\.[A-Za-z0-9_-]{32}$/)
  assert.deepEqual(verifyPreviewToken(tok, NOW, KEY), { taskId: 55, side: 'new' })
  assert.deepEqual(verifyPreviewToken(signPreviewToken(7, 'old', NOW, KEY), NOW, KEY), { taskId: 7, side: 'old' })
  assert.equal(verifyPreviewToken(tok, NOW + PREVIEW_TTL_MS + 1000, KEY), null, 'hết hạn')
})

test('token: sửa task/bên/hạn, sai khoá hoặc sai dạng đều bị từ chối', () => {
  const tok = signPreviewToken(55, 'new', NOW, KEY)
  const [id, side, exp, sig] = tok.split('.')
  assert.equal(verifyPreviewToken([56, side, exp, sig].join('.'), NOW, KEY), null)
  assert.equal(verifyPreviewToken([id, 'old', exp, sig].join('.'), NOW, KEY), null)
  assert.equal(verifyPreviewToken([id, side, String(Number(exp) + 9999), sig].join('.'), NOW, KEY), null)
  assert.equal(verifyPreviewToken(tok, NOW, Buffer.alloc(32, 8)), null)
  for (const bad of ['', 'abc', '55.new.1.short', '55.both.9999999999.' + 'a'.repeat(32)]) assert.equal(verifyPreviewToken(bad, NOW, KEY), null)
})

test('parsePreviewUrl: tách token/đường dẫn, giải mã, thư mục → index.html', () => {
  assert.deepEqual(parsePreviewUrl('/p/TOK/docs/prototypes/ui.html?x=1#a'), { token: 'TOK', path: 'docs/prototypes/ui.html' })
  assert.deepEqual(parsePreviewUrl('/p/TOK/trang%20m%E1%BB%9Bi.html'), { token: 'TOK', path: 'trang mới.html' })
  assert.deepEqual(parsePreviewUrl('/p/TOK/site/'), { token: 'TOK', path: 'site/index.html' })
  assert.deepEqual(parsePreviewUrl('/p/TOK/'), { token: 'TOK', path: 'index.html' })
  assert.equal(parsePreviewUrl('/x/TOK/a.html'), null)
  assert.equal(parsePreviewUrl('/p/TOK'), null)
  assert.equal(parsePreviewUrl('/p/TOK/%E0%A4%A.html'), null, 'mã hoá hỏng')
})

test('previewMime: theo đuôi, không rõ thì octet-stream (không đoán thành HTML)', () => {
  assert.equal(previewMime('a/index.HTML'), 'text/html; charset=utf-8')
  assert.equal(previewMime('app.js'), 'text/javascript; charset=utf-8')
  assert.equal(previewMime('font.woff2'), 'font/woff2')
  assert.equal(previewMime('README'), 'application/octet-stream')
  assert.equal(previewMime('x.exe'), 'application/octet-stream')
})

test('previewCsp: sandbox không có allow-same-origin, chặn form, không cho kết nối http khác', () => {
  const csp = previewCsp('http://127.0.0.1:3011')
  assert.match(csp, /^sandbox allow-scripts/)
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation/)
  assert.match(csp, /form-action 'none'/)
  const connect = csp.split('; ').find((d) => d.startsWith('connect-src'))!
  assert.equal(connect, "connect-src 'self' http://127.0.0.1:3011 https:")
})

test('isPreviewOrigin: cổng xem trước hoặc origin rỗng của sandbox', () => {
  assert.equal(isPreviewOrigin('http://127.0.0.1:3011', 3011), true)
  assert.equal(isPreviewOrigin('http://100.64.1.2:3011', 3011), true)
  assert.equal(isPreviewOrigin('null', 3011), true)
  assert.equal(isPreviewOrigin('http://127.0.0.1:3000', 3011), false)
  assert.equal(isPreviewOrigin(undefined, 3011), false)
  assert.equal(isPreviewOrigin('not a url', 3011), false)
})

test('handler: trả file kèm CSP; token sai 403; file thiếu 404; chỉ GET/HEAD', async () => {
  const reads: [number, string, string][] = []
  const handler = createPreviewHandler(async (taskId, path, side) => {
    reads.push([taskId, path, side])
    if (path === 'missing.html') throw Object.assign(new Error('Không tìm thấy file missing.html'), { statusCode: 404 })
    return Buffer.from(`<h1>${side}:${path}</h1>`)
  })
  const srv = createServer((req, res) => void handler(req, res))
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  try {
    const tok = signPreviewToken(9, 'old')
    const ok = await fetch(`${base}/p/${tok}/docs/a.html`)
    assert.equal(ok.status, 200)
    assert.equal(await ok.text(), '<h1>old:docs/a.html</h1>')
    assert.equal(ok.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.match(ok.headers.get('content-security-policy')!, /^sandbox /)
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(reads[0], [9, 'docs/a.html', 'old'])

    assert.equal((await fetch(`${base}/p/9.old.1.${'a'.repeat(32)}/docs/a.html`)).status, 403)
    assert.equal((await fetch(`${base}/p/${tok}/missing.html`)).status, 404)
    assert.equal((await fetch(`${base}/p/${tok}/a.html`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${base}/khac`)).status, 404)
    assert.equal(reads.length, 2, 'token sai thì không đọc file')
  } finally {
    srv.close()
  }
})
