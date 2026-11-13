import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boardHash, freePort, parseAuthStatus, parseServerInfo, pickMainBranch, samePath, serverEnv, webviewHtml } from './core.ts'

test('parseServerInfo: chỉ nhận file hợp lệ', () => {
  const ok = { pid: 12, port: 4000, previewPort: 4001, version: '0.1.0', startedAt: 1 }
  assert.deepEqual(parseServerInfo(JSON.stringify(ok)), ok)
  assert.equal(parseServerInfo(undefined), undefined)
  assert.equal(parseServerInfo('{bad'), undefined)
  assert.equal(parseServerInfo(JSON.stringify({ ...ok, port: 70000 })), undefined)
  assert.equal(parseServerInfo(JSON.stringify({ ...ok, version: 1 })), undefined)
})

test('serverEnv: bỏ biến nội bộ VS Code/Electron và cấu hình cũ, đặt cấu hình server', () => {
  const env = serverEnv(
    {
      PATH: '/usr/bin',
      HOME: '/home/u',
      VSCODE_IPC_HOOK: 'x',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      PORT: '9999',
      TASKBOARD_AUTH_TOKEN: 'secret',
      CLAUDE_BIN: '/old/claude',
    },
    {
      port: 4000,
      previewPort: 4001,
      dataDir: '/data',
      webDist: '/ext/dist/web',
      bundleDir: '/ext/dist/server',
      version: '0.1.0',
      idleMinutes: 30,
      electron: true,
    },
  )
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/home/u')
  assert.equal(env.VSCODE_IPC_HOOK, undefined)
  assert.equal(env.ELECTRON_NO_ATTACH_CONSOLE, undefined)
  assert.equal(env.TASKBOARD_AUTH_TOKEN, undefined)
  assert.equal(env.CLAUDE_BIN, undefined)
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(env.PORT, '4000')
  assert.equal(env.PREVIEW_PORT, '4001')
  assert.equal(env.NODE_ENV, 'production')
  assert.equal(env.TASKBOARD_DATA, '/data')
  assert.equal(env.TASKBOARD_IDLE_EXIT_MIN, '30')

  const plain = serverEnv({}, {
    port: 1, previewPort: 2, dataDir: 'd', webDist: 'w', bundleDir: 'b', version: 'v', idleMinutes: 0, claudePath: ' /x/claude ', electron: false,
  })
  assert.equal(plain.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(plain.TASKBOARD_IDLE_EXIT_MIN, undefined)
  assert.equal(plain.CLAUDE_BIN, '/x/claude')
})

test('samePath: Windows không phân biệt hoa thường và dấu gạch', () => {
  assert.equal(samePath('C:/Work/Repo', 'c:\\work\\repo\\', 'win32'), true)
  assert.equal(samePath('/work/Repo', '/work/repo', 'linux'), false)
  assert.equal(samePath('/work/repo/', '/work/repo', 'linux'), true)
})

test('parseAuthStatus: đọc JSON của `claude auth status`', () => {
  assert.deepEqual(parseAuthStatus('{"loggedIn": true, "authMethod": "claude.ai"}'), { loggedIn: true, authMethod: 'claude.ai' })
  assert.deepEqual(parseAuthStatus('warning\n{"loggedIn": false}'), { loggedIn: false, authMethod: undefined })
  assert.equal(parseAuthStatus('error: unknown command'), undefined)
  assert.equal(parseAuthStatus('{"foo": 1}'), undefined)
})

test('pickMainBranch: ưu tiên main/master rồi nhánh hiện tại', () => {
  assert.equal(pickMainBranch(['feature/x', 'master', ''], 'feature/x'), 'master')
  assert.equal(pickMainBranch(['main', 'master']), 'main')
  assert.equal(pickMainBranch(['dev-x'], 'dev-x\n'), 'dev-x')
  assert.equal(pickMainBranch([]), 'main')
})

test('boardHash / webviewHtml', () => {
  assert.equal(boardHash('p-1'), '#/?project=p-1')
  assert.equal(boardHash(undefined, 'settings'), '#/settings')
  const html = webviewHtml('http://127.0.0.1:4000/#/?project=p-1&x="1"')
  assert.match(html, /frame-src http:\/\/127\.0\.0\.1:4000;/)
  assert.match(html, /src="http:\/\/127\.0\.0\.1:4000\/#\/\?project=p-1&amp;x=&quot;1&quot;"/)
  assert.ok(!html.includes('<script'))
})

test('freePort: trả về cổng dùng được', async () => {
  const p = await freePort()
  assert.ok(p > 0 && p < 65536)
})
