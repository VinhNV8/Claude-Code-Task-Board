import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { findClaudeBin } from './claude.ts'
import { routes } from './routes.ts'
import { pump, recover, shutdown } from './runner.ts'
import { bus, type ServerMessage } from './bus.ts'
import { startScheduler, stopScheduler } from './scheduler.ts'
import { kv, projects, settings, tasks, telegramToken } from './db.ts'
import { createTelegramNotifier, sendTelegram, type FetchLike } from './telegram.ts'
import { activeConfig, createTelegramApprover, createTelegramPoller } from './telegramApprove.ts'
import { decidePermission, listPermissions } from './permissions.ts'
import { PORT, PROD } from './config.ts'
import { AuthConfigError, registerAuth, resolveListenConfig, type ListenConfig } from './auth.ts'
import { PREVIEW_MAX_BYTES, PREVIEW_PORT, createPreviewHandler, isPreviewOrigin } from './preview.ts'
import { readTaskBlob } from './reviewFiles.ts'

const ROOT = join(import.meta.dirname, '..', '..')

// NFR-04: mặc định chỉ lắng nghe 127.0.0.1; mở thêm địa chỉ (REMOTE_HOST) thì bắt buộc token đăng nhập.
let listen: ListenConfig
try {
  listen = resolveListenConfig(process.env)
} catch (e) {
  if (e instanceof AuthConfigError) {
    console.error(`✖ ${e.message}`)
    process.exit(1)
  }
  throw e
}

const app = Fastify({ logger: { level: PROD ? 'info' : 'warn' } })
await app.register(fastifyWebsocket)
registerAuth(app, listen)
// Trang HTML xem trước (cổng riêng, sandbox) không được gửi request ghi dữ liệu vào API chính
app.addHook('onRequest', async (req, reply) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && isPreviewOrigin(req.headers.origin)) {
    return reply.code(403).send({ error: 'Không chấp nhận request từ trang xem trước' })
  }
})
await app.register(routes)

// Production: phục vụ giao diện đã build trên cùng một port
const dist = join(ROOT, 'web', 'dist')
if (PROD && existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist })
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'),
  )
}

const bin = findClaudeBin()
console.log(bin ? `Claude CLI: ${bin.version ?? '?'} (${bin.source}) ${bin.path}` : '⚠ Không tìm thấy Claude CLI. Đặt biến CLAUDE_BIN.')

recover()

// FR-51: gửi Telegram khi task chuyển Review / Needs Input / Failed. Lỗi gửi chỉ ghi log.
bus.on(
  'message',
  createTelegramNotifier({
    initial: tasks.all(),
    getSettings: settings.get,
    getToken: telegramToken.get,
    projectName: (id) => projects.get(id)?.name,
    send: (cfg, text) => sendTelegram(cfg, text),
    log: (msg) => app.log.warn(msg),
    // Needs Input do xin quyền: tin kèm nút duyệt (P7-03) đã thay cho tin chung
    skip: (t) => t.status === 'needs_input' && listPermissions().some((p) => p.taskId === t.id && p.status === 'pending'),
  }),
)

// P7-03 (FR-46): duyệt quyền bằng nút inline trên Telegram, nhận phản hồi qua long polling getUpdates.
const realFetch = fetch as unknown as FetchLike
const approver = createTelegramApprover({
  fetchImpl: realFetch,
  getSettings: settings.get,
  getToken: telegramToken.get,
  getTask: (id) => tasks.get(id),
  projectName: (id) => projects.get(id)?.name,
  decide: (id, d) => decidePermission(id, d),
  now: Date.now,
  log: (msg) => app.log.warn(msg),
})
bus.on('message', approver.onMessage)
const poller = createTelegramPoller({
  fetchImpl: realFetch,
  getConfig: () => activeConfig(settings.get(), telegramToken.get()),
  getOffset: () => Number(kv.get('telegramOffset')) || 0,
  setOffset: (o) => kv.set('telegramOffset', String(o)),
  onCallback: approver.handleCallback,
  log: (msg) => app.log.warn(msg),
})
bus.on('message', (m: ServerMessage) => {
  if (m.type === 'settings') void poller.refresh()
})
poller.start()

await app.listen({ host: listen.host, port: PORT })

// Địa chỉ phụ (vd. 127.0.0.1 + IP Tailscale): server HTTP riêng, chuyển request và upgrade WS vào cùng app.
const extraServers = await Promise.all(
  listen.extraHosts.map(
    (host) =>
      new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
        const srv = createServer((req, res) => app.routing(req, res))
        srv.on('upgrade', (req, socket, head) => app.server.emit('upgrade', req, socket, head))
        srv.once('error', reject)
        srv.listen(PORT, host, () => resolve(srv))
      }),
  ),
)
const fmt = (h: string) => (h.includes(':') ? `[${h}]` : h)
for (const h of [listen.host, ...listen.extraHosts]) console.log(`Server: http://${fmt(h)}:${PORT}`)

// Xem trước trang HTML khi review: server riêng (origin khác) trên cùng các địa chỉ. Lỗi cổng chỉ tắt tính năng này.
const previewHandler = createPreviewHandler((taskId, path, side) => readTaskBlob(taskId, path, side, PREVIEW_MAX_BYTES))
const previewServers = (
  await Promise.all(
    [listen.host, ...listen.extraHosts].map(
      (host) =>
        new Promise<ReturnType<typeof createServer> | null>((resolve) => {
          const srv = createServer((req, res) => void previewHandler(req, res))
          srv.once('error', (e) => {
            console.warn(`⚠ Không mở được cổng xem trước ${fmt(host)}:${PREVIEW_PORT} (${(e as Error).message}). Đặt PREVIEW_PORT khác.`)
            resolve(null)
          })
          srv.listen(PREVIEW_PORT, host, () => resolve(srv))
        }),
    ),
  )
).filter((s): s is ReturnType<typeof createServer> => s !== null)
if (previewServers.length) console.log(`Xem trước HTML: cổng ${PREVIEW_PORT}`)
console.log(listen.authRequired ? '🔒 Bắt buộc đăng nhập bằng token (TASKBOARD_AUTH_TOKEN)' : 'Chỉ truy cập từ máy này, không cần đăng nhập')
pump()
// PLAN 4.6: lịch cron. Lỡ giờ khi server tắt thì chỉ tạo bù 1 task cho mỗi lịch.
startScheduler()

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, async () => {
    stopScheduler()
    await poller.stop()
    await shutdown()
    for (const s of [...extraServers, ...previewServers]) {
      s.closeAllConnections()
      s.close()
    }
    await app.close()
    process.exit(0)
  })
