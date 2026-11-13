// Test logic trang Công việc 3 cách xem (web/src/lib/workView.ts): file thuần, không phụ thuộc DOM/React
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  attentionItems,
  initialView,
  logLine,
  parseTaskParam,
  parseView,
  searchTasks,
  slotAssignments,
  stepSelection,
  triageGroups,
  withParams,
  workShortcut,
} from '../../web/src/lib/workView.ts'
import type { PermissionRequest, TaskStatus } from './types.ts'

const NOW = 1_700_000_000_000
const H = 3600_000

test('parseView: chỉ nhận 3 giá trị hợp lệ', () => {
  assert.equal(parseView('board'), 'board')
  assert.equal(parseView('ops'), 'ops')
  assert.equal(parseView('triage'), 'triage')
  assert.equal(parseView('inbox'), undefined)
  assert.equal(parseView(null), undefined)
})

test('initialView: URL > lần dùng trước > màn hình', () => {
  assert.equal(initialView('triage', 'ops', false), 'triage')
  assert.equal(initialView(null, 'ops', false), 'ops')
  assert.equal(initialView('xyz', 'nope', false), 'board')
  assert.equal(initialView(null, null, true), 'ops', 'điện thoại mặc định Điều phối')
})

test('parseTaskParam: số nguyên dương', () => {
  assert.equal(parseTaskParam('55'), 55)
  assert.equal(parseTaskParam('0'), undefined)
  assert.equal(parseTaskParam('-1'), undefined)
  assert.equal(parseTaskParam('5a'), undefined)
  assert.equal(parseTaskParam(null), undefined)
})

test('withParams: giữ khoá khác, đặt/xoá theo patch, không sửa bản gốc', () => {
  const cur = new URLSearchParams('project=a&project=b&q=x&task=3')
  const next = withParams(cur, { view: 'ops', task: null, q: '' })
  assert.deepEqual(next.getAll('project'), ['a', 'b'])
  assert.equal(next.get('view'), 'ops')
  assert.equal(next.has('task'), false)
  assert.equal(next.has('q'), false)
  assert.equal(cur.get('task'), '3')
})

test('workShortcut: phím số, J/K, Esc; bỏ qua khi đang gõ hoặc có phím bổ trợ', () => {
  assert.equal(workShortcut({ key: '1' }), 'board')
  assert.equal(workShortcut({ key: '2' }), 'ops')
  assert.equal(workShortcut({ key: '3' }), 'triage')
  assert.equal(workShortcut({ key: 'j' }), 'next')
  assert.equal(workShortcut({ key: 'K' }), 'prev')
  assert.equal(workShortcut({ key: 'Escape' }), 'close')
  assert.equal(workShortcut({ key: '4' }), null)
  assert.equal(workShortcut({ key: '1', targetTag: 'input' }), null)
  assert.equal(workShortcut({ key: 'j', targetTag: 'TEXTAREA' }), null)
  assert.equal(workShortcut({ key: 'j', isContentEditable: true }), null)
  assert.equal(workShortcut({ key: '1', ctrlKey: true }), null)
})

test('stepSelection: đi trong danh sách, dừng ở hai đầu', () => {
  const ids = [5, 7, 9]
  assert.equal(stepSelection(ids, undefined, 1), 5)
  assert.equal(stepSelection(ids, undefined, -1), 9)
  assert.equal(stepSelection(ids, 5, 1), 7)
  assert.equal(stepSelection(ids, 9, 1), 9)
  assert.equal(stepSelection(ids, 5, -1), 5)
  assert.equal(stepSelection(ids, 42, 1), 5, 'task không còn trong danh sách: về đầu')
  assert.equal(stepSelection([], 1, 1), undefined)
})

const tk = (id: number, status: TaskStatus, ageH = 0, createdAgeH = ageH) => ({ id, status, updatedAt: NOW - ageH * H, createdAt: NOW - createdAgeH * H })

