// Thống kê (PLAN 4.4): tổng hợp task và lần chạy theo ngày và theo project.
// Hàm thuần, không đụng DB, để dễ kiểm thử.
import { computeModelStats, tagModelRows } from './modelHistory.ts'
import type { Project, ReviewAction, Run, RunTotals, Stats, StatsDay, StatsRange, Task, TaskStatus } from './types.ts'

export const STATS_RANGES: StatsRange[] = [7, 30, 90]
const DAY = 86_400_000
const STATUSES: TaskStatus[] = ['backlog', 'queued', 'running', 'needs_input', 'review', 'done', 'failed']

export class StatsError extends Error {}

export interface StatsQuery {
  days?: unknown
  /** Độ lệch múi giờ của trình duyệt, đúng như Date.getTimezoneOffset() (phút, UTC+7 là -420) */
  tz?: unknown
  projectId?: unknown
}

export interface StatsOptions {
  days: StatsRange
  tzOffsetMin: number
  projectId?: string
}

/** Kiểm tra tham số query; báo lỗi tiếng Việt. */
export function parseStatsQuery(q: StatsQuery, projectExists: (id: string) => boolean): StatsOptions {
  const days = q.days === undefined || q.days === '' ? 7 : Number(q.days)
  if (!STATS_RANGES.includes(days as StatsRange)) throw new StatsError('Khoảng thời gian chỉ nhận 7, 30 hoặc 90 ngày')
  const tz = q.tz === undefined || q.tz === '' ? 0 : Number(q.tz)
  if (!Number.isInteger(tz) || Math.abs(tz) > 14 * 60) throw new StatsError('Múi giờ không hợp lệ')
  let projectId: string | undefined
  if (q.projectId !== undefined && q.projectId !== '') {
    if (typeof q.projectId !== 'string' || !projectExists(q.projectId)) throw new StatsError('Project không hợp lệ')
    projectId = q.projectId
  }
  return { days: days as StatsRange, tzOffsetMin: tz, projectId }
}

/** Khóa ngày YYYY-MM-DD theo giờ địa phương (tzOffsetMin theo quy ước getTimezoneOffset). */
export function dayKey(ts: number, tzOffsetMin: number) {
  return new Date(ts - tzOffsetMin * 60_000).toISOString().slice(0, 10)
}

/** Đầu ngày địa phương (epoch ms) chứa thời điểm ts. */
export function startOfLocalDay(ts: number, tzOffsetMin: number) {
  const shift = tzOffsetMin * 60_000
  return Math.floor((ts - shift) / DAY) * DAY + shift
}

const emptyTotals = (): RunTotals => ({ runs: 0, costUsd: 0, turns: 0, durationMs: 0 })
const emptyStatus = () => Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>

function addRun(t: RunTotals, r: Run) {
  t.runs++
  t.costUsd += r.costUsd ?? 0
  t.turns += r.numTurns ?? 0
  if (r.endedAt !== undefined) t.durationMs += Math.max(0, r.endedAt - r.startedAt)
}

/**
 * - Task: tính các task tạo trong khoảng thời gian, theo trạng thái hiện tại.
 * - Run: tính các lần chạy bắt đầu trong khoảng thời gian (chi phí, số turns, thời gian chạy).
 * - Done/Failed theo ngày: dựa vào updated_at của task đang ở trạng thái đó.
 */
export function computeStats(
  data: {
    tasks: Task[]
    runs: Run[]
    projects: Project[]
    /** P5-07: lịch sử review, cho bảng tag × model. */
    reviews?: ReviewAction[]
    /** Mọi run của các task (không giới hạn thời gian); không có thì dùng `runs`. */
    historyRuns?: Run[]
  },
  opts: StatsOptions,
  now = Date.now(),
): Stats {
  const { days, tzOffsetMin, projectId } = opts
  const from = startOfLocalDay(now, tzOffsetMin) - (days - 1) * DAY
  const inRange = (ts: number) => ts >= from && ts <= now

  const daily: StatsDay[] = []
  const byDay = new Map<string, StatsDay>()
  for (let i = 0; i < days; i++) {
    const d: StatsDay = { date: dayKey(from + i * DAY, tzOffsetMin), created: 0, done: 0, failed: 0, ...emptyTotals() }
    daily.push(d)
    byDay.set(d.date, d)
  }

  const allTasks = projectId ? data.tasks.filter((t) => t.projectId === projectId) : data.tasks
  const taskById = new Map(allTasks.map((t) => [t.id, t]))
  const names = new Map(data.projects.map((p) => [p.id, p.name]))

  const perProject = new Map<string, Stats['projects'][number]>()
  const proj = (id: string) => {
    let p = perProject.get(id)
    if (!p) {
      p = { projectId: id, name: names.get(id) ?? id, tasks: 0, byStatus: emptyStatus(), ...emptyTotals() }
      perProject.set(id, p)
    }
    return p
  }

  const totals: Stats['totals'] = { tasks: 0, byStatus: emptyStatus(), ...emptyTotals() }

  for (const t of allTasks) {
    if (inRange(t.createdAt)) {
      totals.tasks++
      totals.byStatus[t.status]++
      const p = proj(t.projectId)
      p.tasks++
      p.byStatus[t.status]++
      const d = byDay.get(dayKey(t.createdAt, tzOffsetMin))
      if (d) d.created++
    }
    if ((t.status === 'done' || t.status === 'failed') && inRange(t.updatedAt)) {
      const d = byDay.get(dayKey(t.updatedAt, tzOffsetMin))
      if (d) d[t.status]++
    }
  }

  for (const r of data.runs) {
    const t = taskById.get(r.taskId)
    if (!t || !inRange(r.startedAt)) continue
    addRun(totals, r)
    addRun(proj(t.projectId), r)
    const d = byDay.get(dayKey(r.startedAt, tzOffsetMin))
    if (d) addRun(d, r)
  }

  const projects = [...perProject.values()].sort((a, b) => b.costUsd - a.costUsd || b.tasks - a.tasks || a.name.localeCompare(b.name))
  // P5-07: hiệu quả theo tag × model — mẫu có kết quả trong khoảng thời gian, của project đang lọc.
  const byTagModel = tagModelRows(computeModelStats(allTasks, data.historyRuns ?? data.runs, data.reviews ?? [], now, from))
  return { days, from, to: now, projectId, totals, daily, projects, byTagModel }
}
