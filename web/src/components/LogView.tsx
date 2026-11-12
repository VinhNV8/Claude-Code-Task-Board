import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  Bot,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FilePen,
  FileSearch,
  FileText,
  Globe,
  Info,
  ListChecks,
  Search,
  Terminal,
  Users,
  Wrench,
} from 'lucide-react'
import type { LogEvent } from '../types'
import { clock } from '../lib/format'
import { Markdown } from './Markdown'

type ToolUse = Extract<LogEvent, { type: 'tool_use' }>
type ToolResultEv = Extract<LogEvent, { type: 'tool_result' }>

const TOOL_ICON: Record<string, typeof Wrench> = {
  Bash: Terminal,
  PowerShell: Terminal,
  Read: FileText,
  Write: FilePen,
  Edit: FilePen,
  MultiEdit: FilePen,
  NotebookEdit: FilePen,
  Glob: FileSearch,
  Grep: Search,
  WebFetch: Globe,
  WebSearch: Globe,
  Task: Users,
  Agent: Users,
  TodoWrite: ListChecks,
}

const PREVIEW_CHARS = 160

function ToolCall({ e }: { e: ToolUse }) {
  const Icon = TOOL_ICON[e.tool] ?? Wrench
  const long = e.input.length > 100 || e.input.includes('\n')
  const [open, setOpen] = useState(false)
  const shell = e.tool === 'Bash' || e.tool === 'PowerShell'
  return (
    <div className="min-w-0">
      <button
        type="button"
        disabled={!long}
        onClick={() => setOpen(!open)}
        title={long ? (open ? 'Thu gọn' : 'Xem đầy đủ') : undefined}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-left font-mono text-[12px] text-slate-700 enabled:hover:border-slate-300 dark:border-slate-700/70 dark:bg-slate-800/60 dark:text-slate-200"
      >
        <Icon size={13} className="shrink-0 text-slate-500" />
        <span className="shrink-0 font-semibold">{e.tool}</span>
        {!open && <span className="min-w-0 truncate text-slate-500 dark:text-slate-400">{shell && '$ '}{e.input.split('\n')[0]}</span>}
        {long && <ChevronRight size={12} className={`ml-auto shrink-0 text-slate-400 transition ${open ? 'rotate-90' : ''}`} />}
      </button>
      {open && (
        <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-slate-900 p-2.5 font-mono text-[12px] leading-relaxed text-slate-100">
          {shell && <span className="select-none text-slate-500">$ </span>}
          {e.input}
        </pre>
      )}
    </div>
  )
}

function ToolResult({ e }: { e: ToolResultEv }) {
  const text = e.output.replace(/\s+$/, '')
  const lines = text ? text.split('\n') : []
  const expandable = lines.length > 1 || text.length > PREVIEW_CHARS
  const [open, setOpen] = useState(e.isError ?? false)
  const tone = e.isError ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'

  if (!text) return <p className={`pl-2 text-xs ${tone}`}>↳ {e.isError ? 'Lỗi (không có nội dung)' : 'Xong (không có output)'}</p>

  if (!expandable) return <p className={`break-words pl-2 font-mono text-[12px] ${tone}`}>↳ {text}</p>

  return (
    <div className="pl-2">
      <button type="button" onClick={() => setOpen(!open)} className={`flex w-full min-w-0 items-center gap-1 text-left text-xs ${tone} hover:text-slate-700 dark:hover:text-slate-200`}>
        <ChevronRight size={12} className={`shrink-0 transition ${open ? 'rotate-90' : ''}`} />
        <span className="shrink-0">
          ↳ {e.isError ? 'Lỗi' : 'Kết quả'}
          {lines.length > 1 && ` · ${lines.length} dòng`}
        </span>
        {!open && <span className="min-w-0 truncate font-mono text-[12px] opacity-70">— {lines[0]}</span>}
      </button>
      {open && (
        <pre
          className={`mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md p-2.5 font-mono text-[12px] leading-relaxed ${
            e.isError ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300' : 'bg-slate-900 text-slate-100'
          }`}
        >
          {text}
        </pre>
      )}
    </div>
  )
}

