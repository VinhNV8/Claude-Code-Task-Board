import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StatsError, computeStats, dayKey, parseStatsQuery, startOfLocalDay, type StatsQuery } from './stats.ts'
import type { Project, Run, Task } from './types.ts'

const H = 3_600_000
const D = 24 * H
const VN = -420 // UTC+7 theo quy ước getTimezoneOffset
// 2026-11-12 10:00 giờ VN = 03:00 UTC
const NOW = Date.UTC(2026, 10, 12, 3, 0, 0)

const project = (id: string, name = id): Project => ({
  id,
  name,
  repoPath: 'C:\\repo',
  mainBranch: 'main',
  permissionMode: 'acceptEdits',
  allowedTools: [],
  maxParallel: 1,
  budgetAction: 'warn' as const,
  deliveryMode: 'worktree' as const,
})

const task = (id: number, projectId: string, status: Task['status'], createdAt: number, updatedAt = createdAt): Task => ({
  id,
  projectId,
  title: `t${id}`,
  prompt: 'prompt dài hơn 10 ký tự',
  status,
  priority: 'normal',
  permissionMode: 'acceptEdits',
  tags: [],
  createdAt,
  updatedAt,
})

const run = (id: string, taskId: number, startedAt: number, extra: Partial<Run> = {}): Run => ({
  id,
  taskId,
  kind: 'initial',
  startedAt,
  ...extra,
})

test('dayKey/startOfLocalDay: chia ngày theo giờ địa phương', () => {
  // 2026-11-11 18:30 UTC = 2026-11-12 01:30 giờ VN
  const ts = Date.UTC(2026, 10, 11, 18, 30)
  assert.equal(dayKey(ts, VN), '2026-11-12')
  assert.equal(dayKey(ts, 0), '2026-11-11')
  assert.equal(startOfLocalDay(ts, VN), Date.UTC(2026, 10, 11, 17, 0))
})

test('parseStatsQuery: mặc định 7 ngày, kiểm tra tham số và báo lỗi tiếng Việt', () => {
  const exists = (id: string) => id === 'p1'
  assert.deepEqual(parseStatsQuery({}, exists), { days: 7, tzOffsetMin: 0, projectId: undefined })
  assert.deepEqual(parseStatsQuery({ days: '30', tz: '-420', projectId: 'p1' }, exists), { days: 30, tzOffsetMin: -420, projectId: 'p1' })
  const bad = (q: StatsQuery, re: RegExp) => assert.throws(() => parseStatsQuery(q, exists), (e: unknown) => e instanceof StatsError && re.test(e.message))
  bad({ days: '14' }, /7, 30 hoặc 90/)
  bad({ days: 'abc' }, /7, 30 hoặc 90/)
  bad({ tz: '99999' }, /Múi giờ/)
  bad({ tz: '1.5' }, /Múi giờ/)
  bad({ projectId: 'nope' }, /Project không hợp lệ/)
})

test('computeStats: đủ số ngày, tổng hợp theo ngày, project và trạng thái', () => {
  const today = startOfLocalDay(NOW, VN)
  const data = {
    projects: [project('p1', 'Alpha'), project('p2', 'Beta')],
    tasks: [
      task(1, 'p1', 'done', today + H, today + 2 * H),
      task(2, 'p1', 'failed', today - D + H, today - D + 3 * H),
      task(3, 'p2', 'review', today - 2 * D),
      task(4, 'p2', 'backlog', today - 10 * D), // ngoài khoảng 7 ngày
    ],
    runs: [
      run('r1', 1, today + H, { endedAt: today + H + 60_000, costUsd: 0.5, numTurns: 4 }),
      run('r2', 2, today - D + H, { endedAt: today - D + H + 30_000, costUsd: 0.25, numTurns: 2 }),
      run('r3', 2, today - D + 2 * H, { costUsd: 0.1 }), // chưa kết thúc: không tính thời gian
      run('r4', 3, today - 2 * D, { endedAt: today - 2 * D + 1000, costUsd: 1 }),
      run('r5', 4, today - 10 * D, { endedAt: today - 10 * D + 1000, costUsd: 9 }), // ngoài khoảng
    ],
  }
  const s = computeStats(data, { days: 7, tzOffsetMin: VN }, NOW)

  assert.equal(s.from, today - 6 * D)
  assert.equal(s.daily.length, 7)
  assert.equal(s.daily[6].date, '2026-11-12')
  assert.equal(s.daily[0].date, '2026-11-06')

  assert.equal(s.totals.tasks, 3)
  assert.equal(s.totals.byStatus.done, 1)
  assert.equal(s.totals.byStatus.failed, 1)
  assert.equal(s.totals.byStatus.review, 1)
  assert.equal(s.totals.byStatus.backlog, 0)
  assert.equal(s.totals.runs, 4)
  assert.ok(Math.abs(s.totals.costUsd - 1.85) < 1e-9)
  assert.equal(s.totals.turns, 6)
  assert.equal(s.totals.durationMs, 60_000 + 30_000 + 1000)

  const d12 = s.daily[6]
  assert.deepEqual([d12.created, d12.done, d12.failed, d12.runs, d12.turns, d12.durationMs], [1, 1, 0, 1, 4, 60_000])
  const d11 = s.daily[5]
  assert.deepEqual([d11.created, d11.failed, d11.runs], [1, 1, 2])
  assert.ok(Math.abs(d11.costUsd - 0.35) < 1e-9)

  // Sắp theo chi phí giảm dần
  assert.deepEqual(
    s.projects.map((p) => [p.name, p.tasks, p.runs]),
    [
      ['Beta', 1, 1],
      ['Alpha', 2, 3],
    ],
  )
})

test('computeStats: lọc theo project và khoảng 90 ngày', () => {
  const today = startOfLocalDay(NOW, 0)
  const data = {
    projects: [project('p1'), project('p2')],
    tasks: [task(1, 'p1', 'done', today - 40 * D), task(2, 'p2', 'done', today - 5 * D)],
    runs: [run('a', 1, today - 40 * D, { costUsd: 2 }), run('b', 2, today - 5 * D, { costUsd: 3 })],
  }
  const s = computeStats(data, { days: 90, tzOffsetMin: 0, projectId: 'p1' }, NOW)
  assert.equal(s.daily.length, 90)
  assert.equal(s.projectId, 'p1')
  assert.equal(s.totals.tasks, 1)
  assert.equal(s.totals.costUsd, 2)
  assert.deepEqual(s.projects.map((p) => p.projectId), ['p1'])
  // Project đã xoá khỏi danh sách: dùng id làm tên
  const s2 = computeStats({ ...data, projects: [] }, { days: 30, tzOffsetMin: 0 }, NOW)
  assert.deepEqual(s2.projects.map((p) => p.name), ['p2'])
})
