// Import task hàng loạt (SPEC FR-01a, docs/SPEC-IMPORT.md): parser CSV/TSV, giải mã, nhận cột (web/src/lib/taskImport.ts)
// và POST /api/tasks/import (server/src/taskImport.ts). DB in-memory, không spawn Claude.
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard import '))
process.env.TASKBOARD_DB = ':memory:'
const { db, projects, taskDeps, tasks } = await import('./db.ts')
const { routes } = await import('./routes.ts')
const lib = await import('../../web/src/lib/taskImport.ts')
const { default: Fastify } = await import('fastify')
import type { ImportRequest, ImportResult, ImportRow } from '../../web/src/lib/taskImport.ts'
import type { Task } from './types.ts'

const app = Fastify()
await app.register(routes)
after(async () => {
  await app.close()
})

const baseProject = {
  repoPath: process.env.TASKBOARD_DATA!,
  mainBranch: 'main',
  permissionMode: 'acceptEdits' as const,
  allowedTools: [],
  maxParallel: 0, // không cho runner tự chạy task Queued trong test
  budgetAction: 'warn' as const,
  deliveryMode: 'worktree' as const,
}
projects.upsert({ ...baseProject, id: 'p1', name: 'Web App' })
projects.upsert({ ...baseProject, id: 'p2', name: 'Backend', permissionMode: 'manual' })

beforeEach(() => {
  db.exec('DELETE FROM task_deps')
  db.exec('DELETE FROM tasks')
})

const PROMPT = 'làm gì đó đủ dài để hợp lệ'
const row = (line: number, extra: Partial<ImportRow> = {}): ImportRow => ({ line, title: `Task ${line}`, prompt: PROMPT, ...extra })

async function post(body: Partial<ImportRequest>) {
  const res = await app.inject({ method: 'POST', url: '/api/tasks/import', payload: { projectId: 'p1', onDuplicate: 'skip', run: false, ...body } })
  return { status: res.statusCode, body: res.json() as ImportResult & { tasks: Task[]; error?: string; code?: string } }
}

// ---------------------------------------------------------------- parser

test('parseDelimited: ngoặc kép, xuống dòng trong ô, "" , CRLF, BOM', () => {
  const csv = '﻿title,prompt\r\n"A, có dấu phẩy","dòng 1\r\ndòng 2 ""trích"""\r\nB,x\r\n'
  assert.deepEqual(lib.parseDelimited(csv), [
    ['title', 'prompt'],
    ['A, có dấu phẩy', 'dòng 1\r\ndòng 2 "trích"'],
    ['B', 'x'],
  ])
})

test('detectDelimiter: `;` của Excel tiếng Việt, Tab khi dán, mặc định `,`', () => {
  assert.equal(lib.detectDelimiter('Tiêu đề;Mô tả;Ưu tiên\na;b;c'), ';')
  assert.equal(lib.detectDelimiter('title\tprompt\nx\ty'), '\t')
  assert.equal(lib.detectDelimiter('title,prompt'), ',')
  // dấu `;` nằm trong ngoặc kép không tính
  assert.equal(lib.detectDelimiter('"a;b;c",prompt,x'), ',')
})

test('decodeText: UTF-8 nghiêm ngặt, lỗi thì Windows-1258 (chuẩn hoá NFC)', () => {
  const utf8 = new TextEncoder().encode('﻿Tiêu đề')
  assert.deepEqual(lib.decodeText(utf8), { text: 'Tiêu đề', encoding: 'utf-8', fallback: false })
  // "Tiêu đề" theo Windows-1258: ê = 0xEA, đ = 0xF0, dấu huyền tổ hợp = 0xCC
  const cp1258 = new Uint8Array([0x54, 0x69, 0xea, 0x75, 0x20, 0xf0, 0xea, 0xcc])
  const r = lib.decodeText(cp1258)
  assert.equal(r.encoding, 'windows-1258')
  assert.equal(r.fallback, true)
  assert.equal(r.text, 'Tiêu đề')
  assert.equal(lib.decodeText(utf8, 'utf-8').fallback, false)
})

test('mapTable: tên cột tiếng Việt/Anh, bỏ dòng trống giữ số dòng, cột lạ, thiếu cột bắt buộc', () => {
  const m = lib.mapTable([
    ['Mã', 'Tiêu đề', 'Mô tả', 'Chờ task', 'Ưu tiên', 'Tags', 'Ghi chú'],
    ['A1', ' Việc 1 ', 'mô tả\r\nnhiều dòng', '', 'Cao', 'web; api', 'x'],
    ['', '', '', '', '', '', ''],
    ['A2', 'Việc 2', 'mô tả', 'A1, #5', '', '', ''],
  ])
  assert.deepEqual(m.unknown, ['Ghi chú'])
  assert.deepEqual(m.missing, [])
  assert.deepEqual(m.rows, [
    { line: 2, key: 'A1', title: 'Việc 1', prompt: 'mô tả\nnhiều dòng', priority: 'Cao', tags: ['web', 'api'] },
    { line: 4, key: 'A2', title: 'Việc 2', prompt: 'mô tả', dependsOn: ['A1', '#5'] },
  ])
  assert.deepEqual(lib.mapTable([['title', 'note']]).missing, ['prompt'])
})

