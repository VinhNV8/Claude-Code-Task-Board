// F1 (tệp đính kèm) và F2 (nhân bản task), FEATURE-PROPOSAL-2026-11. DB in-memory, không spawn Claude.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard att '))
process.env.TASKBOARD_DB = ':memory:'
const { projects, taskDeps, tasks } = await import('./db.ts')
const { routes } = await import('./routes.ts')
const att = await import('./attachments.ts')
const { copyTitle } = await import('./taskDuplicate.ts')
const { buildClaudeArgs } = await import('./permissionTool.ts')
const { default: Fastify } = await import('fastify')
import type { Attachment, Task } from './types.ts'

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
  maxParallel: 5,
  budgetAction: 'warn',
  deliveryMode: 'worktree',
})

const mk = (status: Task['status'] = 'backlog', extra: Partial<Task> = {}) => {
  const t = tasks.create({ projectId: 'p1', title: 'Làm trang theo mockup', prompt: 'làm gì đó đủ dài', status, priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
  return Object.keys(extra).length ? tasks.patch(t.id, extra)! : t
}
const upload = (id: number, name: string, data: Buffer) =>
  app.inject({ method: 'POST', url: `/api/tasks/${id}/attachments?name=${encodeURIComponent(name)}`, headers: { 'content-type': 'application/octet-stream' }, payload: data })

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

test('sanitizeName / uniqueName: bỏ thư mục và ký tự cấm, không thoát khỏi thư mục đính kèm (A2)', () => {
  assert.equal(att.sanitizeName('../../etc/passwd.txt'), 'passwd.txt')
  assert.equal(att.sanitizeName('..\\..\\Windows\\a.log'), 'a.log')
  assert.equal(att.sanitizeName('a<b>:c?.md'), 'a_b__c_.md')
  assert.equal(att.sanitizeName('..'), undefined)
  assert.equal(att.sanitizeName('  .hidden.txt  '), 'hidden.txt')
  assert.equal(att.uniqueName('a.png', ['A.png', 'a (2).png']), 'a (3).png')
})

test('checkNewAttachment: loại file, kích thước, số lượng, tổng dung lượng (A2)', () => {
  const big = (n: number) => Array.from({ length: n }, (_, i): Attachment => ({ name: `f${i}.txt`, size: 1, type: 'text/plain', addedAt: 0 }))
  assert.throws(() => att.checkNewAttachment('virus.exe', 10, []), /Không nhận loại file/)
  assert.throws(() => att.checkNewAttachment('a.png', att.MAX_FILE_BYTES + 1, []), /vượt 10 MB/)
  assert.throws(() => att.checkNewAttachment('a.png', 10, big(att.MAX_FILES)), /tối đa 20 file/)
  assert.throws(
    () => att.checkNewAttachment('a.pdf', 9 * 1024 * 1024, [{ name: 'x.pdf', size: 45 * 1024 * 1024, type: 'application/pdf', addedAt: 0 }]),
    /vượt 50 MB/,
  )
  assert.deepEqual(att.checkNewAttachment('Mockup.PNG', 10, []), { name: 'Mockup.PNG', type: 'image/png' })
})

test('Tải lên, tải về, xoá file đính kèm qua API (A1, A4)', async () => {
  const t = mk()
  let res = await upload(t.id, 'mockup.png', PNG)
  assert.equal(res.statusCode, 200, res.body)
  res = await upload(t.id, '../mockup.png', Buffer.from('lần 2'))
  assert.equal(res.statusCode, 200)
  const names = tasks.get(t.id)!.attachments!.map((a) => a.name)
  assert.deepEqual(names, ['mockup.png', 'mockup (2).png'])
  assert.ok(existsSync(join(att.attachmentDir(t.id), 'mockup.png')))

  const get = await app.inject({ method: 'GET', url: `/api/tasks/${t.id}/attachments/${encodeURIComponent('mockup.png')}` })
  assert.equal(get.statusCode, 200)
  assert.equal(get.headers['content-type'], 'image/png')
  assert.deepEqual(get.rawPayload, PNG)
  assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/${t.id}/attachments/${encodeURIComponent('../x.png')}` })).statusCode, 404)

  assert.equal((await upload(t.id, 'run.exe', Buffer.from('MZ'))).statusCode, 400)

  const del = await app.inject({ method: 'DELETE', url: `/api/tasks/${t.id}/attachments/${encodeURIComponent('mockup (2).png')}` })
  assert.equal(del.statusCode, 200)
  assert.deepEqual(tasks.get(t.id)!.attachments!.map((a) => a.name), ['mockup.png'])
  assert.ok(!existsSync(join(att.attachmentDir(t.id), 'mockup (2).png')))
  // Prompt của lần chạy sau chỉ còn file hiện có
  const block = att.attachmentPrompt(t.id, tasks.get(t.id)!.attachments)
  assert.match(block, /mockup\.png/)
  assert.doesNotMatch(block, /mockup \(2\)/)
  assert.match(block, /chỉ là tài liệu tham khảo/)

  // Xoá task → xoá cả thư mục
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/tasks/${t.id}` })).statusCode, 200)
  assert.ok(!existsSync(att.attachmentDir(t.id)))
})