test('triageGroups: thứ tự nhóm và thứ tự trong nhóm', () => {
  const groups = triageGroups([
    tk(1, 'done', 1),
    tk(2, 'review', 1),
    tk(3, 'review', 5),
    tk(4, 'needs_input', 0),
    tk(5, 'queued', 0, 2),
    tk(6, 'queued', 0, 9),
    tk(7, 'backlog', 3),
    tk(8, 'backlog', 1),
    tk(9, 'failed', 2),
  ])
  assert.deepEqual(
    groups.map((g) => g.status),
    ['needs_input', 'review', 'failed', 'queued', 'backlog', 'done'],
    'bỏ nhóm rỗng (running)',
  )
  const ids = (s: TaskStatus) => groups.find((g) => g.status === s)!.tasks.map((t) => t.id)
  assert.deepEqual(ids('review'), [3, 2], 'chờ duyệt lâu nhất trước')
  assert.deepEqual(ids('queued'), [6, 5], 'hàng đợi: tạo trước chạy trước')
  assert.deepEqual(ids('backlog'), [8, 7], 'mới cập nhật trước')
})

const perm = (id: string, taskId: number, ageMin: number, status: PermissionRequest['status'] = 'pending'): PermissionRequest => ({
  id,
  taskId,
  tool: 'Bash',
  input: 'npm i',
  createdAt: NOW - ageMin * 60_000,
  timeoutAt: NOW + H,
  status,
})

test('attentionItems: quyền → đang chờ → duyệt → lỗi 24h, chỉ task đã lọc', () => {
  const tasks = [tk(1, 'needs_input'), tk(2, 'needs_input', 1), tk(3, 'review', 2), tk(4, 'review', 5), tk(5, 'failed', 1), tk(6, 'failed', 30), tk(7, 'running')]
  const perms = [perm('a', 1, 2), perm('b', 1, 9), perm('c', 99, 1), perm('d', 7, 1, 'allowed')]
  const items = attentionItems(tasks, perms, { includeReview: true, now: NOW })
  assert.deepEqual(
    items.map((i) => `${i.kind}:${i.taskId}`),
    ['permission:1', 'permission:1', 'waiting:2', 'review:4', 'review:3', 'failed:5'],
  )
  assert.equal(items[0].kind === 'permission' && items[0].req.id, 'b', 'yêu cầu cũ nhất trước')

  const noReview = attentionItems(tasks, perms, { includeReview: false, now: NOW })
  assert.ok(noReview.every((i) => i.kind !== 'review'))
})

test('slotAssignments: theo giờ bắt đầu, độn slot trống, không cắt bớt khi vượt', () => {
  const run = (id: number, status: TaskStatus, startedAt?: number) => ({ id, status, startedAt })
  const tasks = [run(1, 'running', 30), run(2, 'needs_input', 10), run(3, 'queued'), run(4, 'review', 5)]
  assert.deepEqual(
    slotAssignments(tasks, 3).map((t) => t?.id),
    [2, 1, undefined],
  )
  assert.equal(slotAssignments(tasks, 1).length, 2)
  assert.equal(slotAssignments([], 0).length, 1)
})

test('searchTasks: theo #id, theo tiêu đề không dấu, ưu tiên khớp đầu', () => {
  const tasks = [
    { id: 12, title: 'Sửa lỗi giỏ hàng', updatedAt: 1 },
    { id: 3, title: 'Giỏ hàng: thêm mã giảm giá', updatedAt: 2 },
    { id: 120, title: 'Viết test', updatedAt: 3 },
  ]
  assert.deepEqual(searchTasks(tasks, '#12').map((t) => t.id), [12])
  assert.deepEqual(searchTasks(tasks, 'gio hang').map((t) => t.id), [3, 12])
  assert.deepEqual(searchTasks(tasks, '').map((t) => t.id), [120, 3, 12], 'không gõ gì: mới nhất trước')
  assert.deepEqual(searchTasks(tasks, 'không có'), [])
})

test('logLine: một dòng cho từng loại event', () => {
  assert.deepEqual(logLine({ type: 'tool_use', tool: 'Bash', input: 'npm test\n--watch' }), { kind: 'tool', text: 'Bash npm test' })
  assert.deepEqual(logLine({ type: 'tool_result', tool: 'Bash' }), { kind: 'ok', text: '✓ Bash xong' })
  assert.equal(logLine({ type: 'tool_result', tool: 'Edit', isError: true }).kind, 'error')
  assert.deepEqual(logLine({ type: 'assistant', text: 'Đang sửa\nchi tiết' }), { kind: 'text', text: 'Đang sửa' })
})
