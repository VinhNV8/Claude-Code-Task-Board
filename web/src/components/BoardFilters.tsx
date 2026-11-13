import { useState, type ReactNode } from 'react'
import { Check, ListFilter, PanelLeftClose, Plus, Search, Tag, X } from 'lucide-react'
import { PRIORITY_META } from '../lib/format'
import {
  PRIORITY_VALUES,
  activeChips,
  activeFilterCount,
  clearFilters,
  fold,
  isFilterActive,
  removeChip,
  toggleProject,
  togglePriority,
  toggleValue,
  type ActiveChip,
  type BoardFilter,
  type FacetCounts,
} from '../lib/taskFilter'
import { inputCls } from './ui'

type ProjectLite = { id: string; name: string; repoPath?: string }

/** Từ số lượng này trở lên thì hiện ô tìm trong nhóm Project / Tag */
const SEARCH_THRESHOLD = 8

const stickyCls = 'md:sticky md:top-[4.5rem] md:max-h-[calc(100vh-6rem)]'

// ------------------------------------------------------------ panel trái

interface PanelProps {
  filter: BoardFilter
  onChange: (next: BoardFilter) => void
  projects: ProjectLite[]
  /** Mọi tag đang dùng (đã sắp theo mức dùng) */
  tags: string[]
  counts: FacetCounts
  /** Số task cần xử lý (Review + Needs input) theo project */
  attention: Record<string, number>
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  /** Màn hình nhỏ: panel chỉ hiện khi bấm nút "Bộ lọc" trên thanh công cụ */
  mobileOpen: boolean
  /** Mở form thêm project ngay tại Bảng công việc */
  onAddProject: () => void
}

type BodyProps = Omit<PanelProps, 'collapsed' | 'onCollapsedChange' | 'mobileOpen'>

