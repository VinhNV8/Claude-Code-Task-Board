import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOARD_COLUMNS,
  DRAG_COLUMNS,
  applyDrop,
  boardColumn,
  canDrag,
  columnTasks,
  dropAction,
  isFailed,
  isStale,
  type DropAction,
  type DropHandlers,
} from '../../web/src/lib/board.ts'
import type { TaskStatus } from './types.ts'

const NOW = 1_700_000_000_000
const H = 3600_000
const t = (id: number, status: TaskStatus, ageH = 0) => ({ id, status, updatedAt: NOW - ageH * H })

test('Bảng không còn cột Failed', () => {
  assert.ok(!(BOARD_COLUMNS as string[]).includes('failed'))
  assert.deepEqual(BOARD_COLUMNS, ['backlog', 'queued', 'running', 'needs_input', 'review', 'done'])
})

test('Task Failed được đưa về cột Backlog và có cờ Fail', () => {
  assert.equal(boardColumn({ status: 'failed' }), 'backlog')
  assert.equal(isFailed({ status: 'failed' }), true)
  assert.equal(isFailed({ status: 'backlog' }), false)
  for (const st of BOARD_COLUMNS) assert.equal(boardColumn({ status: st }), st)
})

test('Cột Backlog gồm cả task Failed, task Fail lên đầu rồi mới nhất trước', () => {
  const tasks = [t(1, 'backlog', 1), t(2, 'failed', 5), t(3, 'backlog', 0), t(4, 'failed', 2), t(5, 'queued')]
  assert.deepEqual(
    columnTasks(tasks, 'backlog', { hideOld: true, now: NOW }).map((x) => x.id),
    [4, 2, 3, 1],
  )
})

test('Task Fail cũ hơn 24 giờ vẫn hiện trong Backlog, Done cũ thì bị ẩn', () => {
  const tasks = [t(1, 'failed', 48), t(2, 'done', 48), t(3, 'done', 1)]
  assert.deepEqual(columnTasks(tasks, 'backlog', { hideOld: true, now: NOW }).map((x) => x.id), [1])
  assert.deepEqual(columnTasks(tasks, 'done', { hideOld: true, now: NOW }).map((x) => x.id), [3])
  assert.deepEqual(columnTasks(tasks, 'done', { hideOld: false, now: NOW }).map((x) => x.id), [3, 2])
})

test('Mỗi task nằm đúng một cột (không mất task Failed)', () => {
  const statuses: TaskStatus[] = ['backlog', 'queued', 'running', 'needs_input', 'review', 'done', 'failed']
  const tasks = statuses.map((st, i) => t(i + 1, st))
  const shown = BOARD_COLUMNS.flatMap((c) => columnTasks(tasks, c, { hideOld: false, now: NOW }).map((x) => x.id))
  assert.deepEqual(shown.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7])
})

// ---------------------------------------------------------------- kéo thả Backlog ⇄ Queued ⇄ Running

test('Kéo thả: Backlog → Queued/Running, Queued → Running/Backlog, Running → Backlog', () => {
  assert.equal(dropAction({ status: 'backlog' }, 'queued'), 'queue')
  assert.equal(dropAction({ status: 'backlog' }, 'running'), 'run')
  assert.equal(dropAction({ status: 'queued' }, 'running'), 'run')
  assert.equal(dropAction({ status: 'queued' }, 'backlog'), 'unqueue')
  assert.equal(dropAction({ status: 'running' }, 'backlog'), 'stop')
})

test('Kéo thả: task Fail (nằm ở Backlog) thả vào Queued/Running thì chạy lại', () => {
  assert.equal(dropAction({ status: 'failed' }, 'queued'), 'retry')
  assert.equal(dropAction({ status: 'failed' }, 'running'), 'retry')
  // Đã ở cột Backlog rồi
  assert.equal(dropAction({ status: 'failed' }, 'backlog'), null)
})

test('Kéo thả: thả vào chính cột của mình hoặc cột ngoài Backlog/Queued/Running thì không làm gì', () => {
  for (const c of DRAG_COLUMNS) assert.equal(dropAction({ status: c }, c), null)
  for (const st of ['backlog', 'queued', 'running', 'failed'] as const)
    for (const c of ['needs_input', 'review', 'done'] as const) assert.equal(dropAction({ status: st }, c), null, `${st} → ${c}`)
  // Running → Queued không hỗ trợ (dừng giữa chừng sẽ làm task Fail, không quay lại hàng đợi được)
  assert.equal(dropAction({ status: 'running' }, 'queued'), null)
})

test('Kéo thả: chỉ task ở Backlog/Queued/Running (kể cả Fail) kéo được', () => {
  for (const st of ['backlog', 'queued', 'running', 'failed'] as const) assert.equal(canDrag({ status: st }), true, st)
  for (const st of ['needs_input', 'review', 'done'] as const) assert.equal(canDrag({ status: st }), false, st)
})

test('applyDrop gọi đúng action của store với id task, thả không hợp lệ thì không gọi gì', () => {
  const calls: [DropAction, number][] = []
  const h = Object.fromEntries(
    (['queue', 'unqueue', 'run', 'retry', 'stop'] as DropAction[]).map((a) => [a, (id: number) => void calls.push([a, id])]),
  ) as DropHandlers

  assert.equal(applyDrop({ id: 1, status: 'backlog' }, 'queued', h), 'queue')
  assert.equal(applyDrop({ id: 2, status: 'queued' }, 'running', h), 'run')
  assert.equal(applyDrop({ id: 3, status: 'queued' }, 'backlog', h), 'unqueue')
  assert.equal(applyDrop({ id: 4, status: 'running' }, 'backlog', h), 'stop')
  assert.equal(applyDrop({ id: 5, status: 'failed' }, 'queued', h), 'retry')
  assert.equal(applyDrop({ id: 6, status: 'backlog' }, 'done', h), null)
  assert.equal(applyDrop({ id: 7, status: 'queued' }, 'queued', h), null)

  assert.deepEqual(calls, [
    ['queue', 1],
    ['run', 2],
    ['unqueue', 3],
    ['stop', 4],
    ['retry', 5],
  ])
})

test('isStale: chỉ Done cũ hơn 24 giờ bị ẩn, và chỉ khi hideOld', () => {
  assert.equal(isStale(t(1, 'done', 25), true, NOW), true)
  assert.equal(isStale(t(1, 'done', 25), false, NOW), false)
  assert.equal(isStale(t(1, 'done', 1), true, NOW), false)
  assert.equal(isStale(t(1, 'failed', 48), true, NOW), false, 'task Fail luôn hiện ở Backlog')
})
