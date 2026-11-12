import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildHookSettings,
  buildNotificationCommand,
  cleanupHookSettings,
  formatNotification,
  quoteArg,
  removeHookSettings,
  writeHookSettings,
} from './hookSettings.ts'
import { buildClaudeArgs } from './permissionTool.ts'

const opts = {
  port: 3001,
  token: 'abc123',
  taskId: 7,
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  tsxLoader: 'file:///D:/Projects/AI%20Project/node_modules/tsx/dist/loader.mjs',
  scriptPath: 'D:\\Projects\\AI Project\\server\\src\\hooks\\notification.ts',
}

test('quoteArg: Windows dùng nháy kép và dấu /, giữ nguyên dấu cách', () => {
  assert.equal(quoteArg('C:\\Program Files\\nodejs\\node.exe', 'win32'), '"C:/Program Files/nodejs/node.exe"')
})

test('quoteArg: POSIX dùng nháy đơn và escape nháy đơn', () => {
  assert.equal(quoteArg('/home/a b/x', 'linux'), `'/home/a b/x'`)
  assert.equal(quoteArg(`it's`, 'linux'), `'it'\\''s'`)
})

test('buildNotificationCommand: đủ node, loader tsx, script, port, token, task', () => {
  const cmd = buildNotificationCommand({ ...opts, platform: 'win32' })
  assert.equal(
    cmd,
    '"C:/Program Files/nodejs/node.exe" "--import" "file:///D:/Projects/AI%20Project/node_modules/tsx/dist/loader.mjs" ' +
      '"D:/Projects/AI Project/server/src/hooks/notification.ts" "--port" "3001" "--token" "abc123" "--task" "7"',
  )
})

test('buildHookSettings: khai báo hook Notification dạng command', () => {
  const s = buildHookSettings({ ...opts, platform: 'win32' })
  const entry = s.hooks.Notification[0]
  assert.equal(entry.matcher, '')
  assert.equal(entry.hooks[0].type, 'command')
  assert.match(entry.hooks[0].command, /notification\.ts" "--port" "3001"/)
})

test('write/remove/cleanup file settings tạm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-hooks-'))
  try {
    const file = writeHookSettings(dir, 'run-1', opts)
    assert.ok(file.endsWith('run-1.settings.json'))
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).hooks.Notification)
    removeHookSettings(file)
    assert.equal(existsSync(file), false)
    removeHookSettings(file) // xoá lần hai không lỗi
    removeHookSettings(undefined)

    writeHookSettings(dir, 'run-2', opts)
    writeHookSettings(dir, 'run-3', opts)
    writeFileSync(join(dir, 'run-2.jsonl'), '')
    assert.equal(cleanupHookSettings(dir), 2)
    assert.equal(existsSync(join(dir, 'run-2.jsonl')), true)
    assert.equal(cleanupHookSettings(join(dir, 'khong-ton-tai')), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildClaudeArgs: truyền --settings trước --allowedTools', () => {
  const args = buildClaudeArgs({
    sessionId: 's',
    resume: false,
    permissionMode: 'acceptEdits',
    allowedTools: ['Bash(npm test)'],
    settingsPath: 'D:\\data\\runs\\r.settings.json',
  })
  const i = args.indexOf('--settings')
  assert.ok(i > 0)
  assert.equal(args[i + 1], 'D:\\data\\runs\\r.settings.json')
  assert.ok(i < args.indexOf('--allowedTools'))
  assert.equal(buildClaudeArgs({ sessionId: 's', resume: false, permissionMode: 'plan', allowedTools: [] }).includes('--settings'), false)
})

test('formatNotification', () => {
  assert.equal(formatNotification({ message: ' Claude cần bạn cấp quyền ' }), 'Thông báo từ Claude: Claude cần bạn cấp quyền')
  assert.equal(formatNotification({ message: 'x', title: 'Chờ nhập' }), 'Thông báo từ Claude (Chờ nhập): x')
})
