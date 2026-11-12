// Test logic thuần của thông báo / thẻ xin quyền phía web (web/src/lib/notify.ts, PLAN 3.7–3.9)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { permissionDisplay, permissionTimeLeft, shouldAskPermission, taskHash, transitionNotice } from '../../web/src/lib/notify.ts'

const ALL_ON = { review: true, needsInput: true, failed: true }
const task = (status: 'running' | 'review' | 'needs_input' | 'failed' | 'done', failReason?: string) => ({ id: 7, title: 'Sửa lỗi ngày', status, failReason })

test('transitionNotice: báo khi chuyển sang Review / Needs Input / Failed, kèm taskId để mở đúng task', () => {
  assert.deepEqual(transitionNotice('running', task('review'), ALL_ON), { kind: 'info', title: 'Cần review: #7', body: 'Sửa lỗi ngày', taskId: 7 })
  assert.equal(transitionNotice('running', task('needs_input'), ALL_ON)?.kind, 'warning')
  const failed = transitionNotice('running', task('failed', 'Hết thời gian'), ALL_ON)
  assert.equal(failed?.kind, 'error')
  assert.equal(failed?.body, 'Hết thời gian')
  assert.equal(failed?.taskId, 7)
})

test('transitionNotice: không báo khi trạng thái không đổi, lần tải đầu, trạng thái khác hoặc loại bị tắt', () => {
  assert.equal(transitionNotice('review', task('review'), ALL_ON), null)
  assert.equal(transitionNotice(undefined, task('review'), ALL_ON), null)
  assert.equal(transitionNotice('running', task('done'), ALL_ON), null)
  assert.equal(transitionNotice('running', task('review'), { ...ALL_ON, review: false }), null)
  assert.equal(transitionNotice('running', task('needs_input'), { ...ALL_ON, needsInput: false }), null)
  assert.equal(transitionNotice('running', task('failed'), { ...ALL_ON, failed: false }), null)
  // Thiếu lý do lỗi thì dùng tiêu đề task
  assert.equal(transitionNotice('running', task('failed'), ALL_ON)?.body, 'Sửa lỗi ngày')
})

test('shouldAskPermission: chỉ hỏi một lần khi trình duyệt chưa có quyết định', () => {
  assert.equal(shouldAskPermission('default', false), true)
  assert.equal(shouldAskPermission('default', true), false)
  assert.equal(shouldAskPermission('granted', false), false)
  assert.equal(shouldAskPermission('denied', false), false)
  assert.equal(shouldAskPermission('unsupported', false), false)
})

test('taskHash: đường dẫn HashRouter tới trang task', () => {
  assert.equal(taskHash(12), '#/tasks/12')
})

test('permissionDisplay: lệnh shell có $, tool khác hiện nguyên input', () => {
  assert.equal(permissionDisplay({ tool: 'Bash', input: 'npm install dayjs' }), '$ npm install dayjs')
  assert.equal(permissionDisplay({ tool: 'Edit', input: 'src/a.ts' }), 'src/a.ts')
  assert.equal(permissionDisplay({ tool: 'mcp__x__y', input: '  ' }), '(không có tham số)')
})

test('permissionTimeLeft: đếm ngược theo timeoutAt của server, không âm', () => {
  assert.equal(permissionTimeLeft(10_000, 4_000), 6_000)
  assert.equal(permissionTimeLeft(10_000, 12_000), 0)
})
