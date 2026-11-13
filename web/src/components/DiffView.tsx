import { Fragment, useEffect, useState, type ReactNode } from 'react'
import {
  CheckSquare,
  Columns2,
  Eye,
  FileCode2,
  FileMinus,
  FilePen,
  FilePlus,
  Image as ImageIcon,
  Loader2,
  MessageSquarePlus,
  MessageSquareText,
  Pencil,
  Plus,
  Rows2,
  Save,
  Square,
  Trash2,
} from 'lucide-react'
import type { DiffLine, FileDiff, ReviewComment } from '../types'
import { Markdown } from './Markdown'
import { Button, inputCls } from './ui'
import { fileSignature, isMarkdownPath } from '../lib/reviewComments'
import { isHtmlPath, isImagePath } from '../lib/diff'
import { HtmlPreview } from './HtmlPreview'
import type { ReviewDraftApi } from '../lib/reviewDraft'

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

/** Chức năng review gắn vào DiffView; không truyền thì chỉ xem diff. */
export interface DiffReview {
  draft: ReviewDraftApi
  /** Task đang ở Review: được thêm nhận xét và sửa file Markdown */
  canEdit: boolean
  loadFile: (path: string) => Promise<string | null>
  saveFile: (path: string, content: string) => Promise<boolean>
  /** URL ảnh để xem trước: bản trên nhánh task (`new`) hoặc nhánh chính (`old`). Không có: không xem trước ảnh */
  imageUrl?: (path: string, side: 'old' | 'new') => string
  /** Link xem trước trang HTML (cổng xem trước riêng, có hạn). Không có: chỉ xem mã */
  previewUrl?: (path: string, side: 'old' | 'new') => Promise<string>
}

// ---------------------------------------------------------------- ảnh: xem trước Trước / Sau

function ImageSide({ label, src, tone }: { label: string; src: string; tone: 'old' | 'new' }) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [size, setSize] = useState<string>('')
  useEffect(() => {
    setState('loading')
    setSize('')
  }, [src])
  return (
    <figure className="flex min-w-0 flex-1 flex-col gap-1.5">
      <figcaption className="flex items-center gap-2 text-xs">
        <span className={`rounded px-1.5 py-0.5 font-medium ${tone === 'old' ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'}`}>
          {label}
        </span>
        {size && <span className="font-mono text-slate-500 dark:text-slate-400">{size}</span>}
        <a href={src} target="_blank" rel="noreferrer" className="ml-auto text-slate-500 hover:text-indigo-600 hover:underline dark:text-slate-400">
          Mở ảnh gốc
        </a>
      </figcaption>
      {/* Nền ca-rô để thấy vùng trong suốt của PNG/SVG */}
      <div className="grid min-h-[140px] place-items-center rounded-md border border-slate-200 bg-[length:16px_16px] bg-[position:0_0,8px_8px] bg-[image:linear-gradient(45deg,#e2e8f0_25%,transparent_25%,transparent_75%,#e2e8f0_75%),linear-gradient(45deg,#e2e8f0_25%,transparent_25%,transparent_75%,#e2e8f0_75%)] p-3 dark:border-slate-700 dark:bg-[image:linear-gradient(45deg,#1e293b_25%,transparent_25%,transparent_75%,#1e293b_75%),linear-gradient(45deg,#1e293b_25%,transparent_25%,transparent_75%,#1e293b_75%)]">
        {state === 'loading' && <Loader2 size={18} className="animate-spin text-slate-400" />}
        {state === 'error' && <span className="text-xs text-rose-600 dark:text-rose-400">Không tải được ảnh</span>}
        <img
          src={src}
          alt={label}
          onLoad={(e) => {
            setState('ok')
            const img = e.currentTarget
            if (img.naturalWidth) setSize(`${img.naturalWidth} × ${img.naturalHeight} px`)
          }}
          onError={() => setState('error')}
          className={`max-h-[48vh] max-w-full object-contain ${state === 'ok' ? '' : 'hidden'}`}
        />
      </div>
    </figure>
  )
}

