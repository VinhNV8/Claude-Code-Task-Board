// Chỉ test phần thuần: claudeLimitWatch.ts import 'vscode' nên kiểm tra qua lib dùng chung.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatResetAt, limitNotice } from '../../web/src/lib/claudeLimit.ts'

test('giờ có lượt lại: hôm nay chỉ ghi giờ, ngày mai ghi rõ', () => {
  const now = new Date(2026, 10, 13, 13, 10).getTime()
  assert.equal(formatResetAt(new Date(2026, 10, 13, 14, 30).getTime(), now), '14:30')
  assert.equal(formatResetAt(new Date(2026, 10, 14, 9, 5).getTime(), now), '09:05 ngày mai')
  assert.match(formatResetAt(new Date(2026, 10, 16, 9, 0).getTime(), now), /^09:00 .+ 16\/11$/)
})

test('nội dung thông báo hết lượt tuần', () => {
  const now = Date.now()
  const n = limitNotice({ kind: 'weekly', resetAt: now + 3 * 86_400_000, until: now + 3 * 86_400_000, since: now }, now)
  assert.match(n.title, /tuần này/)
  assert.match(n.body, /3 ngày/)
})
