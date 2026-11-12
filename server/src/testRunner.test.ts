import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// DB riêng trong bộ nhớ cho test (phải đặt trước khi import db.ts)
process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard-testrun-'))
process.env.TASKBOARD_DB = ':memory:'
const { projects, tasks, testRuns } = await import('./db.ts')
const { bus } = await import('./bus.ts')
const { isTesting, startTests, stopTests, testState, TestRunError } = await import('./testRunner.ts')
import type { ServerMessage } from './bus.ts'
import type { TestRun } from './types.ts'

const node = `"${process.execPath}"`
const worktree = mkdtempSync(join(tmpdir(), 'taskboard worktree '))

function setup(testCommand: string | undefined, status: 'review' | 'running' = 'review', withWorktree = true) {
  const p = projects.upsert({
    id: `p-${Math.random().toString(36).slice(2, 8)}`,
    name: 'demo',
    repoPath: worktree,
    mainBranch: 'main',
    permissionMode: 'acceptEdits',
    allowedTools: [],
    maxParallel: 1,
    testCommand,
  })
  const t = tasks.create({ projectId: p.id, title: 't', prompt: 'p'.repeat(10), status, priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
  if (withWorktree) tasks.patch(t.id, { worktreePath: worktree })
  return t.id
}

/** Thu các tin nhắn WS của task cho tới khi lần chạy kết thúc. */
function collect(taskId: number) {
  const msgs: ServerMessage[] = []
  const done = new Promise<TestRun>((res) => {
    const on = (m: ServerMessage) => {
      if ((m.type === 'test_run' && m.testRun.taskId === taskId) || (m.type === 'test_output' && m.taskId === taskId)) msgs.push(m)
      if (m.type === 'test_run' && m.testRun.taskId === taskId && m.testRun.status !== 'running') {
        bus.off('message', on)
        res(m.testRun)
      }
    }
    bus.on('message', on)
  })
  return { msgs, done }
}

const status = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof TestRunError, String(e))
    return (e as InstanceType<typeof TestRunError>).statusCode
  }
  return 0
}

test('chạy test đạt: stream output theo offset, lưu lần chạy gần nhất', async () => {
  const id = setup(`${node} -e "console.log('ok 1'); console.log('ok 2')"`)
  const { msgs, done } = collect(id)
  const started = startTests(id)
  assert.equal(started.status, 'running')
  assert.ok(isTesting(id))
  const run = await done
  assert.equal(run.status, 'passed')
  assert.equal(run.exitCode, 0)
  assert.ok(run.endedAt! >= run.startedAt)
  assert.ok(!isTesting(id))

  // Ghép các đoạn output theo offset phải ra đúng output đã lưu
  let text = ''
  for (const m of msgs) if (m.type === 'test_output') {
    assert.equal(m.offset, text.length)
    text += m.chunk
  }
  const saved = testState(id)
  assert.equal(saved.testRun?.status, 'passed')
  assert.equal(saved.output.text, text)
  assert.equal(saved.output.end, text.length)
  assert.match(text, /ok 1\nok 2\n/)
})

test('chạy test lỗi: exit code khác 0 → failed; chạy lại ghi đè lần trước', async () => {
  const id = setup(`${node} -e "console.error('boom'); process.exit(2)"`)
  let c = collect(id)
  startTests(id)
  let run = await c.done
  assert.equal(run.status, 'failed')
  assert.equal(run.exitCode, 2)
  assert.match(testState(id).output.text, /boom/)

  c = collect(id)
  startTests(id)
  assert.equal(testState(id).output.end, 0) // output cũ bị xoá khi bắt đầu lần mới
  run = await c.done
  assert.equal(run.status, 'failed')
  assert.equal(testRuns.all().filter((r) => r.taskId === id).length, 1)
})

test('không cho chạy song song trên cùng task; nút dừng kết thúc với trạng thái stopped', async () => {
  const id = setup(`${node} -e "console.log('bắt đầu'); setTimeout(() => {}, 60000)"`)
  const { done } = collect(id)
  startTests(id)
  assert.equal(status(() => startTests(id)), 409)
  assert.equal(await stopTests(id), true)
  const run = await done
  assert.equal(run.status, 'stopped')
  assert.equal(run.error, 'Đã dừng bởi người dùng.')
  assert.equal(await stopTests(id), false)
})

test('điều kiện chạy: chưa cấu hình lệnh, chưa có worktree, Claude đang chạy, lệnh không tồn tại', () => {
  assert.equal(status(() => startTests(setup(undefined))), 400)
  assert.equal(status(() => startTests(setup('npm test', 'review', false))), 409)
  assert.equal(status(() => startTests(setup('npm test', 'running'))), 409)
  assert.equal(status(() => startTests(setup('khong-co-lenh-nay-xyz --run'))), 400)
  assert.equal(status(() => startTests(999_999)), 404)
})

test('abortRunning: lần chạy còn dở khi server khởi động lại chuyển sang error', () => {
  const id = setup('npm test')
  testRuns.start({ taskId: id, command: 'npm test', startedAt: Date.now() })
  testRuns.abortRunning('Server đã khởi động lại')
  assert.equal(testRuns.get(id)?.status, 'error')
})
