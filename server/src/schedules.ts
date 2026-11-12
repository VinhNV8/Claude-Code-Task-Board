// Lên lịch tạo task theo cron (PLAN 4.6).
// - Mỗi lịch lưu next_run_at. Bộ hẹn giờ kiểm tra định kỳ; lịch tới giờ thì tạo MỘT task ở Queued
//   rồi tính next_run_at mới từ thời điểm hiện tại.
// - Server tắt đúng lúc tới giờ (có thể lỡ nhiều lần): khi bật lại chỉ tạo bù đúng 1 task, các lần lỡ khác bỏ qua.
// - Tắt lịch thì xoá next_run_at; bật lại thì tính từ bây giờ (không chạy bù thời gian đã tắt).
import type { Priority, Schedule, ScheduleRun, Task } from './types.ts'
import { CronError, nextRun, parseCron } from './cron.ts'

export class ScheduleError extends Error {}

export interface ScheduleInput {
  cron?: unknown
  projectId?: unknown
  title?: unknown
  prompt?: unknown
  priority?: unknown
  enabled?: unknown
}

const PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low']
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** Kiểm tra cron và trả về lần chạy kế tiếp sau `now`. Ném ScheduleError nếu sai hoặc không bao giờ chạy. */
export function checkCron(expr: string, now: number): number {
  let next: number | null
  try {
    next = nextRun(parseCron(expr), now)
  } catch (e) {
    if (e instanceof CronError) throw new ScheduleError(`Biểu thức cron không hợp lệ: ${e.message}`)
    throw e
  }
  if (next === null) throw new ScheduleError('Biểu thức cron không có lần chạy nào trong 5 năm tới')
  return next
}

/**
 * Chuẩn hoá và kiểm tra lịch (tạo mới khi `prev` không có, sửa khi có).
 * next_run_at được tính lại từ `now` khi lịch mới, đổi cron, hoặc vừa bật lại; tắt thì xoá.
 */
export function validateSchedule(
  b: ScheduleInput,
  opts: { prev?: Schedule; projectExists: (id: string) => boolean; newId: () => string; now: number },
): Schedule {
  const { prev, now } = opts
  const cron = str(b.cron ?? prev?.cron).trim().replace(/\s+/g, ' ')
  if (!cron) throw new ScheduleError('Nhập biểu thức cron')
  const projectId = str(b.projectId ?? prev?.projectId).trim()
  if (!projectId || !opts.projectExists(projectId)) throw new ScheduleError('Project không hợp lệ')
  const title = str(b.title ?? prev?.title).trim()
  if (!title) throw new ScheduleError('Vui lòng nhập tiêu đề')
  if (title.length > 200) throw new ScheduleError('Tiêu đề tối đa 200 ký tự')
  const prompt = str(b.prompt ?? prev?.prompt)
  if (prompt.trim().length < 10) throw new ScheduleError('Mô tả cần ít nhất 10 ký tự')
  const priority = (b.priority ?? prev?.priority ?? 'normal') as Priority
  if (!PRIORITIES.includes(priority)) throw new ScheduleError('Độ ưu tiên không hợp lệ')
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') throw new ScheduleError('Trạng thái bật/tắt không hợp lệ')
  const enabled = (b.enabled as boolean | undefined) ?? prev?.enabled ?? true

  const next = checkCron(cron, now) // luôn kiểm tra, kể cả khi lịch đang tắt
  // Sửa lịch đang chạy mà không đổi cron: giữ nguyên lần chạy kế tiếp
  const kept = prev?.enabled && enabled && prev.cron === cron ? prev.nextRunAt : undefined
  return {
    id: prev?.id ?? opts.newId(),
    cron,
    projectId,
    title,
    prompt,
    priority,
    enabled,
    nextRunAt: enabled ? kept ?? next : undefined,
    lastRunAt: prev?.lastRunAt,
    createdAt: prev?.createdAt ?? now,
  }
}

/** Lần lỡ giờ quá ngưỡng này (ms) thì coi là tạo bù khi khởi động lại. */
export const CATCH_UP_THRESHOLD_MS = 2 * 60_000

export interface FireDeps {
  /** Lịch đang bật đã tới giờ */
  due: (now: number) => Schedule[]
  createTask: (s: Schedule) => Task
  addRun: (r: Omit<ScheduleRun, 'id'>) => ScheduleRun
  setTimes: (id: string, t: { nextRunAt: number | null; lastRunAt?: number }) => Schedule | undefined
}

export interface Fired {
  schedule: Schedule
  task: Task
  run: ScheduleRun
}

/**
 * Tạo task cho mọi lịch tới giờ. Mỗi lịch tạo tối đa 1 task mỗi lần gọi, dù đã lỡ bao nhiêu lần.
 * Lỗi của một lịch (VD cron hỏng trong DB) không chặn các lịch khác: lịch đó bị dừng (next = null).
 */
export function fireDue(now: number, deps: FireDeps, onError?: (s: Schedule, e: unknown) => void): Fired[] {
  const out: Fired[] = []
  for (const s of deps.due(now)) {
    let next: number | null
    try {
      next = nextRun(s.cron, now)
    } catch (e) {
      onError?.(s, e)
      deps.setTimes(s.id, { nextRunAt: null })
      continue
    }
    // Ghi next_run_at trước khi tạo task: nếu tạo task lỗi cũng không lặp lại liên tục.
    const scheduledFor = s.nextRunAt!
    deps.setTimes(s.id, { nextRunAt: next, lastRunAt: now })
    let task: Task
    try {
      task = deps.createTask(s)
    } catch (e) {
      onError?.(s, e)
      continue
    }
    const run = deps.addRun({
      scheduleId: s.id,
      taskId: task.id,
      title: task.title,
      scheduledFor,
      firedAt: now,
      catchUp: now - scheduledFor > CATCH_UP_THRESHOLD_MS,
    })
    out.push({ schedule: deps.setTimes(s.id, { nextRunAt: next }) ?? s, task, run })
  }
  return out
}
