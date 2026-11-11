import { useState } from 'react'
import { Columns2, FileMinus, FilePen, FilePlus, Rows2 } from 'lucide-react'
import type { DiffLine, FileDiff } from '../types'

const STATUS_ICON = {
  added: <FilePlus size={14} className="text-emerald-500" />,
  modified: <FilePen size={14} className="text-amber-500" />,
  deleted: <FileMinus size={14} className="text-rose-500" />,
}

const lineCls = (t: DiffLine['type'] | 'empty') =>
  t === 'add'
    ? 'bg-emerald-50 dark:bg-emerald-950/40'
    : t === 'del'
      ? 'bg-rose-50 dark:bg-rose-950/40'
      : t === 'empty'
        ? 'bg-slate-50 dark:bg-slate-900/60'
        : ''

const NoCell = ({ n }: { n?: number }) => (
  <td className="w-10 select-none border-r border-slate-200 px-2 text-right align-top text-slate-400 dark:border-slate-800">{n ?? ''}</td>
)

function Unified({ file }: { file: FileDiff }) {
  return (
    <table className="w-full border-collapse font-mono text-[12px] leading-5">
      <tbody>
        {file.hunks.map((h, hi) => (
          <HunkRows key={hi} header={h.header}>
            {h.lines.map((l, i) => (
              <tr key={i} className={lineCls(l.type)}>
                <NoCell n={l.oldNo} />
                <NoCell n={l.newNo} />
                <td className="whitespace-pre px-2">
                  <span className="select-none text-slate-400">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
                  {l.text}
                </td>
              </tr>
            ))}
          </HunkRows>
        ))}
      </tbody>
    </table>
  )
}

function HunkRows({ header, children }: { header: string; children: React.ReactNode }) {
  return (
    <>
      <tr className="bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
        <td colSpan={4} className="px-2 py-0.5">
          {header}
        </td>
      </tr>
      {children}
    </>
  )
}

/** Ghép dòng xoá và dòng thêm liền nhau thành từng cặp trái/phải. */
function toSplit(lines: DiffLine[]) {
  const rows: { l?: DiffLine; r?: DiffLine }[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].type === 'ctx') {
      rows.push({ l: lines[i], r: lines[i] })
      i++
      continue
    }
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++])
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++])
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ l: dels[k], r: adds[k] })
  }
  return rows
}

function Split({ file }: { file: FileDiff }) {
  return (
    <table className="w-full table-fixed border-collapse font-mono text-[12px] leading-5">
      <colgroup>
        <col className="w-10" />
        <col />
        <col className="w-10" />
        <col />
      </colgroup>
      <tbody>
        {file.hunks.map((h, hi) => (
          <HunkRows key={hi} header={h.header}>
            {toSplit(h.lines).map((row, i) => (
              <tr key={i}>
                <NoCell n={row.l?.oldNo} />
                <td className={`overflow-hidden whitespace-pre border-r border-slate-200 px-2 dark:border-slate-800 ${lineCls(row.l ? row.l.type : 'empty')}`}>{row.l?.text}</td>
                <NoCell n={row.r?.newNo} />
                <td className={`overflow-hidden whitespace-pre px-2 ${lineCls(row.r ? row.r.type : 'empty')}`}>{row.r?.text}</td>
              </tr>
            ))}
          </HunkRows>
        ))}
      </tbody>
    </table>
  )
}

export function DiffView({ files }: { files: FileDiff[] }) {
  const [selected, setSelected] = useState<string>(files[0]?.path ?? '')
  const [mode, setMode] = useState<'unified' | 'split'>('unified')
  const file = files.find((f) => f.path === selected) ?? files[0]
  const adds = files.reduce((s, f) => s + f.additions, 0)
  const dels = files.reduce((s, f) => s + f.deletions, 0)

  if (!file) return <p className="py-8 text-center text-sm text-slate-400">Không có thay đổi nào.</p>

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 text-sm dark:border-slate-800">
        <span className="text-slate-600 dark:text-slate-300">
          {files.length} file · <span className="text-emerald-600">+{adds}</span> <span className="text-rose-600">−{dels}</span>
        </span>
        <div className="flex rounded-md ring-1 ring-slate-200 dark:ring-slate-700">
          <button onClick={() => setMode('unified')} className={`inline-flex items-center gap-1 px-2 py-1 text-xs ${mode === 'unified' ? 'bg-slate-100 font-medium dark:bg-slate-800' : ''}`}>
            <Rows2 size={13} /> Unified
          </button>
          <button onClick={() => setMode('split')} className={`inline-flex items-center gap-1 px-2 py-1 text-xs ${mode === 'split' ? 'bg-slate-100 font-medium dark:bg-slate-800' : ''}`}>
            <Columns2 size={13} /> Side-by-side
          </button>
        </div>
      </div>
      <div className="flex flex-col md:flex-row">
        <ul className="shrink-0 border-b border-slate-200 py-1 md:w-64 md:border-b-0 md:border-r dark:border-slate-800">
          {files.map((f) => (
            <li key={f.path}>
              <button
                onClick={() => setSelected(f.path)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${f.path === file.path ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                title={f.path}
              >
                {STATUS_ICON[f.status]}
                <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
                <span className="shrink-0 text-emerald-600">+{f.additions}</span>
                <span className="shrink-0 text-rose-600">−{f.deletions}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 flex-1">
          <div className="border-b border-slate-200 px-3 py-1.5 font-mono text-xs text-slate-600 dark:border-slate-800 dark:text-slate-300">{file.path}</div>
          <div className="max-h-[55vh] overflow-auto">{mode === 'unified' ? <Unified file={file} /> : <Split file={file} />}</div>
        </div>
      </div>
    </div>
  )
}
