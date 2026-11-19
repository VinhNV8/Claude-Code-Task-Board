// FR-49: phạm vi ghi của task: so khớp mẫu, ràng buộc trong prompt, lưu qua API và import. DB in-memory, không spawn agent.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard scope '))
process.env.TASKBOARD_DB = ':memory:'
const { projects, tasks } = await import('./db.ts')
const { routes } = await import('./routes.ts')
const { inScope, normalizeScope, outOfScope, scopeProblem, withScope } = await import('../../web/src/lib/writeScope.ts')
const { mapTable } = await import('../../web/src/lib/taskImport.ts')
const { default: Fastify } = await import('fastify')
import type { Task } from './types.ts'

const app = Fastify()
await app.register(routes)
after(async () => {
  await app.close()
})

projects.upsert({
  id: 'p1',
  name: 'p1',
  repoPath: process.env.TASKBOARD_DATA!,
  mainBranch: 'main',
  permissionMode: 'acceptEdits',
  allowedTools: [],
  maxParallel: 1,
  budgetAction: 'warn',
  deliveryMode: 'direct',
})

test('normalizeScope: tách dấu phẩy/chấm phẩy/xuống dòng, đổi \\ thành /, bỏ ./ đầu và trùng', () => {
  assert.deepEqual(normalizeScope(' docs/** , ./README.md;docs\\guide\n\ndocs/**'), ['docs/**', 'README.md', 'docs/guide'])
  assert.deepEqual(normalizeScope(['a', ' a ', '']), ['a'])
  assert.deepEqual(normalizeScope(null), [])
})

test('scopeProblem: chặn đường dẫn tuyệt đối, "..", quá nhiều mẫu', () => {
  assert.equal(scopeProblem(['docs/**', '*.md']), undefined)
  assert.match(scopeProblem(['/etc/x'])!, /tương đối/)
  assert.match(scopeProblem(['C:/x'])!, /tương đối/)
  assert.match(scopeProblem(['docs/../src'])!, /\.\./)
  assert.match(scopeProblem(Array.from({ length: 21 }, (_, i) => `d${i}`))!, /tối đa 20/)
})

test('inScope: thư mục, glob, mẫu không có / so với tên file', () => {
  const cases: [string, string[], boolean][] = [
    ['docs/a.md', ['docs/**'], true],
    ['docs/sub/a.md', ['docs/**'], true],
    ['docs/sub/a.md', ['docs'], true],
    ['docs/sub/a.md', ['docs/'], true],
    ['docsx/a.md', ['docs'], false],
    ['src/app.ts', ['docs/**'], false],
    ['src/deep/README.md', ['*.md'], true],
    ['src/app.ts', ['*.md'], false],
    ['src/a.ts', ['src/*.ts'], true],
    ['src/x/a.ts', ['src/*.ts'], false],
    ['src/x/y/a.ts', ['src/**/*.ts'], true],
    ['src/a.ts', ['src/**/*.ts'], true],
    ['README.md', ['README.md'], true],
    ['Docs/A.md', ['docs/**'], true],
    ['anything.ts', [], true],
  ]
  for (const [path, scope, want] of cases) assert.equal(inScope(path, scope), want, `${path} ~ ${scope.join(',')}`)
})

test('outOfScope: liệt kê file ngoài phạm vi, file đổi tên xét cả tên cũ', () => {
  const files = [{ path: 'docs/a.md' }, { path: 'src/b.ts' }, { path: 'docs/c.md', oldPath: 'src/c.md' }]
  assert.deepEqual(outOfScope(files, ['docs/**']), ['src/b.ts', 'docs/c.md'])
  assert.deepEqual(outOfScope(files, []), [])
})

test('withScope: gắn ràng buộc vào cuối prompt, không có phạm vi thì giữ nguyên', () => {
  assert.equal(withScope('Viết tài liệu', undefined), 'Viết tài liệu')
  assert.equal(withScope('Viết tài liệu', []), 'Viết tài liệu')
  const p = withScope('Viết tài liệu', ['docs/**', '*.md'])
  assert.ok(p.startsWith('Viết tài liệu\n\n'))
  assert.match(p, /docs\/\*\*, \*\.md/)
  assert.match(p, /KHÔNG tự sửa/)
})

const create = (body: object) =>
  app.inject({ method: 'POST', url: '/api/tasks', payload: { projectId: 'p1', title: 'Viết hướng dẫn', prompt: 'Viết hướng dẫn sử dụng cho module X', ...body } })

test('POST /api/tasks: lưu phạm vi ghi đã chuẩn hoá; không gửi thì không giới hạn', async () => {
  const res = await create({ writeScope: 'docs/**, ./README.md' })
  assert.equal(res.statusCode, 200)
  const t = res.json() as Task
  assert.deepEqual(t.writeScope, ['docs/**', 'README.md'])
  assert.deepEqual(tasks.get(t.id)!.writeScope, ['docs/**', 'README.md'])
  const none = (await create({})).json() as Task
  assert.equal(none.writeScope, undefined)
})

test('POST /api/tasks: phạm vi ghi không hợp lệ → 400', async () => {
  const res = await create({ writeScope: ['../outside'] })
  assert.equal(res.statusCode, 400)
})

test('PATCH /api/tasks/:id: đổi và xoá phạm vi ghi', async () => {
  const t = (await create({ writeScope: ['docs/**'] })).json() as Task
  const set = await app.inject({ method: 'PATCH', url: `/api/tasks/${t.id}`, payload: { writeScope: ['*.md'] } })
  assert.equal(set.statusCode, 200)
  assert.deepEqual(tasks.get(t.id)!.writeScope, ['*.md'])
  const clear = await app.inject({ method: 'PATCH', url: `/api/tasks/${t.id}`, payload: { writeScope: [] } })
  assert.equal(clear.statusCode, 200)
  assert.equal(tasks.get(t.id)!.writeScope, undefined)
})

test('import: cột "Phạm vi ghi" được nhận và lưu; giá trị sai báo lỗi ở dòng', async () => {
  const table = mapTable([
    ['title', 'prompt', 'Phạm vi ghi'],
    ['Tài liệu A', 'Viết tài liệu cho phần A thật đầy đủ', 'docs/**, *.md'],
    ['Tài liệu B', 'Viết tài liệu cho phần B thật đầy đủ', '/etc/passwd'],
  ])
  assert.equal(table.rows[0].writeScope, 'docs/**, *.md')
  const imp = (rows: unknown[], dryRun: boolean) =>
    app.inject({ method: 'POST', url: '/api/tasks/import', payload: { projectId: 'p1', rows, onDuplicate: 'create', run: false, dryRun } })
  // Xem trước: dòng 2 hợp lệ, dòng 3 lỗi phạm vi
  const check = (await imp(table.rows, true)).json() as { rows: { status: string; errors?: string[] }[] }
  assert.equal(check.rows[0].status, 'ok')
  assert.equal(check.rows[1].status, 'error')
  assert.match(check.rows[1].errors!.join(' '), /tương đối/)
  // Import dòng hợp lệ: phạm vi được lưu vào task
  const res = await imp([table.rows[0]], false)
  assert.equal(res.statusCode, 200)
  const body = res.json() as { rows: { taskId?: number }[] }
  assert.deepEqual(tasks.get(body.rows[0].taskId!)!.writeScope, ['docs/**', '*.md'])
})