/** Ảnh bản cũ (nhánh chính) và bản mới (nhánh task) đặt cạnh nhau; file mới/xoá chỉ có một bên. */
function ImagePane({ file, imageUrl }: { file: FileDiff; imageUrl: NonNullable<DiffReview['imageUrl']> }) {
  return (
    <div className="flex flex-col gap-4 p-3 sm:flex-row">
      {file.status !== 'added' && <ImageSide label={file.status === 'deleted' ? 'Đã xoá' : 'Trước'} tone="old" src={imageUrl(file.oldPath ?? file.path, 'old')} />}
      {file.status !== 'deleted' && <ImageSide label={file.status === 'added' ? 'Ảnh mới' : 'Sau'} tone="new" src={imageUrl(file.path, 'new')} />}
    </div>
  )
}

type Anchor = { side: 'old' | 'new'; line: number; snippet: string }
type ViewMode = 'preview' | 'diff' | 'edit'

/** Dòng diff nhận xét theo bản nào: dòng bị xoá theo bản cũ, còn lại theo bản mới. */
const anchorOf = (l: DiffLine): Anchor | undefined =>
  l.type === 'del' ? (l.oldNo ? { side: 'old', line: l.oldNo, snippet: l.text } : undefined) : l.newNo ? { side: 'new', line: l.newNo, snippet: l.text } : undefined

const sameAnchor = (c: Pick<ReviewComment, 'side' | 'line'>, a?: Anchor) => !!a && c.line === a.line && (c.side ?? 'new') === a.side

// ---------------------------------------------------------------- nhận xét

