import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TEMPLATES, TemplateError, validateTemplate } from './templates.ts'

// DB riêng trong bộ nhớ cho test (phải đặt trước khi import db.ts)
process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard-tpl-'))
process.env.TASKBOARD_DB = ':memory:'
const { projects, templates } = await import('./db.ts')

const has = (...ids: string[]) => (id: string) => ids.includes(id)
let n = 0
const newId = () => `tpl-new-${++n}`

test('validateTemplate: chuẩn hoá dữ liệu hợp lệ', () => {
  const t = validateTemplate(
    { name: '  Sửa lỗi ', title: ' Fix: ', prompt: 'Hãy sửa lỗi này giúp tôi', tags: [' bug ', '', 'bug', 'ui'], projectId: 'p1' },
    has('p1'),
    newId,
  )
  assert.equal(t.name, 'Sửa lỗi')
  assert.equal(t.title, 'Fix:')
  assert.deepEqual(t.tags, ['bug', 'ui'])
  assert.equal(t.projectId, 'p1')
  assert.match(t.id, /^tpl-new-/)
})

test('validateTemplate: giữ id có sẵn, projectId rỗng là template chung', () => {
  const t = validateTemplate({ id: 'tpl-x', name: 'A', prompt: '0123456789', projectId: '' }, has(), newId)
  assert.equal(t.id, 'tpl-x')
  assert.equal(t.projectId, undefined)
  assert.deepEqual(t.tags, [])
  assert.equal(t.title, '')
})

test('validateTemplate: báo lỗi tiếng Việt khi thiếu/sai dữ liệu', () => {
  const bad = (b: Parameters<typeof validateTemplate>[0], msg: RegExp) =>
    assert.throws(() => validateTemplate(b, has('p1'), newId), (e: unknown) => e instanceof TemplateError && msg.test(e.message))
  bad({ name: ' ', prompt: '0123456789' }, /tên template/)
  bad({ name: 'x'.repeat(41), prompt: '0123456789' }, /40 ký tự/)
  bad({ name: 'A', prompt: 'ngắn' }, /ít nhất 10 ký tự/)
  bad({ name: 'A', prompt: '0123456789', tags: 'bug' }, /danh sách/)
  bad({ name: 'A', prompt: '0123456789', projectId: 'p-khong-co' }, /Project không hợp lệ/)
})

test('db: nạp sẵn template mặc định khi tạo bảng', () => {
  const ids = templates.all().map((t) => t.id)
  assert.deepEqual(ids, DEFAULT_TEMPLATES.map((t) => t.id))
  assert.ok(ids.includes('tpl-bug') && ids.includes('tpl-test') && ids.includes('tpl-refactor'))
})

test('db: thêm, sửa, xoá template; xoá project thì xoá template riêng', () => {
  projects.upsert({ id: 'p-tpl', name: 'P', repoPath: 'C:\\repo', mainBranch: 'main', permissionMode: 'acceptEdits', allowedTools: [], maxParallel: 1, budgetAction: 'warn', deliveryMode: 'worktree' })
  const created = templates.upsert({ id: 'tpl-a', name: 'A', title: '', prompt: 'prompt dài hơn 10', tags: ['x'], projectId: 'p-tpl' })
  assert.deepEqual(created, { id: 'tpl-a', name: 'A', title: '', prompt: 'prompt dài hơn 10', tags: ['x'], projectId: 'p-tpl' })
  assert.equal(templates.all().at(-1)?.id, 'tpl-a')

  templates.upsert({ ...created, name: 'A2', projectId: undefined })
  assert.equal(templates.get('tpl-a')?.name, 'A2')
  assert.equal(templates.get('tpl-a')?.projectId, undefined)
  assert.equal(templates.all().at(-1)?.id, 'tpl-a', 'cập nhật không đổi thứ tự')

  templates.upsert({ ...created, id: 'tpl-b' })
  assert.deepEqual(templates.byProject('p-tpl').map((t) => t.id), ['tpl-b'])
  projects.remove('p-tpl')
  assert.equal(templates.get('tpl-b'), undefined)

  templates.remove('tpl-a')
  assert.equal(templates.get('tpl-a'), undefined)
})
