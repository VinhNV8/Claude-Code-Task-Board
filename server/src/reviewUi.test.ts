// Test logic thuần của màn hình review phía web (web/src/lib/review.ts, PLAN 2.9–2.12)
import { test } from 'node:test'
import assert from 'node:assert/strict'
// (MIN_FEEDBACK được server/src/review.ts import lại từ file này nên luôn khớp.)
import { attentionCounts, buildHistory, needsDiffFetch } from '../../web/src/lib/review.ts'
import type { ReviewAction, Run } from './types.ts'

const run = (id: string, kind: Run['kind'], startedAt: number, feedback?: string): Run => ({ id, taskId: 1, kind, startedAt, feedback })
const rv = (id: string, action: ReviewAction['action'], createdAt: number, feedback?: string): ReviewAction => ({ id, taskId: 1, action, createdAt, feedback })

test('attentionCounts: đếm Review, Needs Input và yêu cầu quyền đang chờ, mỗi task một lần', () => {
  const tasks = [
    { id: 1, status: 'review' as const },
    { id: 2, status: 'review' as const },
    { id: 3, status: 'needs_input' as const },
    { id: 4, status: 'running' as const },
    { id: 5, status: 'done' as const },
  ]
  const perms = [
    { taskId: 3, status: 'pending' as const },
    { taskId: 3, status: 'pending' as const }, // cùng task: không đếm hai lần
    { taskId: 4, status: 'pending' as const }, // trạng thái task chưa kịp đổi sang needs_input
    { taskId: 5, status: 'allowed' as const }, // đã xử lý
    { taskId: 99, status: 'pending' as const }, // task đã bị xoá
  ]
  assert.deepEqual(attentionCounts(tasks, perms), { review: 2, needsInput: 2, total: 4 })
  assert.deepEqual(attentionCounts([], []), { review: 0, needsInput: 0, total: 0 })
  // Task Review có yêu cầu quyền (hiếm) vẫn chỉ tính một lần trong tổng
  assert.deepEqual(attentionCounts([{ id: 1, status: 'review' }], [{ taskId: 1, status: 'pending' }]), { review: 1, needsInput: 1, total: 1 })
})

test('needsDiffFetch: chỉ tải khi state chưa có diff và task còn nhánh', () => {
  assert.equal(needsDiffFetch({ id: 1, status: 'review' }, {}), true)
  assert.equal(needsDiffFetch({ id: 1, status: 'review' }, { 1: [] }), false) // đã có (kể cả rỗng)
  assert.equal(needsDiffFetch({ id: 1, status: 'running', branch: 'claude/task-1' }, {}), true)
  assert.equal(needsDiffFetch({ id: 1, status: 'done' }, {}), false) // đã merge, nhánh bị xoá
  assert.equal(needsDiffFetch({ id: 1, status: 'backlog' }, {}), false)
})

test('buildHistory: ghép run resume với feedback, xen approve/reject theo thời gian', () => {
  const runs = [run('r1', 'initial', 100), run('r2', 'resume', 300, 'sửa A'), run('r3', 'resume', 500, 'sửa B')]
  const reviews = [rv('v2', 'request_changes', 450, 'sửa B'), rv('v1', 'request_changes', 250, 'sửa A'), rv('v3', 'approve', 700)]
  const h = buildHistory(runs, reviews)
  assert.deepEqual(
    h.map((x) => (x.kind === 'run' ? `${x.run.id}#${x.index}:${x.review?.id ?? '-'}` : `${x.review.action}`)),
    ['r1#0:-', 'r2#1:v1', 'r3#2:v2', 'approve'],
  )
})

test('buildHistory: feedback chưa có run (đang chờ slot) hiện riêng, reject trước retry', () => {
  const runs = [run('r1', 'initial', 100), run('r2', 'retry', 600)]
  const reviews = [rv('v1', 'reject', 300, 'sai hướng'), rv('v2', 'request_changes', 900, 'thêm test')]
  const h = buildHistory(runs, reviews)
  assert.deepEqual(
    h.map((x) => (x.kind === 'run' ? x.run.id : `${x.review.action}${x.pending ? '(pending)' : ''}`)),
    ['r1', 'reject', 'r2', 'request_changes(pending)'],
  )
})

test('buildHistory: feedback trùng nội dung vẫn ghép đúng từng lần theo thời gian', () => {
  const runs = [run('r1', 'initial', 100), run('r2', 'resume', 300, 'lại'), run('r3', 'resume', 500, 'lại')]
  const reviews = [rv('v1', 'request_changes', 250, 'lại'), rv('v2', 'request_changes', 450, 'lại')]
  const h = buildHistory(runs, reviews).filter((x) => x.kind === 'run')
  assert.deepEqual(h.map((x) => (x.kind === 'run' ? x.review?.id : null)), [undefined, 'v1', 'v2'])
})
