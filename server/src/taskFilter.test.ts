// Test logic lọc board của web (file thuần, không phụ thuộc DOM/React)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_FILTER,
  activeChips,
  activeFilterCount,
  clearFilters,
  removeChip,
  toggleValue,
  togglePriority,
  collectTags,
  filterToParams,
  isFilterActive,
  matchTask,
  normalizeTags,
  parseFilter,
  splitTags,
  suggestTags,
  type BoardFilter,
} from '../../web/src/lib/taskFilter.ts'

const T = (over: Partial<Parameters<typeof matchTask>[0]> = {}) => ({
  id: 12,
  projectId: 'p1',
  title: 'Sửa lỗi đăng nhập',
  prompt: 'Thông báo không hiện khi nhập sai mật khẩu',
  priority: 'high',
  tags: ['bug', 'UI'],
  ...over,
})
const F = (over: Partial<BoardFilter> = {}): BoardFilter => ({ ...EMPTY_FILTER, ...over })

test('parseFilter/filterToParams: đi vòng qua URL không mất dữ liệu', () => {
  const f = F({ q: 'sửa lỗi', projectId: 'p 1', tags: ['bug', 'ui fix'], priorities: ['high', 'urgent'], showAll: true })
  const qs = filterToParams(f).toString()
  const back = parseFilter(new URLSearchParams(qs))
  // priorities được sắp theo thứ tự chuẩn
  assert.deepEqual(back, { ...f, priorities: ['urgent', 'high'] })
})

test('parseFilter: bỏ giá trị không hợp lệ, URL rỗng = không lọc', () => {
  assert.deepEqual(parseFilter(new URLSearchParams('')), EMPTY_FILTER)
  const f = parseFilter(new URLSearchParams('priority=high,xxx&tags=a,,A,b&all=0'))
  assert.deepEqual(f.priorities, ['high'])
  assert.deepEqual(f.tags, ['a', 'b'])
  assert.equal(f.showAll, false)
  assert.equal(filterToParams(EMPTY_FILTER).toString(), '')
})

test('matchQuery: tìm theo tiêu đề, prompt, tag, không dấu và #id', () => {
  assert.ok(matchTask(T(), F({ q: 'đăng nhập' })))
  assert.ok(matchTask(T(), F({ q: 'sua loi' })), 'không dấu vẫn khớp')
  assert.ok(matchTask(T(), F({ q: 'MẬT KHẨU' })), 'khớp prompt')
  assert.ok(matchTask(T(), F({ q: 'ui' })), 'khớp tag')
  assert.ok(matchTask(T(), F({ q: 'lỗi khẩu' })), 'nhiều từ: đủ mọi từ')
  assert.ok(!matchTask(T(), F({ q: 'lỗi thanh toán' })))
  assert.ok(matchTask(T(), F({ q: '#12' })))
  assert.ok(!matchTask(T(), F({ q: '#1' })), '#id phải khớp chính xác')
  assert.ok(matchTask(T(), F({ q: '12' })))
  assert.ok(matchTask(T({ id: 3, title: 'Nâng cấp lên v12' }), F({ q: '12' })), 'số trơn còn khớp chữ')
})

test('matchTask: kết hợp project, ưu tiên và tag (tag phải có đủ)', () => {
  assert.ok(matchTask(T(), F({ projectId: 'p1', priorities: ['high'], tags: ['ui', 'BUG'], q: 'sua' })))
  assert.ok(!matchTask(T(), F({ projectId: 'p2' })))
  assert.ok(!matchTask(T(), F({ priorities: ['low', 'normal'] })))
  assert.ok(matchTask(T(), F({ priorities: ['low', 'high'] })))
  assert.ok(!matchTask(T(), F({ tags: ['bug', 'backend'] })))
  assert.ok(!matchTask(T(), F({ tags: ['bug'], q: 'thanh toán' })))
})

test('isFilterActive', () => {
  assert.ok(!isFilterActive(EMPTY_FILTER))
  assert.ok(!isFilterActive(F({ showAll: true, q: '   ' })))
  assert.ok(isFilterActive(F({ tags: ['x'] })))
})

test('normalizeTags/splitTags', () => {
  assert.deepEqual(normalizeTags([' a ', 'A', '', 'b  c']), ['a', 'b c'])
  assert.deepEqual(splitTags('bug, ui ,, Bug'), ['bug', 'ui'])
})

test('collectTags + suggestTags: dùng nhiều lên trước, khớp đầu chuỗi trước', () => {
  const all = collectTags([['ui', 'bug'], ['Bug', 'backend'], ['bug', 'debug']])
  assert.deepEqual(all, ['bug', 'backend', 'debug', 'ui'])
  assert.deepEqual(suggestTags(all, ['ui'], ''), ['bug', 'backend', 'debug'])
  assert.deepEqual(suggestTags(all, [], 'b'), ['bug', 'backend', 'debug'])
  assert.deepEqual(suggestTags(all, ['BUG'], 'bu'), ['debug'])
  assert.deepEqual(suggestTags(all, [], 'g', 1), ['bug'])
})

test('activeFilterCount: đếm project, từng ưu tiên, từng tag, showAll; không đếm từ khoá', () => {
  assert.equal(activeFilterCount(EMPTY_FILTER), 0)
  assert.equal(activeFilterCount(F({ q: 'abc' })), 0)
  assert.equal(activeFilterCount(F({ projectId: 'p1', priorities: ['high', 'low'], tags: ['a', 'b', 'c'], showAll: true })), 7)
})

test('toggleValue/togglePriority: bật tắt, không phân biệt hoa thường, giữ thứ tự chuẩn', () => {
  assert.deepEqual(toggleValue(['bug'], 'ui'), ['bug', 'ui'])
  assert.deepEqual(toggleValue(['bug', 'ui'], 'BUG'), ['ui'])
  assert.deepEqual(togglePriority([], 'low'), ['low'])
  assert.deepEqual(togglePriority(['low'], 'urgent'), ['urgent', 'low'])
  assert.deepEqual(togglePriority(['urgent', 'low'], 'urgent'), ['low'])
})

test('activeChips/removeChip: gỡ từng chip, chỉ ảnh hưởng đúng nhóm đó', () => {
  const f = F({ q: 'x', projectId: 'p1', priorities: ['urgent', 'low'], tags: ['Bug', 'ui'], showAll: true })
  const chips = activeChips(f)
  assert.deepEqual(chips.map((c) => `${c.kind}:${c.value}`), ['project:p1', 'priority:urgent', 'priority:low', 'tag:Bug', 'tag:ui'])
  assert.deepEqual(removeChip(f, { kind: 'project', value: 'p1' }), { ...f, projectId: null })
  assert.deepEqual(removeChip(f, { kind: 'priority', value: 'urgent' }).priorities, ['low'])
  assert.deepEqual(removeChip(f, { kind: 'tag', value: 'bug' }).tags, ['ui'], 'gỡ tag không phân biệt hoa thường')
  assert.deepEqual(activeChips(EMPTY_FILTER), [])
})

test('clearFilters: giữ hoặc bỏ từ khoá', () => {
  const f = F({ q: 'abc', projectId: 'p1', tags: ['a'], priorities: ['high'], showAll: true })
  assert.deepEqual(clearFilters(f), { ...EMPTY_FILTER, q: 'abc' })
  assert.deepEqual(clearFilters(f, false), EMPTY_FILTER)
})
