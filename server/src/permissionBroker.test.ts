// PermissionBroker (SPEC-MULTI-AGENT mục 3.3a): đổi yêu cầu của agent sang tool kiểu Claude, quyết định theo mode,
// chờ quyết định qua long-poll, đóng an toàn khi lỗi.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { awaitPermission, isInside, modeDecision, toClaudeTool, type AgentPermissionRequest } from './permissionBroker.ts'
import type { PermissionAsk, PollResponse } from './permissions.ts'

const CWD = 'C:\\work\\proj a'
const req = (r: Partial<AgentPermissionRequest>): AgentPermissionRequest => ({ taskId: 7, kind: 'shell', ...r })

test('toClaudeTool: mỗi loại thao tác đổi sang đúng tool của Claude', () => {
  assert.deepEqual(toClaudeTool(req({ kind: 'shell', command: 'npm test' })), { toolName: 'Bash', input: { command: 'npm test' } })
  assert.deepEqual(toClaudeTool(req({ kind: 'edit', path: 'src/a.ts' })), { toolName: 'Edit', input: { file_path: 'src/a.ts' } })
  assert.deepEqual(toClaudeTool(req({ kind: 'write', path: 'b.txt' })), { toolName: 'Write', input: { file_path: 'b.txt' } })
  assert.deepEqual(toClaudeTool(req({ kind: 'read', path: 'c.md' })), { toolName: 'Read', input: { file_path: 'c.md' } })
  assert.deepEqual(toClaudeTool(req({ kind: 'web', url: 'https://x.dev' })), { toolName: 'WebFetch', input: { url: 'https://x.dev' } })
  assert.deepEqual(toClaudeTool(req({ kind: 'mcp', tool: 'github/create_issue' })), { toolName: 'mcp__github__create_issue', input: {} })
  assert.deepEqual(toClaudeTool(req({ kind: 'shell', command: 'ls', reason: 'xem file' })).input, { command: 'ls', description: 'xem file' })
})

test('isInside: đường dẫn tương đối/tuyệt đối, dấu cách, hoa thường Windows, không lọt ra ngoài bằng ..', () => {
  assert.equal(isInside('src/a.ts', CWD, true), true)
  assert.equal(isInside('C:/WORK/Proj A/x.txt', CWD, true), true)
  assert.equal(isInside(CWD, CWD, true), true)
  assert.equal(isInside('../other/x.txt', CWD, true), false)
  assert.equal(isInside('C:\\work\\proj ab\\x.txt', CWD, true), false)
  assert.equal(isInside('C:/WORK/Proj A/x.txt', CWD, false), false)
  assert.equal(isInside(undefined, CWD), false)
  assert.equal(isInside('a', undefined), false)
})

test('modeDecision: đọc trong thư mục task luôn cho phép; plan chặn ghi/lệnh; acceptEdits tự cho sửa file trong thư mục', () => {
  for (const mode of ['manual', 'acceptEdits', 'auto', 'plan'] as const)
    assert.deepEqual(modeDecision(mode, req({ kind: 'read', path: 'a.ts' }), CWD), { allow: true }, mode)
  assert.equal(modeDecision('manual', req({ kind: 'read', path: 'C:/secret/a' }), CWD), undefined)

  assert.equal(modeDecision('plan', req({ kind: 'shell', command: 'ls' }), CWD)?.allow, false)
  assert.equal(modeDecision('plan', req({ kind: 'edit', path: 'a.ts' }), CWD)?.allow, false)
  assert.equal(modeDecision('plan', req({ kind: 'mcp', tool: 'x/y' }), CWD)?.allow, false)
  assert.equal(modeDecision('plan', req({ kind: 'web', url: 'https://a' }), CWD), undefined)

  assert.deepEqual(modeDecision('acceptEdits', req({ kind: 'edit', path: 'a.ts' }), CWD), { allow: true })
  assert.deepEqual(modeDecision('acceptEdits', req({ kind: 'write', path: 'new.ts' }), CWD), { allow: true })
  assert.equal(modeDecision('acceptEdits', req({ kind: 'edit', path: 'C:/elsewhere/a.ts' }), CWD), undefined)
  assert.equal(modeDecision('acceptEdits', req({ kind: 'shell', command: 'npm i' }), CWD), undefined)

  // manual/auto: sửa file và lệnh đều đi qua backend (người duyệt / allowlist / Auto)
  assert.equal(modeDecision('manual', req({ kind: 'edit', path: 'a.ts' }), CWD), undefined)
  assert.equal(modeDecision('auto', req({ kind: 'shell', command: 'npm test' }), CWD), undefined)
})

test('awaitPermission: hỏi tiếp bằng requestId khi còn pending, trả đúng quyết định', async () => {
  const calls: PermissionAsk[] = []
  const answers: PollResponse[] = [
    { status: 'pending', requestId: 'perm-1' },
    { status: 'pending', requestId: 'perm-1' },
    { decision: 'allow', updatedInput: {} },
  ]
  const d = await awaitPermission(req({ kind: 'shell', command: 'npm install' }), { mode: 'manual', cwd: CWD }, {
    requestPermission: async (a) => {
      calls.push(a)
      return answers.shift()!
    },
  })
  assert.deepEqual(d, { allow: true })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0], { taskId: 7, toolName: 'Bash', input: { command: 'npm install' } })
  assert.equal(calls[1].requestId, 'perm-1')
  assert.equal(calls[2].requestId, 'perm-1')
})

test('awaitPermission: từ chối kèm lý do; lỗi backend → từ chối (đóng an toàn); mode quyết trước thì không gọi backend', async () => {
  const deny = await awaitPermission(req({ command: 'rm -rf /' }), { mode: 'auto', cwd: CWD }, {
    requestPermission: async () => ({ decision: 'deny', message: 'Người dùng từ chối: nguy hiểm' }),
  })
  assert.deepEqual(deny, { allow: false, message: 'Người dùng từ chối: nguy hiểm' })

  const broken = await awaitPermission(req({ command: 'ls' }), { mode: 'manual', cwd: CWD }, {
    requestPermission: async () => {
      throw new Error('Task #7 không có lần chạy nào đang diễn ra')
    },
  })
  assert.equal(broken.allow, false)
  assert.match((broken as { message: string }).message, /không có lần chạy/)

  let called = false
  const pre = await awaitPermission(req({ kind: 'edit', path: 'a.ts' }), { mode: 'plan', cwd: CWD }, {
    requestPermission: async () => {
      called = true
      return { decision: 'allow', updatedInput: {} }
    },
  })
  assert.equal(pre.allow, false)
  assert.equal(called, false)
})
