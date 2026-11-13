// Kiểm tra tích hợp: khởi động server đã bundle (dist/), dùng chung giữa các "cửa sổ", khởi động lại khi đổi phiên bản.
// Cần build trước (npm run build); chưa có dist thì bỏ qua.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ServerManager } from './serverManager.ts'

// npm test chạy trong thư mục vscode-extension
const extDir = resolve(process.cwd())
const built = existsSync(join(extDir, 'dist', 'server', 'index.mjs'))

test('ServerManager: khởi động, dùng chung, đổi phiên bản thì khởi động lại, dừng', { skip: !built && 'chưa build dist/' }, async () => {
  const storageDir = mkdtempSync(join(tmpdir(), 'tb-ext-'))
  const mk = (version: string) =>
    new ServerManager({ storageDir, extensionDir: extDir, version, idleMinutes: () => 0, claudePath: () => undefined, log: () => {} })
  const a = mk('1.0.0')
  try {
    // Hai lời gọi đồng thời chỉ khởi động một server
    const [i1, i2] = await Promise.all([a.ensure(), a.ensure()])
    assert.equal(i1.pid, i2.pid)
    const h = await a.health(i1)
    assert.equal(h?.ok, true)
    assert.equal(h?.version, '1.0.0')

    // "Cửa sổ" khác cùng phiên bản: dùng lại server đang chạy
    const b = mk('1.0.0')
    assert.equal((await b.ensure()).pid, i1.pid)

    // Giao diện web được phục vụ trên cùng cổng
    const html = await (await fetch(`http://127.0.0.1:${i1.port}/`)).text()
    assert.match(html, /<div id="root">/)

    // Cập nhật extension: server cũ bị thay
    const c = mk('1.0.1')
    const i3 = await c.ensure()
    assert.notEqual(i3.pid, i1.pid)
    assert.equal(await a.health(i1, 500), undefined)
    assert.equal((await c.health(i3))?.version, '1.0.1')

    await c.stop()
    assert.equal(await c.health(i3, 500), undefined)
    assert.equal(c.readInfo(), undefined)
  } finally {
    await mk('x').stop()
    rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
