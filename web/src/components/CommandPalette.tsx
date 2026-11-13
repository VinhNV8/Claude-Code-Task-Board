import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ChartColumn, FolderGit2, KanbanSquare, Plus, Radar, Rows3, Search, Settings as SettingsIcon } from 'lucide-react'
import { useStore } from '../store/store'
import { StatusGlyph } from './ui'
import { fold } from '../lib/taskFilter'
import { VIEW_STORAGE_KEY, searchTasks, withParams, type WorkView } from '../lib/workView'

interface Item {
  id: string
  label: string
  hint?: string
  icon: ReactNode
  run: () => void
}

/** Bảng lệnh Ctrl K: tìm task theo tên/#id, đổi cách xem, giao việc, chuyển trang. */
export function CommandPalette({ open, onClose, onNewTask }: { open: boolean; onClose: () => void; onNewTask: () => void }) {
  const s = useStore()
  const navigate = useNavigate()
  const loc = useLocation()
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQ('')
    setHi(0)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  // Trên trang Công việc thì giữ bộ lọc đang có; trang khác thì về trang Công việc
  const goWork = (patch: Record<string, string | null>) => {
    const base = loc.pathname === '/' ? new URLSearchParams(loc.search) : new URLSearchParams()
    navigate({ pathname: '/', search: `?${withParams(base, patch)}` })
  }
  const storedView = (): WorkView | null => {
    try {
      return (localStorage.getItem(VIEW_STORAGE_KEY) as WorkView | null) ?? null
    } catch {
      return null
    }
  }

  const items = useMemo<Item[]>(() => {
    const actions: Item[] = [
      { id: 'new', label: 'Giao việc mới', hint: 'N', icon: <Plus size={16} />, run: onNewTask },
      { id: 'v-board', label: 'Xem dạng Bảng', hint: '1', icon: <KanbanSquare size={16} />, run: () => goWork({ view: 'board' }) },
      { id: 'v-ops', label: 'Xem Điều phối · Cần bạn', hint: '2', icon: <Radar size={16} />, run: () => goWork({ view: 'ops' }) },
      { id: 'v-triage', label: 'Xem Phân luồng', hint: '3', icon: <Rows3 size={16} />, run: () => goWork({ view: 'triage' }) },
      { id: 'projects', label: 'Mở Projects', icon: <FolderGit2 size={16} />, run: () => navigate('/projects') },
      { id: 'stats', label: 'Mở Thống kê', icon: <ChartColumn size={16} />, run: () => navigate('/stats') },
      { id: 'settings', label: 'Mở Cài đặt', icon: <SettingsIcon size={16} />, run: () => navigate('/settings') },
    ]
    const needle = fold(q.trim()).toLowerCase()
    const shownActions = needle ? actions.filter((a) => fold(a.label).toLowerCase().includes(needle)) : actions.slice(0, 4)
    const tasks = searchTasks(s.tasks, q, 8).map<Item>((t) => ({
      id: `t${t.id}`,
      label: t.title,
      hint: `#${t.id}`,
      icon: <StatusGlyph status={t.status} />,
      run: () => goWork({ task: String(t.id), view: loc.pathname === '/' ? new URLSearchParams(loc.search).get('view') : storedView() }),
    }))
    return [...shownActions, ...tasks]
  }, [q, s.tasks, loc.pathname, loc.search])

  useEffect(() => setHi(0), [q])

  if (!open) return null

  const pick = (it?: Item) => {
    if (!it) return
    onClose()
    it.run()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Bảng lệnh"
        className="w-full max-w-xl overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 dark:border-slate-800">
          <Search size={16} className="text-slate-400" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setHi((h) => Math.min(items.length - 1, h + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setHi((h) => Math.max(0, h - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                pick(items[hi])
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              }
            }}
            placeholder="Tìm task theo tên hoặc #id, hoặc gõ lệnh…"
            aria-label="Tìm task hoặc lệnh"
            className="w-full bg-transparent py-3.5 text-sm outline-none"
          />
          <kbd className="rounded border border-slate-300 px-1.5 font-mono text-[10px] text-slate-400 dark:border-slate-600">Esc</kbd>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto py-1.5" role="listbox">
          {items.length === 0 && <li className="px-4 py-6 text-center text-sm text-slate-400">Không tìm thấy task hay lệnh nào</li>}
          {items.map((it, i) => (
            <li key={it.id} role="option" aria-selected={i === hi}>
              <button
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(it)}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm ${i === hi ? 'bg-slate-100 dark:bg-slate-800' : ''}`}
              >
                <span className="text-slate-500 dark:text-slate-400">{it.icon}</span>
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.hint && <span className="shrink-0 font-mono text-[11px] text-slate-400">{it.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
