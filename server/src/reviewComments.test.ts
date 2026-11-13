// Test logic nhận xét theo file/dòng khi review (web/src/lib/reviewComments.ts, G3)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commentLocation, fileSignature, formatReviewFeedback, isMarkdownPath, parseComments } from '../../web/src/lib/reviewComments.ts'
import { buildHistory } from '../../web/src/lib/review.ts'
import type { FileDiff, ReviewComment } from './types.ts'

const c = (o: Partial<ReviewComment> & Pick<ReviewComment, 'path' | 'text'>): ReviewComment => ({ id: o.path + (o.line ?? ''), ...o })

test('formatReviewFeedback: không có nhận xét thì giữ nguyên feedback', () => {
  assert.equal(formatReviewFeedback('  Sửa lại  '), 'Sửa lại')
})

test('formatReviewFeedback: sắp theo file/dòng, kèm nội dung dòng, nhận xét nhiều dòng được thụt lề', () => {
  const out = formatReviewFeedback('Chung', [
    c({ path: 'b.ts', line: 9, side: 'new', snippet: '  return x ', text: 'Trả về y' }),
    c({ path: 'a.md', text: 'Thiếu mục cài đặt\nvà ví dụ' }),
    c({ path: 'b.ts', line: 3, side: 'old', snippet: 'const a = 1', text: 'Sao lại xoá dòng này?' }),
  ])
  assert.equal(
    out,
    [
      'Chung',
      '',
      'Nhận xét khi review (3), hãy sửa theo từng mục:',
      '1. a.md (cả file)',
      '   Thiếu mục cài đặt',
      '   và ví dụ',
      '2. b.ts:3 (bản cũ, dòng đã xoá)',
      '   Dòng: `const a = 1`',
      '   Sao lại xoá dòng này?',
      '3. b.ts:9',
      '   Dòng: `return x`',
      '   Trả về y',
    ].join('\n'),
  )
  assert.match(formatReviewFeedback('', [c({ path: 'x', text: 't' })]), /^Nhận xét khi review \(1\)/)
})

test('parseComments: chuẩn hoá và báo lỗi tiếng Việt', () => {
  assert.deepEqual(parseComments(undefined), { comments: [] })
  const ok = parseComments([{ id: 'k', path: ' a.ts ', line: '4', side: 'x', snippet: 'abc', text: ' t ' }, { path: 'b', text: 'u', snippet: 'bỏ' }])
  assert.deepEqual(ok, {
    comments: [
      { id: 'k', path: 'a.ts', line: 4, side: 'new', snippet: 'abc', text: 't' },
      { id: 'c2', path: 'b', line: undefined, side: undefined, snippet: undefined, text: 'u' },
    ],
  })
  assert.match(parseComments('x').error!, /không hợp lệ/)
  assert.match(parseComments([{ text: 'a' }]).error!, /thiếu đường dẫn/)
  assert.match(parseComments([{ path: 'a', line: 1.5, text: 'a' }]).error!, /số dòng/)
  assert.match(parseComments(Array.from({ length: 201 }, () => ({ path: 'a', text: 'b' }))).error!, /Tối đa/)
})

test('commentLocation, isMarkdownPath', () => {
  assert.equal(commentLocation({ path: 'a.ts', line: 2, side: 'new' }), 'a.ts:2')
  assert.equal(commentLocation({ path: 'a.ts' }), 'a.ts (cả file)')
  assert.ok(isMarkdownPath('docs/README.MD') && isMarkdownPath('x.markdown'))
  assert.ok(!isMarkdownPath('a.ts') && !isMarkdownPath('md'))
})

test('fileSignature: đổi nội dung diff thì chữ ký đổi', () => {
  const f = (text: string): FileDiff => ({ path: 'a', status: 'modified', additions: 1, deletions: 0, hunks: [{ header: '@@', lines: [{ type: 'add', newNo: 1, text }] }] })
  assert.equal(fileSignature(f('x')), fileSignature(f('x')))
  assert.notEqual(fileSignature(f('x')), fileSignature(f('y')))
})

test('buildHistory: run resume ghép đúng review có nhận xét (feedback của run là bản đã định dạng)', () => {
  const comments = [c({ path: 'a.ts', line: 1, side: 'new', text: 'Sửa' })]
  const reviews = [
    { id: 'r1', taskId: 1, action: 'request_changes' as const, createdAt: 10, feedback: 'Lần 1 đủ dài' },
    { id: 'r2', taskId: 1, action: 'request_changes' as const, createdAt: 20, comments },
  ]
  const runs = [
    { id: 'a', taskId: 1, kind: 'initial' as const, startedAt: 1 },
    { id: 'c', taskId: 1, kind: 'resume' as const, startedAt: 21, feedback: formatReviewFeedback(undefined, comments) },
  ]
  const items = buildHistory(runs, reviews)
  const resume = items.find((i) => i.kind === 'run' && i.run.id === 'c')
  assert.equal(resume?.kind === 'run' && resume.review?.id, 'r2')
})
