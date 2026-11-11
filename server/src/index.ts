import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { findClaudeBin } from './claude.ts'
import { routes } from './routes.ts'
import { pump, recover, shutdown } from './runner.ts'

const PROD = process.env.NODE_ENV === 'production'
// NFR-04: chỉ lắng nghe localhost
const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? (PROD ? 3000 : 3001))
const ROOT = join(import.meta.dirname, '..', '..')

const app = Fastify({ logger: { level: PROD ? 'info' : 'warn' } })
await app.register(fastifyWebsocket)
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
await app.listen({ host: HOST, port: PORT })
console.log(`Server: http://${HOST}:${PORT}`)
pump()

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, async () => {
    await shutdown()
    await app.close()
    process.exit(0)
  })