/** Panel lọc bên trái Bảng công việc: Project (đa chọn), Độ ưu tiên, Tag, Done/Failed cũ. */
export function BoardFilterPanel({ collapsed, onCollapsedChange, mobileOpen, ...body }: PanelProps) {
  const { filter, onChange, onAddProject } = body
  const count = activeFilterCount(filter)

  if (collapsed)
    return (
      <>
        {mobileOpen && <MobilePanel {...body} />}
        <aside className={`hidden w-10 shrink-0 flex-col items-center gap-2 rounded-lg border border-slate-200 bg-white py-2 md:flex dark:border-slate-800 dark:bg-slate-900 ${stickyCls}`}>
          <button
            type="button"
            onClick={() => onCollapsedChange(false)}
            className="relative rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            aria-label="Mở panel Bộ lọc"
            title="Mở panel Bộ lọc"
          >
            <ListFilter size={18} />
            {count > 0 && <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-indigo-600 px-1 text-[10px] font-medium text-white">{count}</span>}
          </button>
          <button
            type="button"
            onClick={onAddProject}
            className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            aria-label="Thêm project"
            title="Thêm project"
          >
            <Plus size={18} />
          </button>
        </aside>
      </>
    )

  return (
    <aside
      aria-label="Bộ lọc"
      className={`${mobileOpen ? 'flex' : 'hidden'} w-full shrink-0 flex-col rounded-lg border border-slate-200 bg-white md:flex md:w-60 dark:border-slate-800 dark:bg-slate-900 ${stickyCls}`}
    >
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-slate-800">
        <ListFilter size={15} className="text-slate-500" />
        <span className="text-sm font-semibold">Bộ lọc</span>
        {count > 0 && <span className="rounded-full bg-indigo-600 px-1.5 text-xs font-medium text-white">{count}</span>}
        <button
          type="button"
          disabled={count === 0}
          onClick={() => onChange(clearFilters(filter))}
          className="ml-auto text-xs text-indigo-600 hover:underline disabled:invisible dark:text-indigo-300"
        >
          Đặt lại
        </button>
        <button
          type="button"
          onClick={() => onCollapsedChange(true)}
          className="hidden rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 md:block dark:hover:bg-slate-800 dark:hover:text-slate-200"
          aria-label="Thu gọn panel Bộ lọc"
          title="Thu gọn panel Bộ lọc"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>
      <PanelBody {...body} />
    </aside>
  )
}

/** Panel thu gọn trên desktop nhưng người dùng mở trên mobile: vẫn hiện bản đầy đủ (chỉ mobile). */
function MobilePanel(props: BodyProps) {
  return (
    <aside aria-label="Bộ lọc" className="flex w-full flex-col rounded-lg border border-slate-200 bg-white md:hidden dark:border-slate-800 dark:bg-slate-900">
      <PanelBody {...props} />
    </aside>
  )
}

function PanelBody({ filter, onChange, projects, tags, counts, attention, onAddProject }: BodyProps) {
  const [pq, setPq] = useState('')
  const [tq, setTq] = useState('')
  const shownProjects = pq ? projects.filter((p) => fold(p.name).includes(fold(pq))) : projects
  const shownTags = tq ? tags.filter((t) => fold(t).includes(fold(tq))) : tags
  const tagOn = (t: string) => filter.tags.some((x) => x.toLowerCase() === t.toLowerCase())

  return (
    <div className="flex-1 overflow-y-auto">
      <Section
        title="Project"
        selected={filter.projectIds.length}
        onClear={() => onChange({ ...filter, projectIds: [] })}
        action={
          <button
            type="button"
            onClick={onAddProject}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Thêm project"
            title="Thêm project"
          >
            <Plus size={14} />
          </button>
        }
      >
        {projects.length >= SEARCH_THRESHOLD && <SearchBox value={pq} onChange={setPq} placeholder="Tìm project…" />}
        {shownProjects.map((p) => (
          <FacetRow
            key={p.id}
            label={p.name}
            title={p.repoPath}
            on={filter.projectIds.includes(p.id)}
            count={counts.projects[p.id] ?? 0}
            badge={attention[p.id] ? <AttentionBadge n={attention[p.id]} /> : null}
            onToggle={() => onChange({ ...filter, projectIds: toggleProject(filter.projectIds, p.id) })}
            onOnly={() => onChange({ ...filter, projectIds: [p.id] })}
          />
        ))}
        {shownProjects.length === 0 && <Empty>Không thấy project</Empty>}
      </Section>

      <Section title="Độ ưu tiên" selected={filter.priorities.length} onClear={() => onChange({ ...filter, priorities: [] })}>
        {PRIORITY_VALUES.map((p) => (
          <FacetRow
            key={p}
            label={PRIORITY_META[p].label}
            labelCls={PRIORITY_META[p].cls}
            on={filter.priorities.includes(p)}
            count={counts.priorities[p]}
            onToggle={() => onChange({ ...filter, priorities: togglePriority(filter.priorities, p) })}
            onOnly={() => onChange({ ...filter, priorities: [p] })}
          />
        ))}
      </Section>

      {tags.length > 0 && (
        <Section title="Tag (cần có đủ)" selected={filter.tags.length} onClear={() => onChange({ ...filter, tags: [] })}>
          {tags.length >= SEARCH_THRESHOLD && <SearchBox value={tq} onChange={setTq} placeholder="Tìm tag…" />}
          <div className="max-h-56 overflow-y-auto">
            {shownTags.map((t) => (
              <FacetRow
                key={t}
                label={t}
                on={tagOn(t)}
                count={counts.tags[t.toLowerCase()] ?? 0}
                onToggle={() => onChange({ ...filter, tags: toggleValue(filter.tags, t) })}
              />
            ))}
            {shownTags.length === 0 && <Empty>Không thấy tag</Empty>}
          </div>
        </Section>
      )}

      <label className="flex items-center gap-2 px-4 py-3 text-xs text-slate-600 dark:text-slate-300">
        <input type="checkbox" checked={filter.showAll} onChange={(e) => onChange({ ...filter, showAll: e.target.checked })} />
        Hiện cả Done cũ hơn 24 giờ
      </label>
    </div>
  )
}

function Section({ title, selected, onClear, action, children }: { title: string; selected: number; onClear: () => void; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-slate-200 px-2 py-2.5 dark:border-slate-800">
      <div className="mb-1 flex items-center px-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{title}</h2>
        <div className="ml-auto flex items-center gap-1.5">
          {selected > 0 && (
            <button type="button" onClick={onClear} className="text-[11px] text-indigo-600 hover:underline dark:text-indigo-300">
              Bỏ chọn ({selected})
            </button>
          )}
          {action}
        </div>
      </div>
      {children}
    </section>
  )
}

/** Một lựa chọn lọc: ô tích + nhãn + số task; rê chuột hiện nút "chỉ" để chọn riêng giá trị này. */
function FacetRow({
  label,
  labelCls = '',
  title,
  on,
  count,
  badge,
  onToggle,
  onOnly,
}: {
  label: string
  labelCls?: string
  title?: string
  on: boolean
  count: number
  badge?: ReactNode
  onToggle: () => void
  onOnly?: () => void
}) {
  const dim = !on && count === 0
  return (
    <div className="group flex items-center">
      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        onClick={onToggle}
        title={title}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
      >
        <span
          className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${
            on ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 dark:border-slate-600'
          }`}
        >
          {on && <Check size={11} strokeWidth={3} />}
        </span>
        <span className={`min-w-0 flex-1 truncate ${on ? 'font-medium' : ''} ${dim ? 'text-slate-400 dark:text-slate-500' : labelCls}`}>{label}</span>
        {badge}
        <span className={`w-6 text-right text-xs tabular-nums text-slate-400 ${onOnly ? 'group-focus-within:hidden group-hover:hidden' : ''}`}>{count}</span>
      </button>
      {onOnly && (
        <button
          type="button"
          onClick={onOnly}
          aria-label={`Chỉ lọc ${label}`}
          className="hidden shrink-0 rounded px-1.5 py-0.5 text-[11px] text-indigo-600 hover:bg-indigo-50 group-focus-within:block group-hover:block dark:text-indigo-300 dark:hover:bg-indigo-950"
        >
          chỉ
        </button>
      )}
    </div>
  )
}

function AttentionBadge({ n }: { n: number }) {
  return (
    <span className="shrink-0 rounded-full bg-violet-500 px-1.5 text-[11px] font-semibold text-white" title="Cần xử lý (Review + Needs input)">
      {n}
    </span>
  )
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative mx-1 mb-1">
      <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
      <input className={`${inputCls} py-1 pl-7 text-xs`} placeholder={placeholder} aria-label={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-2 text-center text-xs text-slate-400">{children}</p>
}

// ------------------------------------------------------------ thanh công cụ phía trên bảng

interface ToolbarProps {
  filter: BoardFilter
  onChange: (next: BoardFilter) => void
  projects: ProjectLite[]
  shown: number
  total: number
  /** Hiện chip các bộ lọc đang bật (khi panel đang thu gọn/đóng) */
  showChips: boolean
  mobileOpen: boolean
  onToggleMobile: () => void
  /** Phần tử đặt ở cuối thanh (nút chuyển cách xem) */
  right?: ReactNode
}

export function BoardToolbar({ filter, onChange, projects, shown, total, showChips, mobileOpen, onToggleMobile, right }: ToolbarProps) {
  const count = activeFilterCount(filter)
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id
  const chipLabel = (c: ActiveChip) => (c.kind === 'project' ? projectName(c.value) : c.kind === 'priority' ? PRIORITY_META[c.value].label : c.value)
  const ids = filter.projectIds

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <h1 className="text-lg font-semibold">Công việc</h1>
      {ids.length > 0 && (
        <span className="mr-1 max-w-[16rem] truncate text-lg text-slate-400" title={ids.map(projectName).join(', ')}>
          / <span className="text-slate-700 dark:text-slate-200">{ids.length === 1 ? projectName(ids[0]) : `${ids.length} project`}</span>
        </span>
      )}
      <div className="relative ml-1">
        <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          className={`${inputCls} w-56 py-1.5 pl-8`}
          placeholder="Tìm theo tiêu đề, prompt, tag, #id"
          aria-label="Tìm task"
          value={filter.q}
          onChange={(e) => onChange({ ...filter, q: e.target.value })}
        />
      </div>

      <button
        type="button"
        aria-expanded={mobileOpen}
        onClick={onToggleMobile}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm md:hidden ${
          count > 0 ? 'border-indigo-500 text-indigo-700 dark:text-indigo-300' : 'border-slate-300 text-slate-700 dark:border-slate-700 dark:text-slate-200'
        }`}
      >
        <ListFilter size={15} /> Bộ lọc
        {count > 0 && <span className="rounded-full bg-indigo-600 px-1.5 text-xs font-medium text-white">{count}</span>}
      </button>

      {showChips &&
        activeChips(filter).map((c) => (
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
      {right && <div className="ml-auto">{right}</div>}
    </div>
  )
}
