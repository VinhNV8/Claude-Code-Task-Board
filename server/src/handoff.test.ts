// SPEC-PLAN-HANDOFF Phần B: điều kiện mở task trong agent tương tác, lệnh chạy tiếp phiên, khoá task.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard handoff '))
process.env.TASKBOARD_DB = ':memory:'
const { projects, tasks } = await import('./db.ts')
const { displayCommand, handoffCheck, handoffs, interactiveArgs, isHandedOff, quoteArg, sessionAgent } = await import('./handoff.ts')

const yes = () => true

test('interactiveArgs: Claude resume kèm model alias, bỏ model lạ; Codex; agent chưa hỗ trợ', () => {
  assert.deepEqual(interactiveArgs('claude', 's1', 'sonnet'), ['--resume', 's1', '--model', 'sonnet'])
  assert.deepEqual(interactiveArgs('claude', 's1', 'claude-opus-5-5'), ['--resume', 's1', '--model', 'claude-opus-5-5'])
  assert.deepEqual(interactiveArgs('claude', 's1', 'gpt-x; rm -rf'), ['--resume', 's1'])
  assert.deepEqual(interactiveArgs('claude', 's1'), ['--resume', 's1'])
  assert.deepEqual(interactiveArgs('codex', 't1'), ['resume', 't1'])
  assert.equal(interactiveArgs('antigravity', 'x'), undefined)
  assert.equal(interactiveArgs('cursor', 'x'), undefined)
})

test('displayCommand: đường dẫn có dấu cách và tiếng Việt được đặt trong ngoặc kép (AC-52)', () => {
  assert.equal(quoteArg('--resume'), '--resume')
  assert.equal(quoteArg('D:\\Dự án\\Repo A'), '"D:\\Dự án\\Repo A"')
  assert.equal(
    displayCommand('C:\\Program Files\\claude.exe', ['--resume', 'abc'], 'D:\\Dự án\\Repo A'),
    'cd "D:\\Dự án\\Repo A" && "C:\\Program Files\\claude.exe" --resume abc',
  )
})

test('handoffCheck: bảng B3', () => {
  const base = { agent: 'claude' as const, cwd: '/w', cwdExists: yes }
  assert.deepEqual(handoffCheck({ status: 'review', sessionId: 's' }, base), { ok: true, needsStop: false })
  assert.deepEqual(handoffCheck({ status: 'failed', sessionId: 's' }, base), { ok: true, needsStop: false })
  for (const status of ['running', 'needs_input', 'queued'] as const)
    assert.deepEqual(handoffCheck({ status, sessionId: 's' }, base), { ok: true, needsStop: true }, status)
  assert.equal(handoffCheck({ status: 'backlog', sessionId: undefined }, base).ok, false)
  assert.equal(handoffCheck({ status: 'done', sessionId: 's' }, base).ok, false)
  assert.equal(handoffCheck({ status: 'review', sessionId: undefined }, base).ok, false)
  assert.equal(handoffCheck({ status: 'review', sessionId: 's' }, { ...base, agent: 'antigravity' }).ok, false, 'AC-58')
  assert.equal(handoffCheck({ status: 'review', sessionId: 's' }, { ...base, cwdExists: () => false }).ok, false)
  assert.equal(handoffCheck({ status: 'review', sessionId: 's' }, { ...base, locked: true }).ok, false)
})

test('sessionAgent: run cũ không ghi agent là Claude', () => {
  assert.equal(sessionAgent(undefined), 'claude')
  assert.equal(sessionAgent({ agent: undefined }), 'claude')
  assert.equal(sessionAgent({ agent: 'codex' }), 'codex')
})

test('handoffs: khoá lưu DB, chỉ claim đầu tiên đúng requestId thành công, mở khoá', () => {
  projects.upsert({
    id: 'p',
    name: 'p',
    repoPath: process.env.TASKBOARD_DATA!,
    mainBranch: 'main',
    permissionMode: 'acceptEdits',
    allowedTools: [],
    maxParallel: 1,
    budgetAction: 'warn',
    deliveryMode: 'direct',
  })
  const t = tasks.create({ projectId: 'p', title: 't', prompt: 'p', status: 'review', priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
  assert.equal(isHandedOff(t.id), false)
  const h = handoffs.start({ taskId: t.id, via: 'extension', cwd: '/w', agent: 'claude' }, 1000)
  assert.equal(isHandedOff(t.id), true)
  assert.equal(h.startedAt, 1000)
  assert.equal(handoffs.claim(t.id, 'sai'), false)
  assert.equal(handoffs.claim(t.id, h.requestId, 2000), true)
  assert.equal(handoffs.claim(t.id, h.requestId), false, 'cửa sổ VS Code thứ hai không mở thêm terminal')
  assert.equal(handoffs.get(t.id)?.claimedAt, 2000)
  // Mở lại: requestId mới, chưa ai nhận
  const h2 = handoffs.start({ taskId: t.id, via: 'copy', cwd: '/w', agent: 'claude' })
  assert.notEqual(h2.requestId, h.requestId)
  assert.equal(h2.claimedAt, undefined)
  handoffs.end(t.id)
  assert.equal(isHandedOff(t.id), false)
})
