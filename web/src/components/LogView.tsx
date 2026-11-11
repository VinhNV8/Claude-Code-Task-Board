import { useEffect, useRef, useState } from 'react'
import { Bot, ChevronRight, CircleAlert, CircleCheck, Info, Terminal, Wrench } from 'lucide-react'
import type { LogEvent } from '../types'
import { clock } from '../lib/format'

/** Hiển thị inline `code` trong tin nhắn của Claude. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('`') && p.endsWith('`') ? (
          <code key={i} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px] dark:bg-slate-800">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}

function ToolResult({ e }: { e: Extract<LogEvent, { type: 'tool_result' }> }) {
  const multiline = e.output.includes('\n')
  const [open, setOpen] = useState(e.isError ?? false)
  if (!multiline)
    return (
      <span className={`text-xs ${e.isError ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'}`}>
        ↳ {e.output}
      </span>
    )
  return (
    <div>
      <button onClick={() => setOpen(!open)} className={`inline-flex items-center gap-1 text-xs ${e.isError ? 'text-rose-600' : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'}`}>
        <ChevronRight size={12} className={`transition ${open ? 'rotate-90' : ''}`} />
        ↳ {e.isError ? 'Lỗi' : 'Kết quả'} ({e.output.split('\n').length} dòng)
      </button>
      {open && (
        <pre className={`mt-1 overflow-x-auto rounded-md p-2 font-mono text-[12px] leading-relaxed ${e.isError ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300' : 'bg-slate-900 text-slate-100'}`}>
          {e.output}
        </pre>
      )}
    </div>
  )
}

export function LogView({ events, live }: { events: LogEvent[]; live: boolean }) {
  const bottom = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)

  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: 'nearest' })
  }, [events.length, follow])

  return (
    <div
      ref={box}
      onScroll={() => {
        const el = box.current
        if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
      }}
      className="max-h-[60vh] min-h-[200px] overflow-y-auto rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
    >
      {events.length === 0 && <p className="py-8 text-center text-sm text-slate-400">Chưa có log. Task sẽ hiển thị log khi bắt đầu chạy.</p>}
      <ol className="space-y-2">
        {events.map((e) => (
          <li key={e.id} className="flex gap-3">
            <span className="w-16 shrink-0 pt-0.5 font-mono text-[11px] text-slate-400">{clock(e.ts)}</span>
            <div className="min-w-0 flex-1">
              {e.type === 'system' && (
                <p className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <Info size={13} /> {e.text}
                </p>
              )}
              {e.type === 'assistant' && (
                <p className="flex gap-2 text-sm text-slate-800 dark:text-slate-100">
                  <Bot size={16} className="mt-0.5 shrink-0 text-indigo-500" />
                  <span>
                    <RichText text={e.text} />
                  </span>
                </p>
              )}
              {e.type === 'tool_use' && (
                <p className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 font-mono text-[12px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  {e.tool === 'Bash' ? <Terminal size={13} /> : <Wrench size={13} />}
                  <span className="font-semibold">{e.tool}</span>
                  <span className="truncate text-slate-500 dark:text-slate-400">{e.input}</span>
                </p>
              )}
              {e.type === 'tool_result' && <ToolResult e={e} />}
              {e.type === 'result' && (
                <div
                  className={`flex gap-2 rounded-md border p-2.5 text-sm ${
                    e.isError
                      ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
                  }`}
                >
                  {e.isError ? <CircleAlert size={16} className="mt-0.5 shrink-0" /> : <CircleCheck size={16} className="mt-0.5 shrink-0" />}
                  <span>
                    <RichText text={e.text} />
                  </span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      {live && (
        <div className="mt-3 flex items-center gap-2 pl-[76px] text-xs text-indigo-500">
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
  )
}