/** Gộp tool_use + tool_result ngay sau nó thành một nhóm để dễ theo dõi. */
type Row = { key: string; ts: number; ev: LogEvent; result?: ToolResultEv }

function toRows(events: LogEvent[]): Row[] {
  // Claude có thể gọi nhiều tool song song (use A, use B, result A, result B):
  // ghép kết quả với lần gọi cùng tên tool còn chờ, theo thứ tự (FIFO).
  const rows: Row[] = []
  let pending: Row[] = []
  for (const ev of events) {
    if (ev.type === 'tool_result') {
      const idx = pending.findIndex((r) => r.ev.type === 'tool_use' && r.ev.tool === ev.tool)
      if (idx !== -1) {
        pending[idx].result = ev
        pending.splice(idx, 1)
        continue
      }
    }
    const row: Row = { key: ev.id, ts: ev.ts, ev }
    rows.push(row)
    if (ev.type === 'tool_use') pending.push(row)
    else if (ev.type !== 'tool_result') pending = []
  }
  return rows
}

export function LogView({ events, live }: { events: LogEvent[]; live: boolean }) {
  const bottom = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  const [onlyMessages, setOnlyMessages] = useState(false)

  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: 'nearest' })
  }, [events.length, follow])

  const rows = toRows(events).filter((r) => !onlyMessages || r.ev.type === 'assistant' || r.ev.type === 'result')
  const toolCount = events.filter((e) => e.type === 'tool_use').length

  return (
    <div className="relative">
      {events.length > 0 && (
        <div className="mb-2 flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>
            {events.filter((e) => e.type === 'assistant').length} tin nhắn · {toolCount} lần gọi tool
          </span>
          <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={onlyMessages} onChange={(ev) => setOnlyMessages(ev.target.checked)} className="accent-indigo-600" />
            Chỉ hiện tin nhắn của Claude
          </label>
        </div>
      )}
      <div
        ref={box}
        onScroll={() => {
          const el = box.current
          if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
        }}
        className="max-h-[65vh] min-h-[200px] overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
      >
        {events.length === 0 && <p className="py-8 text-center text-sm text-slate-400">Chưa có log. Task sẽ hiển thị log khi bắt đầu chạy.</p>}
        <ol className="space-y-3">
          {rows.map(({ key, ts, ev: e, result }) => (
            <li key={key} className="flex gap-3">
              <span className="w-14 shrink-0 pt-1 font-mono text-[11px] text-slate-400">{clock(ts)}</span>
              <div className="min-w-0 flex-1">
                {e.type === 'system' && (
                  <p className="flex items-start gap-1.5 pt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    <Info size={13} className="mt-px shrink-0" /> <span className="break-words">{e.text}</span>
                  </p>
                )}
                {e.type === 'assistant' && (
                  <div className="flex gap-2.5">
                    <Bot size={16} className="mt-0.5 shrink-0 text-indigo-500" />
                    <Markdown text={e.text} className="min-w-0 flex-1 text-slate-800 dark:text-slate-100" />
                  </div>
                )}
                {e.type === 'tool_use' && (
                  <div className="space-y-1">
                    <ToolCall e={e} />
                    {result && <ToolResult e={result} />}
                  </div>
                )}
                {e.type === 'tool_result' && <ToolResult e={e} />}
                {e.type === 'result' && (
                  <div
                    className={`flex gap-2.5 rounded-md border p-3 ${
                      e.isError
                        ? 'border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/40'
                        : 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30'
                    }`}
                  >
                    {e.isError ? (
                      <CircleAlert size={16} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-400" />
                    ) : (
                      <CircleCheck size={16} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    )}
                    <Markdown text={e.text} className="min-w-0 flex-1" />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
        {live && (
          <div className="mt-3 flex items-center gap-2 pl-[68px] text-xs text-indigo-500">
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-indigo-500 [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-indigo-500 [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-indigo-500" />
            </span>
            Claude đang làm việc…
          </div>
        )}
        <div ref={bottom} />
      </div>
      {!follow && events.length > 0 && (
        <button
          type="button"
          onClick={() => {
            setFollow(true)
            bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          }}
          className="absolute bottom-3 right-4 inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
        >
          <ArrowDown size={12} /> Mới nhất
        </button>
      )}
    </div>
  )
}
