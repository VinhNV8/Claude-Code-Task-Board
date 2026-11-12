import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_TAG,
  adjustSuggestion,
  computeModelStats,
  sampleOf,
  statKey,
  tagModelRows,
  type ModelStats,
} from './modelHistory.ts'
import { chooseRunModel, modelSuggestFor } from './model.ts'
import { computeStats } from './stats.ts'
import type { Suggestion } from './modelPicker.ts'
import type { ReviewAction, Run, Task } from './types.ts'

const D = 86_400_000
const NOW = Date.UTC(2026, 10, 12, 3, 0, 0)

let nextId = 1
interface Fixture {
  tasks: Task[]
  runs: Run[]
  reviews: ReviewAction[]
}
const empty = (): Fixture => ({ tasks: [], runs: [], reviews: [] })

/** Thêm một task đã có kết quả: 'approve' (duyệt ngay), 'changes' (sửa rồi mới duyệt), 'reject', 'failed'. */
function add(
  f: Fixture,
  o: { projectId?: string; tags?: string[]; model: string; outcome: 'approve' | 'changes' | 'reject' | 'failed'; at?: number; cost?: number; failedRun?: boolean },
) {
  const id = nextId++
  const at = o.at ?? NOW - D
  f.tasks.push({
    id,
    projectId: o.projectId ?? 'p1',
    title: `t${id}`,
    prompt: 'prompt',
    status: o.outcome === 'failed' || o.outcome === 'reject' ? 'failed' : 'done',
    priority: 'normal',
    permissionMode: 'acceptEdits',
    tags: o.tags ?? [],
    createdAt: at - 3600_000,
    updatedAt: at,
  })
  const run = (kind: Run['kind'], startedAt: number, extra: Partial<Run> = {}): Run => ({
    id: `r${id}-${kind}-${startedAt}`,
    taskId: id,
    kind,
    startedAt,
    endedAt: startedAt + 1000,
    exitCode: 0,
    costUsd: o.cost ?? 0.1,
    requestedModel: o.model,
    ...extra,
  })
  f.runs.push(run('initial', at - 3000_000, o.failedRun || o.outcome === 'failed' ? { exitCode: 1, failKind: 'claude' } : {}))
  if (o.failedRun) f.runs.push(run('retry', at - 2000_000))
  const review = (action: ReviewAction['action'], createdAt: number) =>
    f.reviews.push({ id: `rv${id}-${createdAt}`, taskId: id, action, createdAt })
  if (o.outcome === 'approve') review('approve', at)
  if (o.outcome === 'reject') review('reject', at)
  if (o.outcome === 'changes') {
    review('request_changes', at - 1000_000)
    f.runs.push(run('resume', at - 900_000))
    review('approve', at)
  }
}

const many = (f: Fixture, n: number, o: Parameters<typeof add>[1]) => {
  for (let i = 0; i < n; i++) add(f, o)
}

const stats = (f: Fixture) => computeModelStats(f.tasks, f.runs, f.reviews, NOW)
const sug = (model: Suggestion['model']): Suggestion => ({ model, score: 0, reasons: ['lý do Lớp 1'] })

test('computeModelStats: đếm duyệt ngay, chi phí TB, tier theo run đầu tiên', () => {
  const f = empty()
  many(f, 9, { tags: ['bugfix'], model: 'sonnet', outcome: 'approve', cost: 0.2 })
  add(f, { tags: ['bugfix'], model: 'sonnet', outcome: 'changes', cost: 0.2 }) // 2 run → 0.4
  const s = stats(f).get(statKey('p1', 'bugfix', 'sonnet'))!
  assert.equal(s.n, 10)
  assert.equal(s.approvedFirst, 9)
  assert.ok(Math.abs(s.avgCost - (9 * 0.2 + 0.4) / 10) < 1e-9)
})

