// Trang Thống kê (PLAN 4.4): số task, chi phí, số turns, thời gian chạy theo ngày và theo project.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChartColumn, Clock, DollarSign, ListTodo, RefreshCw, Repeat } from 'lucide-react'
import { fetchStats, useStore } from '../store/store'
import { Button, EmptyState, inputCls } from '../components/ui'
import { STATUS_META, STATUS_ORDER } from '../lib/format'
import type { Stats as StatsData, StatsDay, StatsRange } from '../types'

const RANGES: StatsRange[] = [7, 30, 90]

type Metric = 'costUsd' | 'created' | 'turns' | 'durationMs'
const METRICS: { key: Metric; label: string; fmt: (v: number) => string }[] = [
  { key: 'costUsd', label: 'Chi phí', fmt: (v) => money(v) },
  { key: 'created', label: 'Task tạo mới', fmt: (v) => String(v) },
  { key: 'turns', label: 'Turns', fmt: (v) => v.toLocaleString('vi-VN') },
  { key: 'durationMs', label: 'Thời gian chạy', fmt: (v) => hours(v) },
]

function money(v: number) {
  return `$${v.toFixed(v > 0 && v < 1 ? 3 : 2)}`
}

/** Thời gian chạy: 45s, 12p, 3g 05p */
function hours(ms: number) {
  const m = Math.round(ms / 60_000)
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (m < 60) return `${m}p`
  return `${Math.floor(m / 60)}g ${String(m % 60).padStart(2, '0')}p`
}

/** YYYY-MM-DD -> 12/11 */
const shortDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`

const card = 'rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900'

export function Stats() {
  const s = useStore()
  const [days, setDays] = useState<StatsRange>(7)
  const [projectId, setProjectId] = useState('')
  const [data, setData] = useState<StatsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [reload, setReload] = useState(0)
  const reqId = useRef(0)

  // Tải lại khi đổi bộ lọc; khi task/lần chạy thay đổi (qua WS) thì tải lại sau 1 giây để gộp nhiều cập nhật.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const id = setTimeout(() => setReload((n) => n + 1), 1000)
    return () => clearTimeout(id)
  }, [s.tasks, s.runs])

  useEffect(() => {
    const id = ++reqId.current
    setLoading(true)
    fetchStats(days, projectId || undefined)
      .then((d) => {
        if (id !== reqId.current) return
        setData(d)
        setError(null)
      })
      .catch((e: Error) => id === reqId.current && setError(e.message))
      .finally(() => id === reqId.current && setLoading(false))
  }, [days, projectId, reload])

  // Project đang lọc bị xoá: quay về tất cả
  useEffect(() => {
    if (projectId && !s.projects.some((p) => p.id === projectId)) setProjectId('')
  }, [projectId, s.projects])

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-lg font-semibold">Thống kê</h1>
        <select className={`${inputCls} w-auto py-1.5`} value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Lọc theo project">
          <option value="">Tất cả project</option>
          {s.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="inline-flex rounded-md ring-1 ring-slate-300 dark:ring-slate-700" role="group" aria-label="Khoảng thời gian">
          {RANGES.map((r, i) => (
            <button
              key={r}
              onClick={() => setDays(r)}
              aria-pressed={days === r}
              className={`px-3 py-1.5 text-sm font-medium ${i === 0 ? 'rounded-l-md' : ''} ${i === RANGES.length - 1 ? 'rounded-r-md' : ''} ${
                days === r
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white text-slate-700 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              {r} ngày
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setReload((n) => n + 1)} title="Tải lại" aria-label="Tải lại">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </Button>
      </div>

      {error && !data ? (
        <div className={card}>
          <EmptyState icon={<ChartColumn size={48} />} title="Không tải được thống kê" body={error} action={<Button onClick={() => setReload((n) => n + 1)}>Thử lại</Button>} />
        </div>
      ) : !data ? (
        <p className="py-12 text-center text-sm text-slate-400">Đang tải thống kê…</p>
      ) : (
        <StatsBody data={data} />
      )}
    </div>
  )
}

function StatsBody({ data }: { data: StatsData }) {
  const t = data.totals
  const avgCost = t.runs ? t.costUsd / t.runs : 0
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile icon={<ListTodo size={16} />} label="Task tạo mới" value={String(t.tasks)} sub={`${t.byStatus.done} done · ${t.byStatus.failed} failed`} />
        <Tile icon={<DollarSign size={16} />} label="Tổng chi phí" value={money(t.costUsd)} sub={t.runs ? `TB ${money(avgCost)} / lần chạy` : 'Chưa có lần chạy'} />
        <Tile icon={<Repeat size={16} />} label="Số turns" value={t.turns.toLocaleString('vi-VN')} sub={`${t.runs} lần chạy`} />
        <Tile icon={<Clock size={16} />} label="Thời gian chạy" value={hours(t.durationMs)} sub={t.runs ? `TB ${hours(t.durationMs / t.runs)} / lần chạy` : '—'} />
      </div>

      <DailyChart daily={data.daily} />

      <div className="grid gap-4 lg:grid-cols-3">
        <StatusBreakdown byStatus={t.byStatus} total={t.tasks} />
        <ProjectTable data={data} />
      </div>
    </>
  )
}