test('mapTable: cắt ở IMPORT_MAX_ROWS dòng', () => {
  const table = [['title', 'prompt'], ...Array.from({ length: lib.IMPORT_MAX_ROWS + 3 }, (_, i) => [`t${i}`, PROMPT])]
  const m = lib.mapTable(table)
  assert.equal(m.rows.length, lib.IMPORT_MAX_ROWS)
  assert.equal(m.truncated, 3)
})

test('normalizePriority / normalizePermissionMode: nhận tiếng Việt, giữ nguyên giá trị lạ', () => {
  assert.equal(lib.normalizePriority('Khẩn cấp'), 'urgent')
  assert.equal(lib.normalizePriority('thấp'), 'low')
  assert.equal(lib.normalizePriority(''), undefined)
  assert.equal(lib.normalizePriority('siêu cao'), 'siêu cao')
  assert.equal(lib.normalizePermissionMode('Edit automatically'), 'acceptEdits')
  assert.equal(lib.normalizePermissionMode('Tự động'), 'auto')
})

test('templateCsv: có BOM, đọc lại được và hợp lệ', async () => {
  const csv = lib.templateCsv()
  assert.equal(csv.charCodeAt(0), 0xfeff)
  const m = lib.mapTable(lib.parseDelimited(csv))
  assert.equal(m.rows.length, 2)
  assert.deepEqual(m.missing, [])
  const r = await post({ rows: m.rows, dryRun: true })
  assert.equal(r.status, 200)
  assert.deepEqual(
    r.body.rows.map((x) => x.status),
    ['ok', 'ok'],
  )
})

test('templateXlsx: đọc lại bằng read-excel-file ra đúng 2 task hợp lệ, sheet Hướng dẫn riêng (FR-01b)', async () => {
  const { templateXlsx, columnName } = await import('../../web/src/lib/xlsxTemplate.ts')
  const { readSheet } = await import('read-excel-file/universal')
  assert.deepEqual([0, 25, 26, 51, 701, 702].map(columnName), ['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA'])
  const bytes = templateXlsx()
  assert.deepEqual([...bytes.slice(0, 2)], [0x50, 0x4b]) // file zip ("PK")
  const blob = new Blob([bytes])
  const data = await readSheet(blob)
  const table = data.map((r) => r.map(lib.cellToString))
  assert.deepEqual(table[0], lib.TEMPLATE_ROWS[0])
  const m = lib.mapTable(table)
  assert.deepEqual(m.missing, [])
  assert.deepEqual(m.unknown, [])
  assert.equal(m.rows[0].prompt, lib.TEMPLATE_ROWS[1][2]) // giữ xuống dòng trong ô
  assert.deepEqual(m.rows[1].dependsOn, ['A1'])
  const guide = await readSheet(blob, 'Hướng dẫn')
  assert.equal(guide[0][0], 'Cột')
  const r = await post({ rows: m.rows, dryRun: true })
  assert.deepEqual(
    r.body.rows.map((x) => x.status),
    ['ok', 'ok'],
  )
})

test('buildXlsx: escape ký tự XML và bỏ ký tự điều khiển', async () => {
  const { buildXlsx } = await import('../../web/src/lib/xlsxTemplate.ts')
  const { readSheet } = await import('read-excel-file/universal')
  const data = await readSheet(new Blob([buildXlsx([{ name: 'S', rows: [['a<b>&"c"', 'x\u0001y']] }])]))
  assert.deepEqual(data[0], ['a<b>&"c"', 'xy'])
})

// ---------------------------------------------------------------- API

test('dryRun: báo lỗi theo dòng, không tạo gì (AC-16)', async () => {
  const r = await post({
    dryRun: true,
    rows: [row(2), row(3, { prompt: 'ngắn' }), row(4, { title: '', priority: 'siêu cao' }), row(5, { model: 'gpt-4' })],
  })
  assert.equal(r.status, 200)
  assert.deepEqual(
    r.body.rows.map((x) => [x.line, x.status]),
    [
      [2, 'ok'],
      [3, 'error'],
      [4, 'error'],
      [5, 'error'],
    ],
  )
  assert.deepEqual(r.body.rows[1].errors, ['Mô tả cần ít nhất 10 ký tự'])
  assert.deepEqual(r.body.rows[2].errors, ['Vui lòng nhập tiêu đề', 'Độ ưu tiên không hợp lệ'])
  assert.equal(tasks.all().length, 0)
})

