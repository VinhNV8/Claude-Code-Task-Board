import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StreamParser, type ResultInfo } from './stream.ts'
import {
  DEFAULT_WAIT_MS,
  MAX_RATE_LIMIT_RETRIES,
  decideRateLimit,
  detectRateLimit,
  looksRateLimited,
  orderQueue,
  parseResetTime,
  retryAt,
  type RateLimitEvent,
} from './rateLimit.ts'
import type { Priority } from './types.ts'

const fx = (name: string) => readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8').trim().split('\n')

/** Chạy parser qua fixture, lấy result và rate_limit_event cuối như runner. */
function parseRun(name: string) {
  const p = new StreamParser('C:\\nowhere')
  let result: ResultInfo | undefined
  let rateLimitEvent: RateLimitEvent | undefined
  for (const line of fx(name)) {
    const r = p.parseLine(line)
    if (r.result) result = r.result
    if (r.rateLimit) rateLimitEvent = r.rateLimit
  }
  return { result, rateLimitEvent }
}

// 2026-11-12 10:00 giờ máy
const NOW = new Date(2026, 10, 12, 10, 0, 0).getTime()
const err = (text: string, apiErrorStatus: number | null = null) => ({ isError: true, text, apiErrorStatus })

// ---------------------------------------------------------------- nhận diện

test('fixtures thật (status allowed) không bị coi là rate limit', () => {
  for (const name of ['simple.jsonl', 'tools.jsonl', 'resume.jsonl', 'permission-denied.jsonl', 'permission-tool-allow.jsonl']) {
    const { result, rateLimitEvent } = parseRun(name)
    assert.equal(rateLimitEvent?.status, 'allowed', name)
    assert.equal(rateLimitEvent?.resetsAt, 1794404400 * 1000, name)
    assert.equal(detectRateLimit({ result, rateLimitEvent, now: NOW }), undefined, name)
  }
})

test('fixture rate-limit: event rejected + "usage limit reached|epoch" → đọc giờ reset', () => {
  const { result, rateLimitEvent } = parseRun('rate-limit.jsonl')
  assert.equal(rateLimitEvent?.status, 'rejected')
  assert.equal(result?.isError, true)
  const hit = detectRateLimit({ result, rateLimitEvent, now: NOW })
  assert.deepEqual(hit, { resetAt: 1794404400 * 1000 })
})

test('api_error_status 429 là rate limit, không có giờ reset', () => {
  assert.deepEqual(detectRateLimit({ result: err('API Error', 429), now: NOW }), {})
})

test('event rejected (không có thông điệp) → dùng resetsAt của event nếu còn ở tương lai', () => {
  const resetsAt = NOW + 2 * 3600_000
  assert.deepEqual(detectRateLimit({ result: err('Kết thúc với lỗi'), rateLimitEvent: { status: 'rejected', resetsAt }, now: NOW }), { resetAt: resetsAt })
  assert.deepEqual(detectRateLimit({ rateLimitEvent: { status: 'rejected', resetsAt: NOW - 1000 }, now: NOW }), {})
})

test('thông điệp usage limit trong stderr (không có result)', () => {
  const hit = detectRateLimit({ stderr: "Error: You've hit your limit · resets 3pm (Asia/Saigon)", now: NOW })
  assert.equal(hit?.resetAt, new Date(2026, 10, 12, 15, 0).getTime())
})

test('các mẫu thông điệp', () => {
  for (const s of [
    'Claude AI usage limit reached|1794404400',
    "You've hit your limit · resets 3pm",
    '5-hour limit reached ∙ resets 10am',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
    'Request rate limited, please retry',
    '429 Too Many Requests',
  ])
    assert.ok(looksRateLimited(s), s)
  for (const s of ['Hoàn thành', 'Kết thúc với lỗi (error_max_turns)', 'ENOENT: claude.exe', 'rate_limit_event', 'API Error: 500', ''])
    assert.ok(!looksRateLimited(s), s)
})

test('result không lỗi có nhắc tới "rate limit" (Claude đang làm task về rate limit) không bị nhận nhầm', () => {
  const result = { isError: false, text: 'Đã thêm rate limit cho API', apiErrorStatus: null }
  assert.equal(detectRateLimit({ result, now: NOW }), undefined)
})

test('lỗi khác (max turns, CLI crash) không phải rate limit', () => {
  assert.equal(detectRateLimit({ result: err('Kết thúc với lỗi (error_max_turns)'), stderr: 'boom', now: NOW }), undefined)
  assert.equal(detectRateLimit({ stderr: 'spawn ENOENT', now: NOW }), undefined)
})