function Tile({ icon, label, value, sub }: { icon: ReactNode; label: string; value: string; sub: string }) {
  return (
    <div className={card}>
      <p className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
        <span className="text-indigo-500">{icon}</span> {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{sub}</p>
    </div>
  )
}

function DailyChart({ daily }: { daily: StatsDay[] }) {
  const [metric, setMetric] = useState<Metric>('costUsd')
  const [hover, setHover] = useState<number | null>(null)
  const m = METRICS.find((x) => x.key === metric)!
  const values = daily.map((d) => d[metric])
  const max = Math.max(0, ...values)
  const sum = values.reduce((a, b) => a + b, 0)
  const shown = hover !== null ? daily[hover] : null
  // Nhãn trục X: khoảng 7 nhãn, luôn có ngày cuối
  const step = Math.max(1, Math.ceil(daily.length / 7))

  return (
    <section className={card}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-semibold">Theo ngày</h2>
        <div className="flex flex-wrap gap-1">
          {METRICS.map((x) => (
            <button
              key={x.key}
              onClick={() => setMetric(x.key)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                metric === x.key
                  ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>

      <p className="mb-2 h-5 text-xs text-slate-500 dark:text-slate-400">
        {shown ? (
          <>
            <span className="font-medium text-slate-700 dark:text-slate-200">{shortDate(shown.date)}</span>
            {' · '}
            {money(shown.costUsd)} · {shown.created} task mới · {shown.done} done · {shown.failed} failed · {shown.runs} lần chạy · {shown.turns} turns ·{' '}
            {hours(shown.durationMs)}
          </>
        ) : (
          <>
            Tổng {m.label.toLowerCase()}: <span className="font-medium text-slate-700 dark:text-slate-200">{m.fmt(sum)}</span>. Di chuột lên cột để xem chi tiết.
          </>
        )}
      </p>

      {max === 0 ? (
        <div className="grid h-40 place-items-center rounded-md border border-dashed border-slate-200 text-sm text-slate-400 dark:border-slate-800">
          Chưa có dữ liệu trong khoảng thời gian này
        </div>
      ) : (
        <div className="flex">
          <div className="flex h-40 w-14 shrink-0 flex-col justify-between pr-2 text-right text-[10px] tabular-nums text-slate-400">
            <span>{m.fmt(max)}</span>
            <span>0</span>
          </div>
          <div className="relative h-40 flex-1 border-b border-l border-slate-200 dark:border-slate-700" onMouseLeave={() => setHover(null)}>
            <div className="absolute inset-x-0 top-0 border-t border-dashed border-slate-100 dark:border-slate-800" />
            <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-slate-100 dark:border-slate-800" />
            <div className={`relative flex h-full items-end ${daily.length > 40 ? 'gap-px' : 'gap-1'} px-1`}>
              {daily.map((d, i) => {
                const v = d[metric]
                return (
                  <div
                    key={d.date}
                    className="flex h-full flex-1 cursor-default items-end"
                    onMouseEnter={() => setHover(i)}
                    title={`${shortDate(d.date)}: ${m.fmt(v)}`}
                  >
                    <div
                      className={`w-full rounded-t-sm ${hover === i ? 'bg-indigo-400 dark:bg-indigo-300' : 'bg-indigo-500 dark:bg-indigo-400'}`}
                      style={{ height: v > 0 ? `max(2px, ${(v / max) * 100}%)` : 0 }}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
      <div className="ml-14 flex px-1 pt-1 text-[10px] text-slate-400">
        {daily.map((d, i) => (
          <span key={d.date} className="flex-1 text-center">
            {(daily.length - 1 - i) % step === 0 ? shortDate(d.date) : ''}
          </span>
        ))}
      </div>
    </section>
  )
}

function StatusBreakdown({ byStatus, total }: { byStatus: StatsData['totals']['byStatus']; total: number }) {
  return (
    <section className={card}>
      <h2 className="mb-1 font-semibold">Task theo trạng thái</h2>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">Task tạo trong khoảng thời gian, theo trạng thái hiện tại</p>
      {total === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">Chưa có task</p>
      ) : (
        <>
          <div className="mb-3 flex h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            {STATUS_ORDER.filter((st) => byStatus[st] > 0).map((st) => (
              <div key={st} className={STATUS_META[st].dot} style={{ width: `${(byStatus[st] / total) * 100}%` }} title={`${STATUS_META[st].label}: ${byStatus[st]}`} />
            ))}
          </div>
          <ul className="space-y-1.5 text-sm">
            {STATUS_ORDER.map((st) => (
              <li key={st} className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${STATUS_META[st].dot}`} />
                <span className="text-slate-600 dark:text-slate-300">{STATUS_META[st].label}</span>
                <span className="ml-auto tabular-nums font-medium">{byStatus[st]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function ProjectTable({ data }: { data: StatsData }) {
  return (
    <section className={`${card} overflow-x-auto lg:col-span-2`}>
      <h2 className="mb-3 font-semibold">Theo project</h2>
      {data.projects.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">Chưa có hoạt động trong khoảng thời gian này</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
              <th className="pb-2 font-medium">Project</th>
              <th className="pb-2 text-right font-medium">Task</th>
              <th className="pb-2 text-right font-medium">Lần chạy</th>
              <th className="pb-2 text-right font-medium">Turns</th>
              <th className="pb-2 text-right font-medium">Thời gian</th>
              <th className="pb-2 text-right font-medium">Chi phí</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {data.projects.map((p) => (
              <tr key={p.projectId} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                <td className="max-w-[12rem] truncate py-2 font-medium" title={p.name}>
                  {p.name}
                </td>
                <td className="py-2 text-right" title={`${p.byStatus.done} done · ${p.byStatus.failed} failed`}>
                  {p.tasks}
                </td>
                <td className="py-2 text-right">{p.runs}</td>
                <td className="py-2 text-right">{p.turns.toLocaleString('vi-VN')}</td>
                <td className="py-2 text-right">{hours(p.durationMs)}</td>
                <td className="py-2 text-right font-medium">{money(p.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