test('Tạo thật khi còn dòng lỗi → 400, không tạo task nào (I2)', async () => {
  const r = await post({ dryRun: false, rows: [row(2), row(3, { prompt: 'ngắn' })] })
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'IMPORT_INVALID')
  assert.equal(tasks.all().length, 0)
})

test('Tạo ở Backlog, giữ giá trị từng cột, mức quyền trống lấy mặc định project (AC-15)', async () => {
  const r = await post({
    dryRun: false,
    rows: [
      row(2, { prompt: 'dòng 1\ndòng 2 đủ dài', priority: 'cao', tags: ['web'], model: 'Haiku', maxCostUsd: '1,5' }),
      row(3, { project: 'backend' }),
    ],
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.created, 2)
  const [a, b] = r.body.tasks
  assert.equal(a.status, 'backlog')
  assert.equal(a.prompt, 'dòng 1\ndòng 2 đủ dài')
  assert.equal(a.priority, 'high')
  assert.deepEqual(a.tags, ['web'])
  assert.equal(a.model, 'haiku')
  assert.equal(a.maxCostUsd, 1.5)
  assert.equal(a.permissionMode, 'acceptEdits')
  assert.equal(b.projectId, 'p2')
  assert.equal(b.permissionMode, 'manual')
})

test('run: true → tạo ở Hàng đợi theo thứ tự dòng', async () => {
  const r = await post({ dryRun: false, run: true, rows: [row(2), row(3)] })
  assert.equal(r.status, 200)
  assert.deepEqual(
    r.body.tasks.map((t) => t.status),
    ['queued', 'queued'],
  )
  assert.ok(r.body.tasks[0].id < r.body.tasks[1].id)
})

test('Project không tồn tại → lỗi ở dòng đó', async () => {
  const r = await post({ dryRun: true, rows: [row(2, { project: 'Không có' })] })
  assert.deepEqual(r.body.rows[0].errors, ['Không tìm thấy project "Không có"'])
})

test('Phụ thuộc qua cột Mã: B chờ A; `#id` và mã task đã có (AC-17)', async () => {
  const old = tasks.create({ projectId: 'p1', title: '[P9-01] Việc cũ', prompt: PROMPT, status: 'backlog', priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
  const r = await post({
    dryRun: false,
    rows: [row(2, { key: 'A' }), row(3, { key: 'B', dependsOn: ['a', `#${old.id}`, 'P9-01'] })],
  })
  assert.equal(r.status, 200)
  const [a, b] = r.body.tasks
  assert.deepEqual(taskDeps.of(b.id), [old.id, a.id].sort((x, y) => x - y))
  assert.deepEqual(b.dependsOn, taskDeps.of(b.id))
  assert.deepEqual(taskDeps.of(a.id), [])
})

test('Phụ thuộc vòng tròn → lỗi ở mọi dòng trong vòng, không tạo gì (AC-17)', async () => {
  const r = await post({
    dryRun: false,
    rows: [row(2, { key: 'A', dependsOn: ['B'] }), row(3, { key: 'B', dependsOn: ['A'] }), row(4)],
  })
  assert.equal(r.status, 400)
  const dry = await post({ dryRun: true, rows: [row(2, { key: 'A', dependsOn: ['B'] }), row(3, { key: 'B', dependsOn: ['A'] }), row(4)] })
  assert.deepEqual(
    dry.body.rows.map((x) => x.status),
    ['error', 'error', 'ok'],
  )
  assert.match(dry.body.rows[0].errors![0], /Phụ thuộc vòng tròn: dòng 2 \(A\) → dòng 3 \(B\) → dòng 2 \(A\)/)
  assert.equal(tasks.all().length, 0)
})

test('Phụ thuộc sai: mã không có, chờ chính nó, khác project, mã trùng', async () => {
  const r = await post({
    dryRun: true,
    rows: [
      row(2, { key: 'A', dependsOn: ['ZZ'] }),
      row(3, { key: 'B', dependsOn: ['B'] }),
      row(4, { key: 'C', project: 'p2', dependsOn: ['A'] }),
      row(5, { key: 'a' }),
    ],
  })
  assert.deepEqual(
    r.body.rows.map((x) => x.errors),
    [
      ['Không tìm thấy mã "ZZ" trong file hoặc trong các task đã có'],
      ['Task không thể chờ chính nó'],
      ['Mã "A" thuộc project khác, chỉ chờ được task cùng project'],
      ['Mã "a" trùng với dòng 2'],
    ],
  )
})

test('Import lại cùng file: mọi dòng trùng, mặc định bỏ qua (AC-18); Vẫn tạo thì tạo thêm', async () => {
  const rows = [row(2, { key: 'A' }), row(3, { key: 'B', dependsOn: ['A'] })]
  assert.equal((await post({ dryRun: false, rows })).body.created, 2)
  const again = await post({ dryRun: false, rows })
  assert.equal(again.status, 200)
  assert.equal(again.body.created, 0)
  assert.equal(again.body.skipped, 2)
  assert.deepEqual(
    again.body.rows.map((x) => x.status),
    ['duplicate', 'duplicate'],
  )
  assert.equal(tasks.all().length, 2)
  const forced = await post({ dryRun: false, rows, onDuplicate: 'create' })
  assert.equal(forced.body.created, 2)
  assert.equal(tasks.all().length, 4)
})

test('Dòng mới chờ dòng bị bỏ qua vì trùng → nối vào task đã có cùng tiêu đề (I4)', async () => {
  const first = await post({ dryRun: false, rows: [row(2)] })
  const oldId = first.body.tasks[0].id
  const r = await post({ dryRun: false, rows: [row(2, { key: 'A' }), row(3, { key: 'B', title: 'Việc mới', dependsOn: ['A'] })] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.rows[0].duplicateOf, { taskId: oldId })
  assert.equal(r.body.created, 1)
  assert.deepEqual(taskDeps.of(r.body.tasks[0].id), [oldId])
})

test('Trùng tiêu đề giữa hai dòng trong file (không phân biệt hoa thường, khoảng trắng)', async () => {
  const r = await post({ dryRun: true, rows: [row(2, { title: 'Sửa  lỗi' }), row(3, { title: 'sửa lỗi' })] })
  assert.deepEqual(r.body.rows[1].duplicateOf, { line: 2 })
  assert.equal(r.body.rows[1].status, 'duplicate')
})

test('Mức quyền Auto: phải xác nhận mới tạo (AC-19)', async () => {
  const rows = [row(2, { permissionMode: 'auto' }), row(3)]
  const dry = await post({ dryRun: true, rows })
  assert.equal(dry.body.autoCount, 1)
  const noConfirm = await post({ dryRun: false, rows })
  assert.equal(noConfirm.status, 400)
  assert.equal(noConfirm.body.code, 'CONFIRM_AUTO')
  assert.equal(tasks.all().length, 0)
  const ok = await post({ dryRun: false, rows, confirmAuto: true })
  assert.equal(ok.body.created, 2)
  assert.equal(ok.body.tasks[0].permissionMode, 'auto')
})

test('Dữ liệu dán từ Google Sheets (Tab) cho kết quả như file (AC-20)', async () => {
  const pasted = 'Tiêu đề\tMô tả\tƯu tiên\nViệc dán\t' + PROMPT + '\tthấp\n'
  const m = lib.mapTable(lib.parseDelimited(pasted))
  const r = await post({ dryRun: false, rows: m.rows })
  assert.equal(r.body.created, 1)
  assert.equal(r.body.tasks[0].priority, 'low')
})

test('Lỗi giữa lúc ghi → rollback, không có task nào (AC-21)', async () => {
  const orig = tasks.create
  let n = 0
  tasks.create = ((t: Parameters<typeof orig>[0]) => {
    if (++n === 2) throw new Error('giả lập lỗi ghi')
    return orig(t)
  }) as typeof orig
  try {
    const r = await post({ dryRun: false, rows: [row(2), row(3), row(4)] })
    assert.equal(r.status, 500)
  } finally {
    tasks.create = orig
  }
  assert.equal(tasks.all().length, 0)
})

test('Request sai: thiếu project, không có dòng, quá số dòng', async () => {
  assert.equal((await post({ projectId: 'x', rows: [row(2)], dryRun: true })).status, 400)
  assert.equal((await post({ rows: [], dryRun: true })).status, 400)
  const many = Array.from({ length: lib.IMPORT_MAX_ROWS + 1 }, (_, i) => row(i + 2))
  assert.equal((await post({ rows: many, dryRun: true })).status, 400)
})

test('Body lớn (200 dòng, prompt dài) vượt 1 MB vẫn nhận', async () => {
  const big = 'x'.repeat(20_000)
  const rows = Array.from({ length: 200 }, (_, i) => row(i + 2, { prompt: big }))
  const r = await post({ rows, dryRun: true })
  assert.equal(r.status, 200)
  assert.equal(r.body.rows.length, 200)
})