function Composer({ initial = '', onSubmit, onCancel, label }: { initial?: string; onSubmit: (text: string) => void; onCancel: () => void; label: string }) {
  const [text, setText] = useState(initial)
  const submit = () => text.trim() && onSubmit(text.trim())
  return (
    <div className="space-y-2 p-2 font-sans">
      <textarea
        autoFocus
        className={`${inputCls} min-h-[70px] text-sm`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit()
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Nhận xét cho Claude… (Ctrl+Enter để lưu)"
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Huỷ
        </Button>
        <Button size="sm" variant="primary" disabled={!text.trim()} onClick={submit}>
          {label}
        </Button>
      </div>
    </div>
  )
}

function CommentBox({ c, review }: { c: ReviewComment; review?: DiffReview }) {
  const [editing, setEditing] = useState(false)
  if (editing && review)
    return (
      <Composer
        initial={c.text}
        label="Lưu"
        onCancel={() => setEditing(false)}
        onSubmit={(t) => {
          review.draft.editComment(c.id, t)
          setEditing(false)
        }}
      />
    )
  return (
    <div className="m-2 flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 font-sans text-sm text-slate-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-slate-200">
      <MessageSquareText size={15} className="mt-0.5 shrink-0 text-amber-600" />
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{c.text}</p>
      {review?.canEdit && (
        <span className="flex shrink-0 gap-1">
          <button title="Sửa nhận xét" className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" onClick={() => setEditing(true)}>
            <Pencil size={14} />
          </button>
          <button title="Xoá nhận xét" className="text-slate-400 hover:text-rose-600" onClick={() => review.draft.removeComment(c.id)}>
            <Trash2 size={14} />
          </button>
        </span>
      )}
    </div>
  )
}

/** Các dòng phụ chèn dưới một dòng diff: nhận xét đã có + ô soạn nhận xét (nếu đang mở ở dòng này). */
function CommentRows({
  anchors,
  comments,
  composing,
  colSpan,
  review,
  onAdd,
  onCancel,
}: {
  anchors: (Anchor | undefined)[]
  comments: ReviewComment[]
  composing?: Anchor
  colSpan: number
  review?: DiffReview
  onAdd: (a: Anchor, text: string) => void
  onCancel: () => void
}) {
  const list = comments.filter((c) => anchors.some((a) => sameAnchor(c, a)))
  const open = composing && anchors.some((a) => a && a.side === composing.side && a.line === composing.line) ? composing : undefined
  if (!list.length && !open) return null
  return (
    <tr>
      <td colSpan={colSpan} className="border-y border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/70">
        {list.map((c) => (
          <CommentBox key={c.id} c={c} review={review} />
        ))}
        {open && <Composer label="Thêm nhận xét" onCancel={onCancel} onSubmit={(t) => onAdd(open, t)} />}
      </td>
    </tr>
  )
}

/** Ô số dòng; khi được nhận xét thì hover hiện nút "+". */
function NoCell({ n, onComment }: { n?: number; onComment?: () => void }) {
  return (
    <td className="relative w-12 select-none border-r border-slate-200 px-2 text-right align-top text-slate-400 dark:border-slate-800">
      {onComment && (
        <button
          title="Nhận xét dòng này"
          onClick={onComment}
          className="absolute left-0.5 top-0.5 hidden rounded bg-indigo-600 p-px text-white group-hover:block"
        >
          <Plus size={12} />
        </button>
      )}
      {n ?? ''}
    </td>
  )
}

// ---------------------------------------------------------------- diff

interface DiffBodyProps {
  file: FileDiff
  comments: ReviewComment[]
  review?: DiffReview
  composing?: Anchor
  setComposing: (a?: Anchor) => void
  onAdd: (a: Anchor, text: string) => void
}

function HunkHeader({ header, colSpan }: { header: string; colSpan: number }) {
  return (
    <tr className="bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
      <td colSpan={colSpan} className="px-2 py-0.5">
        {header}
      </td>
    </tr>
  )
}

function Unified({ file, comments, review, composing, setComposing, onAdd }: DiffBodyProps) {
  const can = !!review?.canEdit
  return (
    <table className="w-full border-collapse font-mono text-[12px] leading-5">
      <tbody>
        {file.hunks.map((h, hi) => (
          <Fragment key={hi}>
            <HunkHeader header={h.header} colSpan={3} />
            {h.lines.map((l, i) => {
              const a = anchorOf(l)
              const comment = can && a ? () => setComposing(a) : undefined
              return (
                <Fragment key={i}>
                  <tr className={`group ${lineCls(l.type)}`}>
                    <NoCell n={l.oldNo} onComment={l.type === 'del' ? comment : undefined} />
                    <NoCell n={l.newNo} onComment={l.type !== 'del' ? comment : undefined} />
                    <td className="whitespace-pre px-2">
                      <span className="select-none text-slate-400">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
                      {l.text}
                    </td>
                  </tr>
                  <CommentRows anchors={[a]} comments={comments} composing={composing} colSpan={3} review={review} onAdd={onAdd} onCancel={() => setComposing()} />
                </Fragment>
              )
            })}
          </Fragment>
        ))}
      </tbody>
    </table>
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

function Split({ file, comments, review, composing, setComposing, onAdd }: DiffBodyProps) {
  const can = !!review?.canEdit
  return (
    <table className="w-full table-fixed border-collapse font-mono text-[12px] leading-5">
      <colgroup>
        <col className="w-12" />
        <col />
        <col className="w-12" />
        <col />
      </colgroup>
      <tbody>
        {file.hunks.map((h, hi) => (
          <Fragment key={hi}>
            <HunkHeader header={h.header} colSpan={4} />
            {toSplit(h.lines).map((row, i) => {
              // Bên trái chỉ nhận xét dòng bị xoá; dòng ngữ cảnh nhận xét ở bên phải (bản mới)
              const left = row.l?.type === 'del' ? anchorOf(row.l) : undefined
              const right = row.r ? anchorOf(row.r) : undefined
              return (
                <Fragment key={i}>
                  <tr className="group">
                    <NoCell n={row.l?.oldNo} onComment={can && left ? () => setComposing(left) : undefined} />
                    <td className={`overflow-hidden whitespace-pre border-r border-slate-200 px-2 dark:border-slate-800 ${lineCls(row.l ? row.l.type : 'empty')}`}>{row.l?.text}</td>
                    <NoCell n={row.r?.newNo} onComment={can && right ? () => setComposing(right) : undefined} />
                    <td className={`overflow-hidden whitespace-pre px-2 ${lineCls(row.r ? row.r.type : 'empty')}`}>{row.r?.text}</td>
                  </tr>
                  <CommentRows anchors={[left, right]} comments={comments} composing={composing} colSpan={4} review={review} onAdd={onAdd} onCancel={() => setComposing()} />
                </Fragment>
              )
            })}
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}

// ---------------------------------------------------------------- Markdown: preview / edit

type FileState = { sig: string; content: string | null; loading: boolean }

function MarkdownPane({
  file,
  mode,
  review,
  onModeChange,
}: {
  file: FileDiff
  mode: 'preview' | 'edit'
  review: DiffReview
  onModeChange: (m: ViewMode) => void
}) {
  const sig = fileSignature(file)
  const [state, setState] = useState<FileState | null>(null)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (state?.sig === sig) return
    let alive = true
    setState({ sig, content: null, loading: true })
    review.loadFile(file.path).then((content) => {
      if (!alive) return
      setState({ sig, content, loading: false })
      setText(content ?? '')
    })
    return () => {
      alive = false
    }
  }, [file.path, sig])

  if (!state || state.loading)
    return (
      <p className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
        <Loader2 size={16} className="animate-spin" /> Đang tải nội dung…
      </p>
    )
  if (state.content === null) return <p className="py-8 text-center text-sm text-slate-400">Không đọc được nội dung file. Hãy xem ở chế độ Diff.</p>

  if (mode === 'preview')
    return (
      <div className="p-4 text-sm">
        <Markdown text={state.content} />
      </div>
    )

  const dirty = text !== state.content
  return (
    <div className="space-y-2 p-2">
      <textarea
        className={`${inputCls} min-h-[45vh] font-mono text-[12px] leading-5`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-slate-500">Lưu sẽ ghi vào worktree và commit trên nhánh task. Diff được tính lại.</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={() => {
            setText(state.content ?? '')
            onModeChange('preview')
          }}
        >
          Huỷ
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={saving || !dirty}
          onClick={async () => {
            setSaving(true)
            const ok = await review.saveFile(file.path, text)
            setSaving(false)
            if (ok) {
              setState({ sig: '', content: text, loading: false }) // diff mới về sẽ tải lại
              onModeChange('preview')
            }
          }}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Lưu &amp; commit
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- khung chính

function Seg({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button title={title} onClick={onClick} className={`inline-flex items-center gap-1 px-2 py-1 text-xs ${active ? 'bg-slate-100 font-medium dark:bg-slate-800' : ''}`}>
      {children}
    </button>
  )
}

export function DiffView({ files, review }: { files: FileDiff[]; review?: DiffReview }) {
  const [selected, setSelected] = useState<string>(files[0]?.path ?? '')
  const [layout, setLayout] = useState<'unified' | 'split'>('unified')
  const [modes, setModes] = useState<Record<string, ViewMode>>({})
  const [composing, setComposing] = useState<Anchor | undefined>()
  const [fileComposer, setFileComposer] = useState(false)
  const file = files.find((f) => f.path === selected) ?? files[0]
  useEffect(() => {
    setComposing(undefined)
    setFileComposer(false)
  }, [file?.path])

  const adds = files.reduce((s, f) => s + f.additions, 0)
  const dels = files.reduce((s, f) => s + f.deletions, 0)
  const allComments = review?.draft.comments ?? []
  const isViewed = (f: FileDiff) => review?.draft.viewed[f.path] === fileSignature(f)
  const viewedCount = files.filter(isViewed).length

  if (!file) return <p className="py-8 text-center text-sm text-slate-400">Không có thay đổi nào.</p>

  const md = isMarkdownPath(file.path) && file.status !== 'deleted' && !!review
  // Ảnh: xem trước Trước/Sau. SVG còn có mã nguồn (diff chữ) nên cho chuyển qua lại
  const img = isImagePath(file.path) && !!review?.imageUrl
  const imgHasCode = img && file.hunks.length > 0
  // Trang HTML: xem giao diện (iframe cách ly) hoặc mã
  const html = isHtmlPath(file.path) && !!review?.previewUrl
  const mode: ViewMode = md || img || html ? (modes[file.path] ?? 'preview') : 'diff'
  const setMode = (m: ViewMode) => setModes((s) => ({ ...s, [file.path]: m }))
  const comments = allComments.filter((c) => c.path === file.path)
  const fileComments = comments.filter((c) => c.line === undefined)
  const lineComments = comments.filter((c) => c.line !== undefined)

  const addLine = (a: Anchor, text: string) => {
    review?.draft.addComment({ path: file.path, line: a.line, side: a.side, snippet: a.snippet, text })
    setComposing(undefined)
  }
  const toggleViewed = () => {
    if (!review) return
    if (isViewed(file)) return review.draft.setViewed(file.path, null)
    review.draft.setViewed(file.path, fileSignature(file))
    // Chuyển sang file tiếp theo chưa xem
    const i = files.indexOf(file)
    const next = [...files.slice(i + 1), ...files.slice(0, i)].find((f) => !isViewed(f) && f !== file)
    if (next) setSelected(next.path)
  }
  const bodyProps: DiffBodyProps = { file, comments: lineComments, review, composing, setComposing, onAdd: addLine }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 text-sm dark:border-slate-800">
        <span className="text-slate-600 dark:text-slate-300">
          {files.length} file · <span className="text-emerald-600">+{adds}</span> <span className="text-rose-600">−{dels}</span>
          {review && (
            <>
              {' '}
              · <span className={viewedCount === files.length ? 'text-emerald-600' : ''}>đã xem {viewedCount}/{files.length}</span>
              {allComments.length > 0 && <> · {allComments.length} nhận xét</>}
            </>
          )}
        </span>
        <div className="flex rounded-md ring-1 ring-slate-200 dark:ring-slate-700">
          <Seg active={layout === 'unified'} onClick={() => setLayout('unified')}>
            <Rows2 size={13} /> Unified
          </Seg>
          <Seg active={layout === 'split'} onClick={() => setLayout('split')}>
            <Columns2 size={13} /> Side-by-side
          </Seg>
        </div>
      </div>
      <div className="flex flex-col md:flex-row">
        <ul className="max-h-[30vh] shrink-0 overflow-y-auto border-b border-slate-200 py-1 md:max-h-none md:w-64 md:border-b-0 md:border-r dark:border-slate-800">
          {files.map((f) => {
            const n = allComments.filter((c) => c.path === f.path).length
            const seen = isViewed(f)
            return (
              <li key={f.path}>
                <button
                  onClick={() => setSelected(f.path)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${f.path === file.path ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                  title={f.path}
                >
                  {review && (seen ? <CheckSquare size={14} className="shrink-0 text-emerald-600" /> : <Square size={14} className="shrink-0 text-slate-300" />)}
                  {STATUS_ICON[f.status]}
                  <span className={`min-w-0 flex-1 truncate font-mono ${seen ? 'text-slate-400' : ''}`}>{f.path}</span>
                  {n > 0 && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-amber-600" title={`${n} nhận xét`}>
                      <MessageSquareText size={12} />
                      {n}
                    </span>
                  )}
                  {f.binary ? (
                    <span className="shrink-0 text-slate-400">{isImagePath(f.path) ? 'ảnh' : 'nhị phân'}</span>
                  ) : (
                    <>
                      <span className="shrink-0 text-emerald-600">+{f.additions}</span>
                      <span className="shrink-0 text-rose-600">−{f.deletions}</span>
                    </>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-1.5 dark:border-slate-800">
            <span className="mr-auto min-w-0 truncate font-mono text-xs text-slate-600 dark:text-slate-300" title={file.path}>
              {file.oldPath ? `${file.oldPath} → ` : ''}
              {file.path}
            </span>
            {md && (
              <div className="flex rounded-md ring-1 ring-slate-200 dark:ring-slate-700">
                <Seg active={mode === 'preview'} onClick={() => setMode('preview')} title="Xem Markdown đã render">
                  <Eye size={13} /> Preview
                </Seg>
                <Seg active={mode === 'diff'} onClick={() => setMode('diff')} title="Xem thay đổi, nhận xét theo dòng">
                  <FileCode2 size={13} /> Diff
                </Seg>
                {review?.canEdit && (
                  <Seg active={mode === 'edit'} onClick={() => setMode('edit')} title="Sửa trực tiếp nội dung file">
                    <Pencil size={13} /> Edit
                  </Seg>
                )}
              </div>
            )}
            {html && (
              <div className="flex rounded-md ring-1 ring-slate-200 dark:ring-slate-700">
                <Seg active={mode === 'preview'} onClick={() => setMode('preview')} title="Xem giao diện trang (chạy trong vùng cách ly)">
                  <Eye size={13} /> Giao diện
                </Seg>
                <Seg active={mode === 'diff'} onClick={() => setMode('diff')} title="Xem thay đổi mã nguồn, nhận xét theo dòng">
                  <FileCode2 size={13} /> Mã
                </Seg>
              </div>
            )}
            {imgHasCode && (
              <div className="flex rounded-md ring-1 ring-slate-200 dark:ring-slate-700">
                <Seg active={mode === 'preview'} onClick={() => setMode('preview')} title="Xem ảnh trước và sau khi sửa">
                  <ImageIcon size={13} /> Ảnh
                </Seg>
                <Seg active={mode === 'diff'} onClick={() => setMode('diff')} title="Xem thay đổi mã nguồn, nhận xét theo dòng">
                  <FileCode2 size={13} /> Mã
                </Seg>
              </div>
            )}
            {review?.canEdit && (
              <Button size="sm" variant="ghost" onClick={() => setFileComposer(true)} title="Nhận xét chung cho cả file">
                <MessageSquarePlus size={14} /> Nhận xét file
              </Button>
            )}
            {review && (
              <Button size="sm" variant={isViewed(file) ? 'success' : 'secondary'} onClick={toggleViewed} title="Đánh dấu đã review file này">
                {isViewed(file) ? <CheckSquare size={14} /> : <Square size={14} />} Đã xem
              </Button>
            )}
          </div>
          {(fileComments.length > 0 || fileComposer) && (
            <div className="border-b border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/70">
              {fileComments.map((c) => (
                <CommentBox key={c.id} c={c} review={review} />
              ))}
              {fileComposer && review && (
                <Composer
                  label="Thêm nhận xét"
                  onCancel={() => setFileComposer(false)}
                  onSubmit={(text) => {
                    review.draft.addComment({ path: file.path, text })
                    setFileComposer(false)
                  }}
                />
              )}
            </div>
          )}
          <div className="max-h-[60vh] overflow-auto">
            {html && mode === 'preview' ? (
              <HtmlPreview file={file} getUrl={review!.previewUrl!} />
            ) : img && (mode === 'preview' || !imgHasCode) ? (
              <ImagePane file={file} imageUrl={review!.imageUrl!} />
            ) : md && mode !== 'diff' ? (
              <MarkdownPane file={file} mode={mode} review={review!} onModeChange={setMode} />
            ) : file.hunks.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-400">
                {file.binary ? 'File nhị phân, không xem trước được nội dung.' : 'Không có nội dung để hiển thị (chỉ đổi tên hoặc đổi quyền file).'}
              </p>
            ) : layout === 'unified' ? (
              <Unified {...bodyProps} />
            ) : (
              <Split {...bodyProps} />
            )}
          </div>
          {md && mode === 'preview' && lineComments.length > 0 && (
            <p className="border-t border-slate-200 px-3 py-1.5 text-xs text-slate-500 dark:border-slate-800">
              File có {lineComments.length} nhận xét theo dòng, chuyển sang <b>Diff</b> để xem.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
