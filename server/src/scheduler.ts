// Bộ hẹn giờ chạy lịch (PLAN 4.6): nối logic fireDue với DB, bus và hàng đợi runner.
import { broadcast } from './bus.ts'
import { projects, scheduleRuns, schedules, tasks } from './db.ts'
import { pump } from './runner.ts'
import { fireDue } from './schedules.ts'

/** Chu kỳ kiểm tra; task được tạo trễ tối đa chừng này sau thời điểm theo lịch. */
const TICK_MS = 10_000

export function runSchedules(now = Date.now()) {
  const fired = fireDue(
    now,
    {
      due: schedules.due,
      setTimes: schedules.setTimes,
      addRun: scheduleRuns.add,
      createTask: (s) => {
        const project = projects.get(s.projectId)
        if (!project) throw new Error(`Project ${s.projectId} không còn tồn tại`)
        return tasks.create({
          projectId: s.projectId,
          title: s.title,
          prompt: s.prompt,
          priority: s.priority,
          permissionMode: project.permissionMode,
          tags: [],
          status: 'queued',
        })
      },
    },
    (s, e) => console.warn(`Lịch ${s.id} (${s.cron}) lỗi: ${(e as Error).message}`),
  )
  for (const f of fired) {
    broadcast({ type: 'task', task: f.task })
    broadcast({ type: 'schedule', schedule: f.schedule })
    broadcast({ type: 'schedule_run', run: f.run })
  }
  if (fired.length) pump()
  return fired
}

let timer: NodeJS.Timeout | undefined

/** Chạy ngay một lần (tạo bù tối đa 1 task cho mỗi lịch đã lỡ giờ khi server tắt), sau đó kiểm tra định kỳ. */
export function startScheduler() {
  stopScheduler()
  runSchedules()
  timer = setInterval(() => {
    try {
      runSchedules()
    } catch (e) {
      console.warn(`Bộ hẹn giờ lịch lỗi: ${(e as Error).message}`)
    }
  }, TICK_MS)
}

export function stopScheduler() {
  if (timer) clearInterval(timer)
  timer = undefined
}
