// Lên lịch tạo task theo cron (PLAN 4.6): danh sách lịch, bật/tắt, lần chạy kế tiếp, lịch sử task đã tạo.
// Dùng trong trang Cài đặt, cùng kiểu với TemplateManager.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react'
import { deleteSchedule, fetchScheduleRuns, onScheduleRun, previewCron, saveSchedule, setScheduleEnabled, useStore } from '../store/store'
import { PRIORITY_META } from '../lib/format'
import type { Priority, Schedule, ScheduleRun } from '../types'
import { Button, ConfirmDialog, Field, Modal, StatusBadge, inputCls } from './ui'

const fmt = (ts: number) =>
  new Date(ts).toLocaleString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const CRON_EXAMPLES: [string, string][] = [
  ['0 9 * * 1-5', '9:00 các ngày thứ 2–6'],
  ['0 */6 * * *', 'mỗi 6 giờ'],
  ['30 8 1 * *', '8:30 ngày 1 hằng tháng'],
]

function ScheduleFormModal({ open, onClose, editing }: { open: boolean; onClose: () => void; editing?: Schedule }) {
  const { projects } = useStore()
  const [cron, setCron] = useState('')
  const [projectId, setProjectId] = useState('')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [priority, setPriority] = useState<Priority>('normal')
  const [enabled, setEnabled] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<{ next?: number[]; error?: string }>({})

  useEffect(() => {
    if (!open) return
    setError(null)
    setCron(editing?.cron ?? '0 9 * * 1-5')
    setProjectId(editing?.projectId ?? projects[0]?.id ?? '')
    setTitle(editing?.title ?? '')
    setPrompt(editing?.prompt ?? '')
    setPriority(editing?.priority ?? 'normal')
    setEnabled(editing?.enabled ?? true)
    // Chỉ khởi tạo khi mở form; không reset khi danh sách project cập nhật qua WS
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing])

  // Xem trước 3 lần chạy kế tiếp (chờ người dùng gõ xong)
  useEffect(() => {
    if (!open) return
    if (!cron.trim()) return setPreview({})
    let alive = true
    const t = setTimeout(() => {
      previewCron(cron)
        .then((next) => alive && setPreview({ next }))
        .catch((e: Error) => alive && setPreview({ error: e.message }))
    }, 300)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [cron, open])

  async function submit() {
    setSaving(true)
    const err = await saveSchedule({ id: editing?.id, cron, projectId, title, prompt, priority, enabled })
    setSaving(false)
    if (err) setError(err)
    else onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Sửa lịch' : 'Thêm lịch'}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="primary" disabled={saving} onClick={submit}>
            Lưu lịch
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{error}</div>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Biểu thức cron" hint="phút giờ ngày tháng thứ · theo giờ của máy chạy server">
            <input autoFocus className={`${inputCls} font-mono`} value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * 1-5" />
          </Field>
          <div className="text-xs text-slate-500">
            <p className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">Lần chạy kế tiếp</p>
            {preview.error ? (
              <p className="text-rose-600">{preview.error}</p>
            ) : preview.next ? (
              <ul className="space-y-0.5">
                {preview.next.map((t) => (
                  <li key={t}>{fmt(t)}</li>
                ))}
              </ul>
            ) : (
              <p>—</p>
            )}
            <p className="mt-2">
              Ví dụ:{' '}
              {CRON_EXAMPLES.map(([ex, label], i) => (
                <span key={ex}>
                  {i > 0 && ' · '}
                  <button type="button" className="font-mono text-indigo-600 hover:underline dark:text-indigo-400" title={label} onClick={() => setCron(ex)}>
                    {ex}
                  </button>
                </span>
              ))}
            </p>
          </div>
          <Field label="Project">
            <select className={inputCls} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.length === 0 && <option value="">(chưa có project)</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Độ ưu tiên">
            <select className={inputCls} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {(['urgent', 'high', 'normal', 'low'] as Priority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_META[p].label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Tiêu đề task">
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="VD: Cập nhật dependencies hằng tuần" />
        </Field>
        <Field label="Prompt" hint="Task tạo ra sẽ vào thẳng Queued">
          <textarea className={`${inputCls} min-h-[140px] font-mono text-[13px]`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Bật lịch
        </label>
      </div>
    </Modal>
  )
}

/** Lịch sử task đã tạo; tải khi mở, cập nhật realtime khi lịch tạo task mới. */
function ScheduleHistory({ scheduleId }: { scheduleId: string }) {
  const { tasks } = useStore()
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetchScheduleRuns(scheduleId)
      .then((r) => alive && setRuns(r))
      .catch((e: Error) => alive && setError(e.message))
    const off = onScheduleRun((r) => {
      if (r.scheduleId === scheduleId) setRuns((cur) => (cur && !cur.some((x) => x.id === r.id) ? [r, ...cur] : cur))
    })
    return () => {
      alive = false
      off()
    }
  }, [scheduleId])

  if (error) return <p className="text-xs text-rose-600">{error}</p>
  if (!runs) return <p className="text-xs text-slate-500">Đang tải…</p>
  if (runs.length === 0) return <p className="text-xs text-slate-500">Chưa tạo task nào.</p>
  return (
    <ul className="space-y-1 text-xs">
      {runs.map((r) => {
        const task = r.taskId !== undefined ? tasks.find((t) => t.id === r.taskId) : undefined
        return (
          <li key={r.id} className="flex flex-wrap items-center gap-2">
            <span className="text-slate-500">{fmt(r.firedAt)}</span>
            {task ? (
              <Link to={`/tasks/${task.id}`} className="text-indigo-600 hover:underline dark:text-indigo-400">
                #{task.id} {task.title}
              </Link>
            ) : (
              <span className="text-slate-400 line-through" title="Task đã bị xoá">
                {r.taskId !== undefined ? `#${r.taskId} ` : ''}
                {r.title}
              </span>
            )}
            {task && <StatusBadge status={task.status} />}
            {r.catchUp && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950 dark:text-amber-300" title={`Theo lịch: ${fmt(r.scheduledFor)}`}>
                tạo bù
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function ScheduleManager() {
  const { schedules, projects } = useStore()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Schedule | undefined>()
  const [del, setDel] = useState<Schedule | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id

  return (
    <>
      {schedules.length === 0 ? (
        <p className="text-sm text-slate-500">Chưa có lịch nào. Lịch sẽ tự tạo task ở Queued theo biểu thức cron.</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {schedules.map((s) => (
            <li key={s.id} className="px-3 py-2">
              <div className="flex items-start gap-3">
                <button
                  className="mt-0.5 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                  title="Lịch sử task đã tạo"
                  onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                >
                  {expanded === s.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className={`font-medium ${s.enabled ? '' : 'text-slate-400'}`}>{s.title}</span>
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">{s.cron}</code>
                    <span className="text-xs text-slate-500">· {projectName(s.projectId)}</span>
                    <span className={`text-xs ${PRIORITY_META[s.priority].cls}`}>· {PRIORITY_META[s.priority].label}</span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {s.enabled ? (s.nextRunAt ? `Lần kế tiếp: ${fmt(s.nextRunAt)}` : 'Không có lần chạy kế tiếp') : 'Đang tắt'}
                    {s.lastRunAt ? ` · Lần gần nhất: ${fmt(s.lastRunAt)}` : ''}
                  </p>
                </div>
                <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300" title={s.enabled ? 'Tắt lịch' : 'Bật lịch'}>
                  <input type="checkbox" checked={s.enabled} onChange={(e) => setScheduleEnabled(s.id, e.target.checked)} />
                  Bật
                </label>
                <button
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                  title="Sửa"
                  onClick={() => {
                    setEditing(s)
                    setFormOpen(true)
                  }}
                >
                  <Pencil size={16} />
                </button>
                <button className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40" title="Xoá" onClick={() => setDel(s)}>
                  <Trash2 size={16} />
                </button>
              </div>
              {expanded === s.id && (
                <div className="mt-2 pl-7">
                  <ScheduleHistory scheduleId={s.id} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Button
        size="sm"
        disabled={projects.length === 0}
        title={projects.length === 0 ? 'Cần thêm project trước' : undefined}
        onClick={() => {
          setEditing(undefined)
          setFormOpen(true)
        }}
      >
        <Plus size={14} /> Thêm lịch
      </Button>

      <ScheduleFormModal open={formOpen} onClose={() => setFormOpen(false)} editing={editing} />
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        title={`Xoá lịch "${del?.title}"?`}
        message="Lịch sử của lịch này bị xoá theo. Task đã tạo không bị ảnh hưởng."
        confirmLabel="Xoá"
        danger
        onConfirm={() => del && deleteSchedule(del.id)}
      />
    </>
  )
}
