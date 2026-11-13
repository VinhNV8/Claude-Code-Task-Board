// C-02 (FR-08): hàm thuần về phụ thuộc giữa task (web/src/lib/deps.ts) và thứ tự cột Queued.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BLOCKED_BY_INSTRUCTION,
  findCycle,
  parseBlockedBy,
  parseRefs,
  resolveRefs,
  sortByDeps,
  taskCode,
  unmetDeps,
} from '../../web/src/lib/deps.ts'
import { columnTasks } from '../../web/src/lib/board.ts'
import type { Task, TaskStatus } from './types.ts'

test('taskCode: lấy mã [..] ở đầu tiêu đề, viết hoa', () => {
  assert.equal(taskCode('[P5-01] Lưu model'), 'P5-01')
  assert.equal(taskCode('  [p5-06b] Nối escalation'), 'P5-06B')
  assert.equal(taskCode('[C-02] Phụ thuộc'), 'C-02')
  assert.equal(taskCode('Không có mã [P5-01]'), undefined)
  assert.equal(taskCode('Sửa lỗi'), undefined)
})

test('parseRefs: #id và mã task, bỏ chuỗi giống mã nhưng không phải (utf-8, x-1, a-b)', () => {
  const r = parseRefs('Làm sau #35 và P5-06, xem thêm C-02; encoding utf-8, x-1, issue-12, mã P5-06b. Màu #fff, &#39;')
  assert.deepEqual(r.ids, [35])
  assert.deepEqual(r.codes, ['P5-06', 'C-02', 'P5-06B'])
  assert.deepEqual(parseRefs('không nhắc gì'), { ids: [], codes: [] })
})

const T = (id: number, title: string, projectId = 'p1') => ({ id, title, projectId })

test('resolveRefs: chỉ task cùng project, bỏ chính nó, không trùng, theo thứ tự', () => {
  const all = [T(35, '[P5-01] A'), T(40, '[P5-06] B'), T(41, '[P5-06] khác project', 'p2'), T(50, '[C-02] C')]
  assert.deepEqual(resolveRefs({ ids: [40, 99, 41], codes: ['P5-06', 'C-02', 'P9-99'] }, all, 'p1'), [40, 50])
  assert.deepEqual(resolveRefs({ ids: [50], codes: ['C-02'] }, all, 'p1', 50), [])
})

test('parseBlockedBy: lấy dòng BLOCKED_BY cuối, tách tham chiếu và lý do', () => {
  const text = 'Đã kiểm tra.\nBLOCKED_BY: #12; nháp\n\nKết luận...\n**BLOCKED_BY: P5-06, #40; runner chưa gọi decideEscalation**'
  const r = parseBlockedBy(text)!
  assert.deepEqual(r.refs, { ids: [40], codes: ['P5-06'] })
  assert.equal(r.reason, 'runner chưa gọi decideEscalation')
  assert.deepEqual(parseBlockedBy('blocked_by: P7-04')?.refs.codes, ['P7-04'])
  assert.equal(parseBlockedBy('BLOCKED_BY: ; không có mã'), null)
  assert.equal(parseBlockedBy('Hoàn thành'), null)
  assert.equal(parseBlockedBy(undefined), null)
})

test('unmetDeps: chỉ task được chờ chưa Done, bỏ id không còn tồn tại', () => {
  const st: Record<number, TaskStatus> = { 1: 'done', 2: 'review', 3: 'failed' }
  assert.deepEqual(unmetDeps({ dependsOn: [1, 2, 3, 99] }, (id) => st[id]), [2, 3])
  assert.deepEqual(unmetDeps({}, (id) => st[id]), [])
})

test('findCycle: phát hiện vòng tròn trực tiếp, gián tiếp, tự chờ chính nó', () => {
  const g: Record<number, number[]> = { 2: [3], 3: [4], 4: [] }
  const depsOf = (id: number) => g[id] ?? []
  assert.equal(findCycle(1, [2], depsOf), null)
  assert.deepEqual(findCycle(4, [2], depsOf), [4, 2, 3, 4])
  assert.deepEqual(findCycle(3, [2], depsOf), [3, 2, 3])
  assert.deepEqual(findCycle(5, [5], depsOf), [5, 5])
})

type Q = Pick<Task, 'id' | 'priority' | 'createdAt' | 'dependsOn'>
const q = (id: number, priority: Task['priority'], createdAt: number, dependsOn?: number[]): Q => ({ id, priority, createdAt, dependsOn })

test('sortByDeps: task đang chờ đứng sau task nó chờ, kể cả khi ưu tiên cao hơn', () => {
  const list = [q(49, 'urgent', 5, [48]), q(48, 'normal', 4), q(41, 'low', 1, [99]), q(47, 'high', 3)]
  // 99 không có trong danh sách → 41 coi như sẵn sàng; 49 (urgent) phải sau 48
  assert.deepEqual(
    sortByDeps(list).map((t) => t.id),
    [47, 48, 49, 41],
  )
  // Chuỗi dài A ← B ← C, cùng ưu tiên
  assert.deepEqual(sortByDeps([q(3, 'normal', 1, [2]), q(2, 'normal', 2, [1]), q(1, 'normal', 3)]).map((t) => t.id), [1, 2, 3])
  // Vòng tròn (không nên có) vẫn hiện, xếp cuối
  assert.deepEqual(sortByDeps([q(1, 'normal', 1, [2]), q(2, 'normal', 2, [1]), q(3, 'low', 3)]).map((t) => t.id), [3, 1, 2])
})

test('columnTasks: cột Queued dùng thứ tự phụ thuộc', () => {
  const base = { updatedAt: 0, status: 'queued' as const }
  const list = [
    { ...q(10, 'high', 1, [11]), ...base },
    { ...q(11, 'normal', 2), ...base },
    { ...q(12, 'urgent', 3), ...base, status: 'backlog' as const },
  ]
  assert.deepEqual(columnTasks(list, 'queued', { hideOld: false }).map((t) => t.id), [11, 10])
})

test('BLOCKED_BY_INSTRUCTION: một dòng, không có dấu nháy kép (an toàn khi truyền tham số trên Windows)', () => {
  assert.ok(!BLOCKED_BY_INSTRUCTION.includes('\n'))
  assert.ok(!BLOCKED_BY_INSTRUCTION.includes('"'))
  assert.match(BLOCKED_BY_INSTRUCTION, /BLOCKED_BY:/)
})