test('sampleOf: run lỗi trước approve thì không tính là duyệt ngay; chưa có kết quả thì không phải mẫu', () => {
  const f = empty()
  add(f, { model: 'haiku', outcome: 'approve', failedRun: true })
  const t = f.tasks[0]
  const s = sampleOf(t, f.runs, f.reviews)!
  assert.equal(s.approvedFirst, false)
  assert.equal(s.tier, 'haiku')
  assert.deepEqual(s.tags, [NO_TAG])

  // Run lỗi do giới hạn sử dụng không phải lỗi của model
  const runs = f.runs.map((r) => (r.kind === 'initial' ? { ...r, failKind: 'rate_limit' as const } : r))
  assert.equal(sampleOf(t, runs, f.reviews)!.approvedFirst, true)

  assert.equal(sampleOf({ ...t, status: 'review' }, f.runs, []), undefined)
  // ID model đầy đủ cũng ra đúng bậc; model lạ thì bỏ qua
  assert.equal(sampleOf(t, f.runs.map((r) => ({ ...r, requestedModel: undefined, model: 'claude-opus-5-5' })), f.reviews)!.tier, 'opus')
  assert.equal(sampleOf(t, f.runs.map((r) => ({ ...r, requestedModel: 'claude-fable-5-2' })), f.reviews), undefined)
})

test('computeModelStats: chỉ xét mẫu trong 90 ngày, tách theo project và tag', () => {
  const f = empty()
  add(f, { tags: ['bugfix'], model: 'sonnet', outcome: 'approve', at: NOW - 91 * D })
  add(f, { tags: ['Bugfix', 'ui'], model: 'sonnet', outcome: 'approve' })
  add(f, { projectId: 'p2', tags: ['bugfix'], model: 'sonnet', outcome: 'reject' })
  const s = stats(f)
  assert.equal(s.get(statKey('p1', 'bugfix', 'sonnet'))!.n, 1)
  assert.equal(s.get(statKey('p1', 'ui', 'sonnet'))!.n, 1)
  assert.equal(s.get(statKey('p2', 'bugfix', 'sonnet'))!.approvedFirst, 0)
})

test('adjustSuggestion: 10 task bugfix Sonnet, 9 duyệt ngay → gợi ý Opus hạ thành Sonnet', () => {
  const f = empty()
  many(f, 9, { tags: ['bugfix'], model: 'sonnet', outcome: 'approve' })
  add(f, { tags: ['bugfix'], model: 'sonnet', outcome: 'reject' })
  const out = adjustSuggestion(sug('opus'), { projectId: 'p1', tags: ['bugfix'] }, stats(f))
  assert.equal(out.model, 'sonnet')
  assert.equal(out.reasons[0], 'lý do Lớp 1')
  assert.match(out.reasons.at(-1)!, /Lịch sử: 9\/10 task 'bugfix' dùng Sonnet được duyệt ngay/)
  // Project khác không bị ảnh hưởng
  assert.equal(adjustSuggestion(sug('opus'), { projectId: 'p2', tags: ['bugfix'] }, stats(f)).model, 'opus')
})

test('adjustSuggestion: chỉ 9 mẫu thì không đổi', () => {
  const f = empty()
  many(f, 9, { tags: ['bugfix'], model: 'sonnet', outcome: 'approve' })
  const s = sug('opus')
  assert.equal(adjustSuggestion(s, { projectId: 'p1', tags: ['bugfix'] }, stats(f)), s)
})

test('adjustSuggestion: Sonnet → Haiku khi nhóm Haiku tốt; chỉ dịch một bậc', () => {
  const f = empty()
  many(f, 10, { tags: ['docs'], model: 'haiku', outcome: 'approve' })
  assert.equal(adjustSuggestion(sug('sonnet'), { projectId: 'p1', tags: ['docs'] }, stats(f)).model, 'haiku')
  // Gợi ý Opus chỉ xét nhóm Sonnet (một bậc), không nhảy thẳng xuống Haiku
  assert.equal(adjustSuggestion(sug('opus'), { projectId: 'p1', tags: ['docs'] }, stats(f)).model, 'opus')
})

test('adjustSuggestion: rate 0,4 → nâng một bậc', () => {
  const f = empty()
  many(f, 4, { tags: ['bugfix'], model: 'haiku', outcome: 'approve' })
  many(f, 6, { tags: ['bugfix'], model: 'haiku', outcome: 'changes' })
  const out = adjustSuggestion(sug('haiku'), { projectId: 'p1', tags: ['bugfix'] }, stats(f))
  assert.equal(out.model, 'sonnet')
  assert.match(out.reasons.at(-1)!, /chỉ 4\/10 task 'bugfix' dùng Haiku được duyệt ngay → nâng lên Sonnet/)
  // Opus là trần
  const g = empty()
  many(g, 10, { tags: ['bugfix'], model: 'opus', outcome: 'reject' })
  assert.equal(adjustSuggestion(sug('opus'), { projectId: 'p1', tags: ['bugfix'] }, stats(g)).model, 'opus')
})

