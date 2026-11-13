import { useEffect, useRef, useState } from 'react'
import { ListFilter, Search, Tag, X } from 'lucide-react'
import { PRIORITY_META } from '../lib/format'
import {
  PRIORITY_VALUES,
  activeChips,
  activeFilterCount,
  clearFilters,
  isFilterActive,
  removeChip,
  toggleValue,
  togglePriority,
  type ActiveChip,
  type BoardFilter,
} from '../lib/taskFilter'
import { inputCls } from './ui'

interface Props {
  filter: BoardFilter
  onChange: (next: BoardFilter) => void
  projects: { id: string; name: string }[]
  /** Mọi tag đang dùng (đã sắp theo mức dùng) */
  tags: string[]
  shown: number
  total: number
}

const chipCls = (on: boolean) =>
  `rounded-full border px-2.5 py-1 text-xs transition ${
    on
      ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-950 dark:text-indigo-300'
      : 'border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
  }`

/** Thanh lọc gọn: tìm kiếm + một nút "Bộ lọc" mở popover; bộ lọc đang bật hiện thành chip gỡ nhanh. */
export function BoardFilterBar({ filter, onChange, projects, tags, shown, total }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const count = activeFilterCount(filter)
  const chips = activeChips(filter)
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id
  const chipLabel = (c: ActiveChip) => (c.kind === 'project' ? projectName(c.value) : c.kind === 'priority' ? PRIORITY_META[c.value].label : c.value)

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <h1 className="mr-2 text-lg font-semibold">Bảng công việc</h1>
      <div className="relative">
        <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          className={`${inputCls} w-56 py-1.5 pl-8`}
          placeholder="Tìm theo tiêu đề, prompt, tag, #id"
          aria-label="Tìm task"
          value={filter.q}
          onChange={(e) => onChange({ ...filter, q: e.target.value })}
        />
      </div>

      <div ref={root} className="relative">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm ${
            count > 0
              ? 'border-indigo-500 text-indigo-700 dark:text-indigo-300'
              : 'border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800'
          }`}
        >
          <ListFilter size={15} /> Bộ lọc
          {count > 0 && <span className="rounded-full bg-indigo-600 px-1.5 text-xs font-medium text-white">{count}</span>}
        </button>

        {open && (
          <div
            role="dialog"
            aria-label="Bộ lọc"
            className="absolute left-0 top-full z-30 mt-1 w-80 max-w-[90vw] space-y-4 rounded-lg border border-slate-200 bg-white p-3 shadow-lg dark:border-slate-700 dark:bg-slate-900"
          >
            <section>
              <h2 className="mb-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">Project</h2>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" className={chipCls(!filter.projectId)} aria-pressed={!filter.projectId} onClick={() => onChange({ ...filter, projectId: null })}>
                  Tất cả
                </button>
                {projects.map((p) => (
                  <button key={p.id} type="button" className={chipCls(filter.projectId === p.id)} aria-pressed={filter.projectId === p.id} onClick={() => onChange({ ...filter, projectId: p.id })}>
                    {p.name}
                  </button>
                ))}
              </div>
            </section>

            <section>
              <h2 className="mb-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">Độ ưu tiên</h2>
              <div className="flex flex-wrap gap-1.5">
                {PRIORITY_VALUES.map((p) => {
                  const on = filter.priorities.includes(p)
                  return (
                    <button key={p} type="button" className={chipCls(on)} aria-pressed={on} onClick={() => onChange({ ...filter, priorities: togglePriority(filter.priorities, p) })}>
                      {PRIORITY_META[p].label}
                    </button>
                  )
                })}
              </div>
            </section>

            {tags.length > 0 && (
              <section>
                <h2 className="mb-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">Tag (cần có đủ)</h2>
                <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                  {tags.map((t) => {
                    const on = filter.tags.some((x) => x.toLowerCase() === t.toLowerCase())
                    return (
                      <button key={t} type="button" className={chipCls(on)} aria-pressed={on} onClick={() => onChange({ ...filter, tags: toggleValue(filter.tags, t) })}>
                        {t}
                      </button>
                    )
                  })}
                </div>
              </section>
            )}

            <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={filter.showAll} onChange={(e) => onChange({ ...filter, showAll: e.target.checked })} />
              Hiện cả Done/Failed cũ hơn 24 giờ
            </label>

            <div className="flex items-center justify-between border-t border-slate-200 pt-2 dark:border-slate-700">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {shown}/{total} task
              </span>
              <button
                type="button"
                disabled={count === 0}
                onClick={() => onChange(clearFilters(filter))}
                className="text-xs text-indigo-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline dark:text-indigo-300"
              >
                Đặt lại
              </button>
            </div>
          </div>
        )}
      </div>

      {chips.map((c) => (
        <span key={`${c.kind}:${c.value}`} className="inline-flex items-center gap-1 rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
          {c.kind === 'tag' && <Tag size={11} />}
          {c.kind === 'project' && <span className="opacity-60">Project:</span>}
          {c.kind === 'priority' && <span className="opacity-60">Ưu tiên:</span>}
          {chipLabel(c)}
          <button type="button" onClick={() => onChange(removeChip(filter, c))} className="rounded hover:text-indigo-900 dark:hover:text-white" aria-label={`Bỏ lọc ${chipLabel(c)}`}>
            <X size={12} />
          </button>
        </span>
      ))}

      {isFilterActive(filter) && (
        <>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {shown}/{total} task
          </span>
          <button type="button" onClick={() => onChange(clearFilters(filter, false))} className="text-xs text-slate-500 hover:underline dark:text-slate-400">
            Xoá tất cả
          </button>
        </>
      )}
    </div>
  )
}
