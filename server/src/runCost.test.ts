import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateCumulative, perRunUsage, sessionBaseline, subtractUsage } from './runCost.ts'
import type { ModelUsage } from './types.ts'

const u = (costUsd: number, cacheCreationInputTokens = 0, outputTokens = 0): ModelUsage => ({
  inputTokens: 0,
  outputTokens,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens,
  costUsd,
})

// Số đo thật ở PLAN "Kết quả kiểm thử P5": phiên đầu $0,00330, resume Haiku báo cộng dồn $0,00639.
test('perRunUsage: resume cùng model chỉ còn chi phí của lần chạy', () => {
  const base = { costUsd: 0.0033, modelUsage: { haiku: u(0.0033, 14470, 10) } }
  const own = perRunUsage({ costUsd: 0.00639, modelUsage: { haiku: u(0.00639, 14801, 15) } }, base)
  assert.ok(Math.abs(own.costUsd! - 0.00309) < 1e-9)
  assert.equal(own.modelUsage!.haiku.cacheCreationInputTokens, 331)
  assert.equal(own.modelUsage!.haiku.outputTokens, 5)
})

test('perRunUsage: resume đổi sang Sonnet thì dòng Haiku cũ không còn trong run mới', () => {
  const base = { costUsd: 0.0033, modelUsage: { haiku: u(0.0033) } }
  const own = perRunUsage({ costUsd: 0.06622, modelUsage: { haiku: u(0.0033), sonnet: u(0.06292) } }, base)
  assert.deepEqual(Object.keys(own.modelUsage!), ['sonnet'])
  assert.ok(Math.abs(own.costUsd! - 0.06292) < 1e-9)
})

test('perRunUsage: không có mốc thì giữ nguyên, số âm về 0', () => {
  const r = { costUsd: 1, modelUsage: { a: u(1) } }
  assert.equal(perRunUsage(r, undefined), r)
  assert.equal(perRunUsage({ costUsd: 0.5 }, { costUsd: 1 }).costUsd, 0)
  assert.deepEqual(subtractUsage({ a: u(1) }, { a: u(2) }), {})
})

test('sessionBaseline: lấy run trước gần nhất cùng phiên có số liệu; run cũ dùng costUsd làm số cộng dồn', () => {
  const runs = [
    { id: 'r1', sessionId: 's', startedAt: 1, costUsd: 1, sessionCostUsd: 1 },
    { id: 'r2', sessionId: 's', startedAt: 2, costUsd: 0.5, sessionCostUsd: 1.5 },
    { id: 'r3', sessionId: 's', startedAt: 3 }, // bị dừng, không có số liệu
    { id: 'x', sessionId: 'other', startedAt: 4, costUsd: 9 },
    { id: 'r4', sessionId: 's', startedAt: 5 },
  ]
  assert.equal(sessionBaseline('r4', 's', runs)?.costUsd, 1.5)
  assert.equal(sessionBaseline('r4', 's', [{ id: 'old', sessionId: 's', startedAt: 1, costUsd: 2 }])?.costUsd, 2)
  assert.equal(sessionBaseline('r4', undefined, runs), undefined)
  assert.equal(sessionBaseline('r1', 's', runs.slice(0, 1)), undefined)
})

test('migrateCumulative: dữ liệu cũ (số cộng dồn) thành số của riêng từng run', () => {
  const fixes = migrateCumulative([
    { id: 'b', sessionId: 's', startedAt: 2, costUsd: 3, modelUsage: { m: u(3) } },
    { id: 'a', sessionId: 's', startedAt: 1, costUsd: 1, modelUsage: { m: u(1) } },
    { id: 'c', sessionId: 's', startedAt: 3 },
    { id: 'd', sessionId: 's', startedAt: 4, costUsd: 6, modelUsage: { m: u(6) } },
    { id: 'z', sessionId: 't', startedAt: 1, costUsd: 4 },
  ])
  const by = Object.fromEntries(fixes.map((f) => [f.id, f]))
  assert.equal(by.a.cost, 1)
  assert.equal(by.b.cost, 2)
  assert.equal(by.d.cost, 3)
  assert.equal(by.d.usage!.m.costUsd, 3)
  assert.equal(by.d.sessionCost, 6)
  assert.equal(by.z.cost, 4)
  assert.equal(by.c, undefined)
})