// ---------------------------------------------------------------- giờ reset

test('parseResetTime: epoch giây/ms sau dấu |', () => {
  assert.equal(parseResetTime('usage limit reached|1794404400', NOW), 1794404400_000)
  assert.equal(parseResetTime('usage limit reached|1794404400123', NOW), 1794404400123)
})

test('parseResetTime: giờ 12h/24h, qua ngày nếu đã qua', () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()
  assert.equal(parseResetTime('resets 3pm', NOW), at(12, 15))
  assert.equal(parseResetTime('resets 3:30 PM (Asia/Saigon)', NOW), at(12, 15, 30))
  assert.equal(parseResetTime('resets at 15:45', NOW), at(12, 15, 45))
  assert.equal(parseResetTime('resets 12am', NOW), at(13, 0))
  assert.equal(parseResetTime('resets 12pm', NOW), at(12, 12))
  assert.equal(parseResetTime('resets 9am', NOW), at(13, 9)) // 9h sáng đã qua → ngày mai
  assert.equal(parseResetTime('resets at 10:00', NOW), at(13, 10)) // đúng giờ hiện tại → ngày mai
})

test('parseResetTime: không đọc được', () => {
  assert.equal(parseResetTime('usage limit reached', NOW), undefined)
  assert.equal(parseResetTime('resets 5', NOW), undefined)
  assert.equal(parseResetTime('resets 13pm', NOW), undefined)
  assert.equal(parseResetTime('resets 25:00', NOW), undefined)
  assert.equal(parseResetTime(undefined, NOW), undefined)
})

test('retryAt: sau giờ reset 1 phút; không có/đã qua → chờ 15 phút', () => {
  assert.equal(retryAt({ resetAt: NOW + 3600_000 }, NOW), NOW + 3600_000 + 60_000)
  assert.equal(retryAt({}, NOW), NOW + DEFAULT_WAIT_MS)
  assert.equal(retryAt({ resetAt: NOW - 1 }, NOW), NOW + DEFAULT_WAIT_MS)
  assert.equal(DEFAULT_WAIT_MS, 15 * 60_000)
})

test('decideRateLimit: tối đa 3 lần tự thử lại rồi Failed', () => {
  assert.equal(MAX_RATE_LIMIT_RETRIES, 3)
  for (let n = 0; n < MAX_RATE_LIMIT_RETRIES; n++) {
    const d = decideRateLimit({}, n, NOW)
    assert.deepEqual(d, { action: 'requeue', notBefore: NOW + DEFAULT_WAIT_MS, attempt: n + 1 })
  }
  const d = decideRateLimit({}, MAX_RATE_LIMIT_RETRIES, NOW)
  assert.equal(d.action, 'fail')
  assert.match(d.action === 'fail' ? d.failReason : '', /giới hạn sử dụng.*3 lần/)
})

// ---------------------------------------------------------------- hàng đợi

const q = (id: number, priority: Priority, createdAt: number, notBefore?: number) => ({ id, priority, createdAt, notBefore })

test('orderQueue: ưu tiên rồi createdAt', () => {
  const { ready, wakeAt } = orderQueue([q(1, 'low', 1), q(2, 'normal', 3), q(3, 'urgent', 5), q(4, 'normal', 2), q(5, 'high', 9)], NOW)
  assert.deepEqual(
    ready.map((t) => t.id),
    [3, 5, 4, 2, 1],
  )
  assert.equal(wakeAt, undefined)
})

test('orderQueue: bỏ qua task chưa tới giờ, wakeAt = notBefore sớm nhất', () => {
  const { ready, wakeAt } = orderQueue(
    [q(1, 'urgent', 1, NOW + 60_000), q(2, 'normal', 2), q(3, 'high', 3, NOW + 30_000), q(4, 'low', 4, NOW - 1), q(5, 'normal', 5, NOW)],
    NOW,
  )
  // Task urgent đang chờ không chặn task khác; task đã tới giờ (<= now) được chạy theo thứ tự thường.
  assert.deepEqual(
    ready.map((t) => t.id),
    [2, 5, 4],
  )
  assert.equal(wakeAt, NOW + 30_000)
})

test('orderQueue: tới giờ thì task chờ được xếp lại đúng ưu tiên', () => {
  const tasks = [q(1, 'normal', 1), q(2, 'urgent', 2, NOW + 60_000)]
  assert.deepEqual(
    orderQueue(tasks, NOW + 60_000).ready.map((t) => t.id),
    [2, 1],
  )
})