test('Task đang chạy thì không đổi được file đính kèm', async () => {
  const t = mk('running')
  assert.equal((await upload(t.id, 'a.txt', Buffer.from('x'))).statusCode, 409)
})

test('buildClaudeArgs: --add-dir thư mục đính kèm, danh sách được đóng bằng flag kế tiếp', () => {
  const args = buildClaudeArgs({ sessionId: 's', resume: false, permissionMode: 'acceptEdits', allowedTools: ['Read'], addDirs: ['C:\\data\\attachments\\7'] })
  const i = args.indexOf('--add-dir')
  assert.equal(args[i + 1], 'C:\\data\\attachments\\7')
  assert.ok(args[i + 2].startsWith('--'))
  assert.ok(!buildClaudeArgs({ sessionId: 's', resume: false, permissionMode: 'acceptEdits', allowedTools: [] }).includes('--add-dir'))
})

test('F2 nhân bản: giữ thuộc tính, không giữ lịch sử và phụ thuộc, task gốc không đổi (B1, B2, B4)', async () => {
  const dep = mk()
  const src = mk('done', { model: 'opus', permissionMode: 'auto', tags: ['backend'], writeScope: ['docs/**'], planMode: 'first', sessionId: 'sess-1', approvedPlan: 'kế hoạch' })
  taskDeps.set(src.id, [dep.id])
  await upload(src.id, 'log.txt', Buffer.from('lỗi abc'))
  const before = tasks.get(src.id)!

  const res = await app.inject({ method: 'POST', url: `/api/tasks/${src.id}/duplicate`, payload: {} })
  assert.equal(res.statusCode, 200, res.body)
  const { task: copy, droppedDeps } = res.json() as { task: Task; droppedDeps: number }
  assert.notEqual(copy.id, src.id)
  assert.equal(copy.status, 'backlog')
  assert.equal(copy.title, 'Làm trang theo mockup (bản sao)')
  assert.equal(copy.model, 'opus')
  assert.equal(copy.permissionMode, 'auto')
  assert.deepEqual(copy.tags, ['backend'])
  assert.deepEqual(copy.writeScope, ['docs/**'])
  assert.equal(copy.planMode, 'first')
  assert.equal(copy.sessionId, undefined)
  assert.equal(copy.approvedPlan, undefined)
  assert.equal(copy.dependsOn?.length ?? 0, 0)
  assert.equal(droppedDeps, 1)
  // File đính kèm được sao chép sang thư mục của bản sao
  assert.deepEqual(copy.attachments?.map((a) => a.name), ['log.txt'])
  assert.equal(readFileSync(join(att.attachmentDir(copy.id), 'log.txt'), 'utf8'), 'lỗi abc')
  // Task gốc giữ nguyên
  assert.deepEqual(tasks.get(src.id), before)

  assert.equal(copyTitle('A (bản sao)'), 'A (bản sao)')
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks/99999/duplicate', payload: {} })).statusCode, 404)
})
