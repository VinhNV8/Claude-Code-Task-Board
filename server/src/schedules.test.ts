import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CATCH_UP_THRESHOLD_MS, ScheduleError, fireDue, validateSchedule, type FireDeps } from './schedules.ts'
import type { Schedule } from './types.ts'

// DB riêng trong bộ nhớ cho test (phải đặt trước khi import db.ts)
process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard-sch-'))
process.env.TASKBOARD_DB = ':memory:'
const { projects, scheduleRuns, schedules, tasks } = await import('./db.ts')

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const NOW = at(2026, 11, 12, 8, 0) // thứ Năm 12/11/2026 08:00

let n = 0
const opts = (extra: Partial<Parameters<typeof validateSchedule>[1]> = {}) => ({
  projectExists: (id: string) => id === 'p1',
  newId: () => `sch-${++n}`,
  now: NOW,
  ...extra,
})
const input = { cron: '0 9 * * *', projectId: 'p1', title: ' Báo cáo hằng ngày ', prompt: 'Tổng hợp thay đổi trong ngày', priority: 'high' }

test('validateSchedule: lịch mới hợp lệ, tính lần chạy kế tiếp', () => {
  const s = validateSchedule(input, opts())
  assert.equal(s.title, 'Báo cáo hằng ngày')
  assert.equal(s.priority, 'high')
  assert.equal(s.enabled, true)
  assert.equal(s.nextRunAt, at(2026, 11, 12, 9, 0))
  assert.equal(s.createdAt, NOW)
  assert.match(s.id, /^sch-/)
})

test('validateSchedule: báo lỗi tiếng Việt', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ cron: '' }, /cron/],
    [{ cron: '99 * * * *' }, /cron không hợp lệ/],
    [{ cron: '0 0 31 2 *' }, /5 năm/],
    [{ projectId: 'khong-co' }, /Project/],
    [{ title: '  ' }, /tiêu đề/],
    [{ prompt: 'ngắn' }, /10 ký tự/],
    [{ priority: 'max' }, /ưu tiên/],
    [{ enabled: 'yes' }, /bật\/tắt/],
  ]
  for (const [patch, re] of cases) assert.throws(() => validateSchedule({ ...input, ...patch }, opts()), (e) => e instanceof ScheduleError && re.test(e.message))
})

test('validateSchedule: sửa giữ next nếu cron không đổi, tắt thì xoá next, bật lại tính từ bây giờ', () => {
  const prev = validateSchedule(input, opts())
  const later = NOW + 30 * 60_000
  // Đổi tiêu đề: giữ nguyên next
  assert.equal(validateSchedule({ title: 'Mới' }, opts({ prev, now: later })).nextRunAt, prev.nextRunAt)
  // Đổi cron: tính lại
  assert.equal(validateSchedule({ cron: '0 10 * * *' }, opts({ prev, now: later })).nextRunAt, at(2026, 11, 12, 10, 0))
  // Tắt
  const off = validateSchedule({ enabled: false }, opts({ prev, now: later }))
  assert.equal(off.enabled, false)
  assert.equal(off.nextRunAt, undefined)
  assert.equal(off.id, prev.id)
  assert.equal(off.createdAt, prev.createdAt)
  // Bật lại lúc 10:00 ngày 14: lần kế tiếp là 9:00 ngày 15, không chạy bù thời gian đã tắt
  const on = validateSchedule({ enabled: true }, opts({ prev: off, now: at(2026, 11, 14, 10, 0) }))
  assert.equal(on.nextRunAt, at(2026, 11, 15, 9, 0))
})

// ---------------------------------------------------------------- fireDue với DB thật (bộ nhớ)

projects.upsert({ id: 'p1', name: 'P1', repoPath: 'C:\\repo', mainBranch: 'main', permissionMode: 'plan', allowedTools: [], maxParallel: 1, budgetAction: 'warn' })

const deps: FireDeps = {
  due: schedules.due,
  setTimes: schedules.setTimes,
  addRun: scheduleRuns.add,
  createTask: (s) =>
    tasks.create({ projectId: s.projectId, title: s.title, prompt: s.prompt, priority: s.priority, permissionMode: 'plan', tags: [], status: 'queued' }),
}

function makeSchedule(patch: Partial<Schedule> = {}): Schedule {
  return schedules.upsert({ ...validateSchedule(input, opts()), ...patch })
}