test('adjustSuggestion: task không tag dùng nhóm "(không tag)"', () => {
  const f = empty()
  many(f, 10, { model: 'sonnet', outcome: 'approve' })
  const out = adjustSuggestion(sug('opus'), { projectId: 'p1', tags: [] }, stats(f))
  assert.equal(out.model, 'sonnet')
  assert.match(out.reasons.at(-1)!, /task không tag dùng Sonnet/)
  // Task có tag không dùng nhóm không tag
  assert.equal(adjustSuggestion(sug('opus'), { projectId: 'p1', tags: ['x'] }, stats(f)).model, 'opus')
})

test('adjustSuggestion: xung đột nhiều tag → nâng thắng hạ, chỉ một bậc', () => {
  const f = empty()
  many(f, 10, { tags: ['docs'], model: 'haiku', outcome: 'approve' }) // docs: Haiku tốt → muốn hạ
  many(f, 10, { tags: ['security'], model: 'sonnet', outcome: 'reject' }) // security: Sonnet tệ → muốn nâng
  const out = adjustSuggestion(sug('sonnet'), { projectId: 'p1', tags: ['docs', 'security'] }, stats(f))
  assert.equal(out.model, 'opus')
  assert.equal(out.reasons.length, 2)
})

test('chooseRunModel / modelSuggestFor: Lớp 2 chỉ áp khi auto', () => {
  const toHaiku = (s: Suggestion): Suggestion => ({ ...s, model: 'haiku', reasons: [...s.reasons, 'Lịch sử'] })
  const t = { title: 'x', prompt: 'y', tags: [], permissionMode: 'acceptEdits' as const }
  const auto = chooseRunModel('initial', undefined, t, {}, { defaultModel: 'auto' }, toHaiku)
  assert.equal(auto.requestedModel, 'haiku')
  assert.match(auto.modelReason, /Lịch sử/)
  assert.equal(chooseRunModel('initial', undefined, { ...t, model: 'opus' }, {}, { defaultModel: 'auto' }, toHaiku).requestedModel, 'opus')
  assert.equal(modelSuggestFor(t, {}, { defaultModel: 'auto' }, toHaiku).suggestion?.model, 'haiku')
})

test('tagModelRows + computeStats.byTagModel: gộp project, lọc theo project và khoảng ngày', () => {
  const f = empty()
  many(f, 3, { tags: ['bugfix'], model: 'sonnet', outcome: 'approve', cost: 0.3 })
  add(f, { tags: ['bugfix'], model: 'sonnet', outcome: 'reject', cost: 0.1 })
  add(f, { projectId: 'p2', tags: ['bugfix'], model: 'sonnet', outcome: 'approve', cost: 0.5 })
  add(f, { model: 'haiku', outcome: 'approve', at: NOW - 20 * D })

  const all: ModelStats = stats(f)
  const rows = tagModelRows(all)
  assert.deepEqual(
    rows.map((r) => [r.tag, r.tier, r.n]),
    [
      ['bugfix', 'sonnet', 5],
      [NO_TAG, 'haiku', 1],
    ],
  )
  assert.equal(rows[0].approvalRate, 4 / 5)
  assert.ok(Math.abs(rows[0].avgCost - (0.9 + 0.1 + 0.5) / 5) < 1e-9)

  const data = { tasks: f.tasks, runs: [], historyRuns: f.runs, reviews: f.reviews, projects: [] }
  const s7 = computeStats(data, { days: 7, tzOffsetMin: 0, projectId: 'p1' }, NOW)
  assert.deepEqual(s7.byTagModel.map((r) => [r.tag, r.tier, r.n, r.approvalRate]), [['bugfix', 'sonnet', 4, 0.75]])
  const s30 = computeStats(data, { days: 30, tzOffsetMin: 0 }, NOW)
  assert.equal(s30.byTagModel.length, 2)
})
