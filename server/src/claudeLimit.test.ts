// Banner "gói Claude hết lượt": nhận loại giới hạn, câu thông báo, dựng trạng thái từ lần gặp giới hạn.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatRemaining, isLimitActive, limitKind, limitNotice } from '../../web/src/lib/claudeLimit.ts'
import { buildClaudeLimit } from './claudeLimit.ts'
import { DEFAULT_WAIT_MS, detectRateLimit } from './rateLimit.ts'

test('limitKind: từ rateLimitType của stream-json', () => {
  assert.equal(limitKind({ rateLimitType: 'five_hour' }), 'five_hour')
  assert.equal(limitKind({ rateLimitType: 'seven_day' }), 'weekly')
  assert.equal(limitKind({ rateLimitType: 'seven_day_opus' }), 'weekly_opus')
})

test('limitKind: từ câu thông báo của Claude Code', () => {
  assert.equal(limitKind({ text: "You've hit your 5-hour limit · resets 2:30pm (Asia/Ho_Chi_Minh)" }), 'five_hour')
  assert.equal(limitKind({ text: "You've hit your weekly limit · resets Nov 15" }), 'weekly')
  assert.equal(limitKind({ text: "You've hit your Opus weekly limit" }), 'weekly_opus')
  assert.equal(limitKind({ text: 'Claude AI usage limit reached|1794404400' }), 'unknown')
})

test('formatRemaining', () => {
  assert.equal(formatRemaining(30_000), 'chưa đầy 1 phút')
  assert.equal(formatRemaining(15 * 60_000), '15 phút')
  assert.equal(formatRemaining(80 * 60_000), '1 giờ 20 phút')
  assert.equal(formatRemaining(2 * 3600_000), '2 giờ')
  assert.equal(formatRemaining(27 * 3600_000), '1 ngày 3 giờ')
})

test('buildClaudeLimit: thông điệp 5 giờ có giờ reset', () => {
  const now = new Date(2026, 10, 13, 13, 10).getTime()
  const text = "You've hit your 5-hour limit · resets 2:30pm (Asia/Ho_Chi_Minh)"
  const hit = detectRateLimit({ result: { isError: true, text }, now })!
  const l = buildClaudeLimit({ hit, text, now })
  assert.equal(l.kind, 'five_hour')
  assert.equal(l.resetAt, new Date(2026, 10, 13, 14, 30).getTime())
  assert.equal(l.until, l.resetAt)
  assert.ok(isLimitActive(l, now))
  assert.ok(!isLimitActive(l, l.until + 1))
  const n = limitNotice(l, now, 2)
  assert.match(n.title, /5 giờ/)
  assert.match(n.body, /14:30/)
  assert.match(n.body, /1 giờ 20 phút/)
  assert.match(n.body, /2 task/)
})

test('buildClaudeLimit: không rõ giờ reset → ước lượng, câu chữ không bịa giờ', () => {
  const now = Date.now()
  const l = buildClaudeLimit({ hit: {}, event: { status: 'rejected', rateLimitType: 'seven_day' }, now })
  assert.equal(l.kind, 'weekly')
  assert.equal(l.resetAt, undefined)
  assert.equal(l.until, now + DEFAULT_WAIT_MS)
  assert.match(limitNotice(l, now).body, /Chưa rõ giờ/)
})