test('fireDue: chưa tới giờ thì không làm gì; tới giờ tạo 1 task Queued và tính lần kế tiếp', () => {
  const s = makeSchedule()
  assert.equal(fireDue(at(2026, 11, 12, 8, 59), deps).filter((f) => f.schedule.id === s.id).length, 0)

  const fireAt = at(2026, 11, 12, 9, 0) + 5_000
  const fired = fireDue(fireAt, deps).filter((f) => f.schedule.id === s.id)
  assert.equal(fired.length, 1)
  const { task, run, schedule } = fired[0]
  assert.equal(task.status, 'queued')
  assert.equal(task.priority, 'high')
  assert.equal(task.title, 'Báo cáo hằng ngày')
  assert.equal(schedule.nextRunAt, at(2026, 11, 13, 9, 0))
  assert.equal(schedule.lastRunAt, fireAt)
  assert.equal(run.catchUp, false)
  assert.equal(run.scheduledFor, at(2026, 11, 12, 9, 0))

  // Gọi lại ngay: không tạo trùng
  assert.equal(fireDue(fireAt + 10_000, deps).filter((f) => f.schedule.id === s.id).length, 0)
  const hist = scheduleRuns.bySchedule(s.id)
  assert.equal(hist.length, 1)
  assert.equal(hist[0].taskId, task.id)
  schedules.remove(s.id)
})

test('fireDue: server tắt lỡ nhiều lần, khi bật lại chỉ tạo bù đúng 1 task', () => {
  // Chạy mỗi giờ, lần kế tiếp 9:00 nhưng server bật lại lúc 15:20 (lỡ 7 lần)
  const s = makeSchedule({ cron: '0 * * * *', nextRunAt: at(2026, 11, 12, 9, 0) })
  const before = tasks.all().length
  const restart = at(2026, 11, 12, 15, 20)
  const fired = fireDue(restart, deps).filter((f) => f.schedule.id === s.id)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].run.catchUp, true)
  assert.equal(fired[0].schedule.nextRunAt, at(2026, 11, 12, 16, 0))
  assert.equal(tasks.all().length, before + 1)
  // Các lần kiểm tra tiếp theo trước 16:00 không tạo thêm
  assert.equal(fireDue(restart + 60_000, deps).length, 0)
  assert.ok(restart - fired[0].run.scheduledFor > CATCH_UP_THRESHOLD_MS)
  schedules.remove(s.id)
})

test('fireDue: lịch tắt không chạy; task bị xoá thì lịch sử còn, taskId rỗng', () => {
  const off = makeSchedule({ enabled: false, nextRunAt: at(2026, 11, 12, 9, 0) })
  assert.equal(fireDue(at(2026, 11, 12, 10, 0), deps).length, 0)
  schedules.remove(off.id)

  const s = makeSchedule()
  const [f] = fireDue(at(2026, 11, 12, 9, 0), deps)
  tasks.remove(f.task.id)
  const hist = scheduleRuns.bySchedule(s.id)
  assert.equal(hist.length, 1)
  assert.equal(hist[0].taskId, undefined)
  assert.equal(hist[0].title, 'Báo cáo hằng ngày')
  // Xoá lịch thì lịch sử bị xoá theo
  schedules.remove(s.id)
  assert.equal(scheduleRuns.bySchedule(s.id).length, 0)
})

test('fireDue: lỗi ở một lịch không chặn lịch khác', () => {
  const bad = makeSchedule({ cron: 'hỏng', nextRunAt: at(2026, 11, 12, 9, 0) })
  const good = makeSchedule({ nextRunAt: at(2026, 11, 12, 9, 0) })
  const errors: string[] = []
  const fired = fireDue(at(2026, 11, 12, 9, 1), deps, (s) => errors.push(s.id))
  assert.deepEqual(errors, [bad.id])
  assert.deepEqual(fired.map((f) => f.schedule.id), [good.id])
  assert.equal(schedules.get(bad.id)!.nextRunAt, undefined) // lịch hỏng dừng lại, không lặp lỗi mỗi lần kiểm tra
  schedules.remove(bad.id)
  schedules.remove(good.id)
})

test('xoá project thì lịch bị xoá theo', () => {
  projects.upsert({ id: 'p2', name: 'P2', repoPath: 'C:\\repo2', mainBranch: 'main', permissionMode: 'plan', allowedTools: [], maxParallel: 1, budgetAction: 'warn' })
  const s = schedules.upsert({ ...validateSchedule({ ...input, projectId: 'p2' }, opts({ projectExists: () => true })) })
  projects.remove('p2')
  assert.equal(schedules.get(s.id), undefined)
})
