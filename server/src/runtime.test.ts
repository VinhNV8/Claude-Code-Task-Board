// Bản đóng gói trong extension VS Code: script phụ, node shim, tự tắt khi rảnh.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { bundleDir, isElectron, nodeEnv, scriptArgs, shimContent } from './runtime.ts'
import { createIdleTracker, idleExitMinutes } from './idle.ts'
import { buildMcpConfig } from './permissionTool.ts'
import { buildNotificationCommand } from './hookSettings.ts'

test('scriptArgs: bản dev chạy .ts qua tsx, bản đóng gói chạy thẳng .mjs', () => {
  const o = { tsScript: '/src/mcp/permission.ts', bundled: 'permission.mjs', tsxLoader: () => 'file:///tsx.mjs' }
  assert.deepEqual(scriptArgs({ ...o, env: {} }), ['--import', 'file:///tsx.mjs', '/src/mcp/permission.ts'])
  assert.deepEqual(scriptArgs({ ...o, env: { TASKBOARD_BUNDLE_DIR: '/ext/dist/server' } }), [join('/ext/dist/server', 'permission.mjs')])
  assert.equal(bundleDir({ TASKBOARD_BUNDLE_DIR: '' }), undefined)
})

test('nodeEnv / isElectron: chỉ Electron mới cần ELECTRON_RUN_AS_NODE', () => {
  const node = { node: '24.0.0' } as unknown as NodeJS.ProcessVersions
  const electron = { node: '24.0.0', electron: '43.0.0' } as unknown as NodeJS.ProcessVersions
  assert.equal(isElectron(node), false)
  assert.deepEqual(nodeEnv(node), {})
  assert.deepEqual(nodeEnv(electron), { ELECTRON_RUN_AS_NODE: '1' })
})

test('shimContent: bật chế độ Node rồi chuyển nguyên tham số', () => {
  const win = shimContent('C:\\Program Files\\Code\\Code.exe', 'win32')
  assert.match(win, /set ELECTRON_RUN_AS_NODE=1/)
  assert.match(win, /"C:\\Program Files\\Code\\Code.exe" %\*/)
  const sh = shimContent("/Apps/Visual Studio Code.app/it's/Code", 'darwin')
  assert.match(sh, /^#!\/bin\/sh\n/)
  assert.match(sh, /ELECTRON_RUN_AS_NODE=1 exec '\/Apps\/Visual Studio Code.app\/it'\\''s\/Code' "\$@"/)
})

test('MCP config + lệnh hook dùng script .mjs khi chạy bản đóng gói', () => {
  const prev = process.env.TASKBOARD_BUNDLE_DIR
  process.env.TASKBOARD_BUNDLE_DIR = join('/ext', 'dist', 'server')
  try {
    const cfg = buildMcpConfig({ taskId: 1, port: 3000, token: 't' })
    const srv = Object.values(cfg.mcpServers)[0]
    assert.deepEqual(srv.args, [join('/ext', 'dist', 'server', 'permission.mjs')])
    const cmd = buildNotificationCommand({ taskId: 1, port: 3000, token: 't', nodePath: '/bin/node', platform: 'linux' })
    assert.ok(cmd.startsWith(`'/bin/node' '${join('/ext', 'dist', 'server', 'notification.mjs')}' '--port'`), cmd)
    assert.ok(!cmd.includes('--import'))
  } finally {
    if (prev === undefined) delete process.env.TASKBOARD_BUNDLE_DIR
    else process.env.TASKBOARD_BUNDLE_DIR = prev
  }
})

test('idleExitMinutes: chỉ bật khi đặt số dương', () => {
  assert.equal(idleExitMinutes({}), undefined)
  assert.equal(idleExitMinutes({ TASKBOARD_IDLE_EXIT_MIN: '0' }), undefined)
  assert.equal(idleExitMinutes({ TASKBOARD_IDLE_EXIT_MIN: 'abc' }), undefined)
  assert.equal(idleExitMinutes({ TASKBOARD_IDLE_EXIT_MIN: '30' }), 30)
})

test('createIdleTracker: chỉ tắt khi rảnh liên tục đủ thời gian; có giao diện hoặc việc thì đếm lại', () => {
  let t = 0
  const tr = createIdleTracker(60_000, () => t)
  const idle = { clients: 0, busy: false }
  assert.equal(tr.tick(idle), false)
  t = 59_000
  assert.equal(tr.tick(idle), false)
  t = 59_500
  assert.equal(tr.tick({ clients: 1, busy: false }), false) // mở giao diện: đặt lại
  t = 100_000
  assert.equal(tr.tick(idle), false)
  t = 150_000
  assert.equal(tr.tick({ clients: 0, busy: true }), false) // có task chạy: đặt lại
  t = 160_000
  assert.equal(tr.tick(idle), false)
  t = 220_000
  assert.equal(tr.tick(idle), true)
})
