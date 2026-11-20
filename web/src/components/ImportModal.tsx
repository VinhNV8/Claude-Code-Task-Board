// Import task hàng loạt từ CSV / .xlsx / dữ liệu dán (SPEC FR-01a, FR-01b; docs/SPEC-IMPORT.md).
// Trình duyệt đọc file và map tên cột; server kiểm tra từng dòng (dryRun) rồi tạo tất cả trong một transaction.
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { CircleCheck, CircleX, ClipboardPaste, Copy, Download, FileSpreadsheet, TriangleAlert, Upload } from 'lucide-react'
import { importTasks, toast, useStore } from '../store/store'
import {
  CSV_ENCODINGS,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  TEMPLATE_BASENAME,
  cellToString,
  decodeText,
  mapTable,
  parseDelimited,
  templateCsv,
  type CsvEncoding,
  type ImportField,
  type ImportResult,
  type ImportRowResult,
  type MappedTable,
} from '../lib/taskImport'
import { Button, ConfirmDialog, Field, Modal, inputCls } from './ui'
import { tr } from '../lib/i18n'

interface Source {
  name: string
  kind: 'csv' | 'xlsx' | 'paste'
  /** Nội dung gốc của file CSV, để giải mã lại khi đổi mã hoá. */
  bytes?: Uint8Array
  encoding?: CsvEncoding
  /** UTF-8 không hợp lệ, đã tự chuyển sang Windows-1258 (R1). */
  fallback?: boolean
}

const fieldLabel = (f: ImportField) =>
  ({
    title: tr('Tiêu đề'),
    prompt: tr('Mô tả'),
    key: tr('Mã'),
    dependsOn: tr('Chờ task'),
    project: 'Project',
    priority: tr('Độ ưu tiên'),
    tags: 'Tag',
    model: 'Model',
    agent: 'Agent',
    permissionMode: tr('Mức quyền'),
    maxCostUsd: tr('Giới hạn chi phí'),
    writeScope: tr('Phạm vi ghi'),
    planMode: tr('Cách làm'),
  })[f]

const encodingLabel = (e: CsvEncoding) =>
  ({
    'utf-8': 'UTF-8',
    'windows-1258': tr('Windows-1258 (tiếng Việt)'),
    'windows-1252': tr('Windows-1252 (Tây Âu)'),
  })[e]

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** FR-01b: mặc định file .xlsx (phần tạo file chỉ nạp khi bấm), CSV là tuỳ chọn. */
async function downloadTemplate(kind: 'xlsx' | 'csv') {
  if (kind === 'csv') return saveBlob(new Blob([templateCsv()], { type: 'text/csv;charset=utf-8' }), `${TEMPLATE_BASENAME}.csv`)
  const { XLSX_MIME, templateXlsx } = await import('../lib/xlsxTemplate')
  saveBlob(new Blob([templateXlsx()], { type: XLSX_MIME }), `${TEMPLATE_BASENAME}.xlsx`)
}

export function ImportModal({ open, onClose, defaultProjectId }: { open: boolean; onClose: () => void; defaultProjectId?: string }) {
  const { projects } = useStore()
  const [projectId, setProjectId] = useState('')
  const [source, setSource] = useState<Source | null>(null)
  const [mapped, setMapped] = useState<MappedTable | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [paste, setPaste] = useState('')
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  const [onDuplicate, setOnDuplicate] = useState<'skip' | 'create'>('skip')
  const [run, setRun] = useState(false)
  const [confirmAuto, setConfirmAuto] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  /** Lỗi của lần tạo thật gần nhất; giữ nguyên khi kiểm tra lại, xoá khi đổi nguồn hoặc tạo lại. */
  const [createError, setCreateError] = useState<string | null>(null)
  const [confirmQueue, setConfirmQueue] = useState(false)
  const [dragging, setDragging] = useState(false)
  const reqId = useRef(0)

  useEffect(() => {
    if (!open) return
    setProjectId(defaultProjectId || projects[0]?.id || '')
    setSource(null)
    setMapped(null)
    setReadError(null)
    setPaste('')
    setExcluded(new Set())
    setOnDuplicate('skip')
    setRun(false)
    setConfirmAuto(false)
    setResult(null)
    setRequestError(null)
    setCreateError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const loadTable = (table: string[][], src: Source) => {
    setSource(src)
    setCreateError(null)
    setExcluded(new Set())
    setConfirmAuto(false)
    setResult(null)
    setRequestError(null)
    if (table.length < 2) {
      setMapped(null)
      setReadError(tr('Không có dữ liệu: cần dòng tiêu đề cột và ít nhất một dòng task.'))
      return
    }
    setReadError(null)
    setMapped(mapTable(table))
  }

  const readFile = async (file: File) => {
    setReadError(null)
    const ext = file.name.toLowerCase().split('.').pop() ?? ''
    if (file.size > IMPORT_MAX_BYTES) {
      setReadError(tr('File lớn quá {mb} MB.', { mb: IMPORT_MAX_BYTES / 1024 / 1024 }))
      return
    }
    if (ext === 'xls') {
      setReadError(tr('Chưa đọc được file .xls (Excel 97-2003). Hãy mở bằng Excel và lưu lại thành .xlsx hoặc CSV UTF-8.'))
      return
    }
    setReading(true)
    try {
      if (ext === 'xlsx') {
        // Thư viện chỉ nạp khi cần, không làm nặng bundle chính.
        const { readSheet } = await import('read-excel-file/browser')
        const data = await readSheet(file)
        loadTable(
          data.map((r) => r.map(cellToString)),
          { name: file.name, kind: 'xlsx' },
        )
      } else if (['csv', 'tsv', 'txt'].includes(ext)) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const d = decodeText(bytes)
        loadTable(parseDelimited(d.text), { name: file.name, kind: 'csv', bytes, encoding: d.encoding, fallback: d.fallback })
      } else {
        setReadError(tr('Chỉ nhận file .csv, .tsv, .txt hoặc .xlsx.'))
      }
    } catch (e) {
      setReadError(tr('Không đọc được file: {msg}', { msg: (e as Error).message }))
    } finally {
      setReading(false)
    }
  }

  const changeEncoding = (enc: CsvEncoding) => {
    if (!source?.bytes) return
    const d = decodeText(source.bytes, enc)
    loadTable(parseDelimited(d.text), { ...source, encoding: enc, fallback: false })
  }

  const readPaste = () => {
    if (!paste.trim()) return
    loadTable(parseDelimited(paste), { name: tr('Dữ liệu dán'), kind: 'paste' })
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files?.[0]
    if (f) void readFile(f)
  }

  const included = useMemo(() => mapped?.rows.filter((r) => !excluded.has(r.line)) ?? [], [mapped, excluded])

  // Server kiểm tra lại mỗi khi đổi dòng được chọn / project / cách xử lý trùng.
  useEffect(() => {
    if (!open || !mapped || mapped.missing.length || !included.length || !projectId) {
      setResult(null)
      setChecking(false)
      return
    }
    const id = ++reqId.current
    setChecking(true)
    importTasks({ projectId, rows: included, onDuplicate, run: false, dryRun: true })
      .then((r) => {
        if (id !== reqId.current) return
        setResult(r)
        setRequestError(null)
      })
      .catch((e) => {
        if (id !== reqId.current) return
        setResult(null)
        setRequestError((e as Error).message)
      })
      .finally(() => id === reqId.current && setChecking(false))
  }, [open, mapped, included, projectId, onDuplicate])

  const byLine = useMemo(() => new Map((result?.rows ?? []).map((r) => [r.line, r])), [result])
  const counts = useMemo(() => {
    const rows = result?.rows ?? []
    return {
      ok: rows.filter((r) => r.status === 'ok').length,
      duplicate: rows.filter((r) => r.status === 'duplicate').length,
      error: rows.filter((r) => r.status === 'error').length,
    }
  }, [result])
  const autoCount = result?.autoCount ?? 0
  const canCreate = !!result && !checking && !creating && counts.error === 0 && counts.ok > 0 && (!autoCount || confirmAuto)

  const doCreate = async () => {
    setCreating(true)
    setCreateError(null)
    try {
      const r = await importTasks({ projectId, rows: included, onDuplicate, run, confirmAuto, dryRun: false })
      toast({
        kind: 'success',
        title: run ? tr('Đã đưa {n} task vào hàng đợi', { n: r.created }) : tr('Đã tạo {n} task ở Backlog', { n: r.created }),
        body: r.skipped ? tr('Bỏ qua {n} dòng trùng', { n: r.skipped }) : undefined,
      })
      onClose()
    } catch (e) {
      setCreateError((e as Error).message)
      // Dữ liệu trên server có thể đã đổi (vd. task trùng mới tạo): kiểm tra lại.
      setExcluded((s) => new Set(s))
    } finally {
      setCreating(false)
    }
  }

  const submit = () => {
    if (!canCreate) return
    if (run) setConfirmQueue(true)
    else void doCreate()
  }

  const toggle = (line: number) =>
    setExcluded((s) => {
      const next = new Set(s)
      if (next.has(line)) next.delete(line)
      else next.add(line)
      return next
    })

  const excludeErrors = () => setExcluded((s) => new Set([...s, ...(result?.rows ?? []).filter((r) => r.status === 'error').map((r) => r.line)]))

  const projectName = (id?: string) => projects.find((p) => p.id === id)?.name ?? id ?? ''
  const hasColumn = (f: ImportField) => !!mapped?.columns.some((c) => c.field === f)

  const statusCell = (r: ImportRowResult | undefined, skipped: boolean) => {
    if (skipped) return <span className="text-slate-400">{tr('Không import')}</span>
    if (!r) return <span className="text-slate-400">{checking ? tr('Đang kiểm tra…') : '—'}</span>
    if (r.status === 'ok')
      return (
        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
          <CircleCheck size={14} /> {r.duplicateOf ? tr('Trùng, vẫn tạo') : tr('Hợp lệ')}
        </span>
      )
    if (r.status === 'duplicate')
      return (
        <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
          <Copy size={14} />
          {r.duplicateOf?.taskId !== undefined
            ? tr('Trùng task #{id}, bỏ qua', { id: r.duplicateOf.taskId })
            : tr('Trùng dòng {line}, bỏ qua', { line: r.duplicateOf?.line ?? '' })}
        </span>
      )
    return (
      <ul className="space-y-0.5 text-rose-700 dark:text-rose-400">
        {(r.errors ?? []).map((err, i) => (
          <li key={i} className="flex gap-1">
            <CircleX size={14} className="mt-0.5 shrink-0" /> {err}
          </li>
        ))}
      </ul>
    )
  }

  const projectSelect = (
    <Field label={mapped && hasColumn('project') ? tr('Project mặc định (dòng không ghi project)') : 'Project'}>
      <select className={inputCls} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </Field>
  )

  // ------------------------------------------------------------ bước 1: chọn nguồn
  const pickStep = (
    <div className="space-y-4">
      {projectSelect}
      <label
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center text-sm transition-colors ${
          dragging ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40' : 'border-slate-300 hover:border-indigo-400 dark:border-slate-700'
        }`}
      >
        <Upload size={28} className="text-slate-400" />
        <span className="font-medium text-slate-700 dark:text-slate-200">{reading ? tr('Đang đọc file…') : tr('Chọn file hoặc kéo thả vào đây')}</span>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {tr('CSV hoặc Excel (.xlsx, sheet đầu tiên). Tối đa {rows} dòng, {mb} MB.', { rows: IMPORT_MAX_ROWS, mb: IMPORT_MAX_BYTES / 1024 / 1024 })}
        </span>
        <input
          type="file"
          accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void readFile(f)
          }}
        />
      </label>

      <div className="space-y-2">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{tr('Hoặc dán từ Excel / Google Sheets')}</span>
        <textarea
          className={`${inputCls} h-28 font-mono text-xs`}
          placeholder={tr('Copy cả vùng ô (gồm dòng tiêu đề cột) rồi dán vào đây')}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={readPaste} disabled={!paste.trim()}>
            <ClipboardPaste size={14} /> {tr('Đọc dữ liệu đã dán')}
          </Button>
        </div>
      </div>

      {readError && <ErrorBox>{readError}</ErrorBox>}

      <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800/50 dark:text-slate-300">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{tr('Các cột nhận được (dòng đầu là tên cột)')}</span>
          <span className="inline-flex items-center gap-2">
            <button
              type="button"
              onClick={() => void downloadTemplate('xlsx')}
              className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              <Download size={13} /> {tr('Tải file mẫu (Excel)')}
            </button>
            <button type="button" onClick={() => void downloadTemplate('csv')} className="text-slate-500 hover:underline dark:text-slate-400">
              {tr('hoặc CSV')}
            </button>
          </span>
        </div>
        <p>
          <b>title</b> / {tr('Tiêu đề')} ({tr('bắt buộc')}), <b>prompt</b> / {tr('Mô tả')} ({tr('bắt buộc')}), <b>key</b> / {tr('Mã')}, <b>depends_on</b> /{' '}
          {tr('Chờ task')}, <b>project</b>, <b>priority</b> / {tr('Độ ưu tiên')}, <b>tags</b>, <b>model</b>, <b>agent</b>, <b>permission_mode</b> / {tr('Mức quyền')},{' '}
          <b>max_cost_usd</b>, <b>write_scope</b> / {tr('Phạm vi ghi')}, <b>plan_mode</b> / {tr('Cách làm')}.
        </p>
        <p className="mt-1">{tr('Chờ task: mã của dòng khác trong file hoặc #id task đã có, cách nhau bởi dấu phẩy.')}</p>
      </div>
    </div>
  )

  // ------------------------------------------------------------ bước 2: xem trước
  const previewStep = mapped && source && (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <FileSpreadsheet size={16} className="text-slate-400" />
        <span className="font-medium">{source.name}</span>
        <span className="text-slate-500">· {tr('{n} dòng', { n: mapped.rows.length })}</span>
        <Button size="sm" variant="ghost" onClick={() => setMapped(null)}>
          {tr('Chọn nguồn khác')}
        </Button>
      </div>

      {source.kind === 'csv' && (
        <div className="space-y-1">
          {source.fallback && (
            <WarnBox>{tr('File không phải UTF-8 nên đã đọc theo Windows-1258 (Excel tiếng Việt). Nếu chữ vẫn lỗi, hãy chọn mã hoá khác.')}</WarnBox>
          )}
          <label className="flex items-center gap-2 text-sm">
            <span className="text-slate-600 dark:text-slate-300">{tr('Mã hoá')}</span>
            <select className={`${inputCls} w-auto py-1`} value={source.encoding} onChange={(e) => changeEncoding(e.target.value as CsvEncoding)}>
              {CSV_ENCODINGS.map((enc) => (
                <option key={enc} value={enc}>
                  {encodingLabel(enc)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {mapped.missing.length > 0 && (
        <ErrorBox>
          {tr('Thiếu cột bắt buộc: {cols}. Tên cột nhận được: title/Tiêu đề, prompt/Mô tả.', {
            cols: mapped.missing.map(fieldLabel).join(', '),
          })}
        </ErrorBox>
      )}
      {mapped.unknown.length > 0 && (
        <p className="text-xs text-slate-500 dark:text-slate-400">{tr('Bỏ qua các cột không nhận ra: {cols}', { cols: mapped.unknown.join(', ') })}</p>
      )}
      {mapped.truncated > 0 && <WarnBox>{tr('Chỉ lấy {max} dòng đầu, bỏ {n} dòng còn lại.', { max: IMPORT_MAX_ROWS, n: mapped.truncated })}</WarnBox>}

      {mapped.missing.length === 0 && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            {projectSelect}
            <Field label={tr('Dòng trùng tiêu đề')}>
              <select className={inputCls} value={onDuplicate} onChange={(e) => setOnDuplicate(e.target.value as 'skip' | 'create')}>
                <option value="skip">{tr('Bỏ qua')}</option>
                <option value="create">{tr('Vẫn tạo')}</option>
              </select>
            </Field>
            <Field label={tr('Tạo ở')}>
              <select className={inputCls} value={run ? 'queued' : 'backlog'} onChange={(e) => setRun(e.target.value === 'queued')}>
                <option value="backlog">{tr('Backlog (chưa chạy)')}</option>
                <option value="queued">{tr('Hàng đợi (tự chạy)')}</option>
              </select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            {result ? (
              <>
                <span className="text-emerald-700 dark:text-emerald-400">{tr('{n} hợp lệ', { n: counts.ok })}</span>
                {counts.duplicate > 0 && <span className="text-amber-700 dark:text-amber-400">{tr('{n} trùng (bỏ qua)', { n: counts.duplicate })}</span>}
                {counts.error > 0 && <span className="text-rose-700 dark:text-rose-400">{tr('{n} lỗi', { n: counts.error })}</span>}
                {excluded.size > 0 && <span className="text-slate-500">{tr('{n} không import', { n: excluded.size })}</span>}
                {counts.error > 0 && (
                  <Button size="sm" variant="ghost" onClick={excludeErrors}>
                    {tr('Bỏ chọn các dòng lỗi')}
                  </Button>
                )}
              </>
            ) : (
              <span className="text-slate-500">{checking ? tr('Đang kiểm tra…') : included.length ? '' : tr('Chưa chọn dòng nào')}</span>
            )}
          </div>

          <div className="max-h-[45vh] overflow-auto rounded-lg ring-1 ring-slate-200 dark:ring-slate-800">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                <tr>
                  <th className="w-8 px-2 py-2">
                    <input
                      type="checkbox"
                      aria-label={tr('Chọn tất cả')}
                      checked={excluded.size === 0}
                      onChange={() => setExcluded(excluded.size === 0 ? new Set(mapped.rows.map((r) => r.line)) : new Set())}
                    />
                  </th>
                  <th className="px-2 py-2">{tr('Dòng')}</th>
                  {hasColumn('key') && <th className="px-2 py-2">{tr('Mã')}</th>}
                  <th className="px-2 py-2">{tr('Tiêu đề')}</th>
                  {hasColumn('project') && <th className="px-2 py-2">Project</th>}
                  {hasColumn('dependsOn') && <th className="px-2 py-2">{tr('Chờ task')}</th>}
                  <th className="px-2 py-2">{tr('Kết quả')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {mapped.rows.map((row) => {
                  const skipped = excluded.has(row.line)
                  const r = byLine.get(row.line)
                  return (
                    <tr key={row.line} className={skipped ? 'opacity-50' : r?.status === 'error' ? 'bg-rose-50/60 dark:bg-rose-950/20' : ''}>
                      <td className="px-2 py-1.5 align-top">
                        <input type="checkbox" aria-label={tr('Import dòng {line}', { line: row.line })} checked={!skipped} onChange={() => toggle(row.line)} />
                      </td>
                      <td className="px-2 py-1.5 align-top tabular-nums text-slate-500">{row.line}</td>
                      {hasColumn('key') && <td className="px-2 py-1.5 align-top font-mono">{row.key}</td>}
                      <td className="max-w-[16rem] px-2 py-1.5 align-top">
                        <div className="truncate font-medium" title={row.title}>
                          {row.title || <span className="italic text-slate-400">{tr('(trống)')}</span>}
                        </div>
                        <div className="truncate text-slate-500" title={row.prompt}>
                          {row.prompt.split('\n')[0]}
                        </div>
                      </td>
                      {hasColumn('project') && <td className="px-2 py-1.5 align-top">{r?.projectId ? projectName(r.projectId) : row.project}</td>}
                      {hasColumn('dependsOn') && <td className="px-2 py-1.5 align-top font-mono">{row.dependsOn?.join(', ')}</td>}
                      <td className="px-2 py-1.5 align-top">{statusCell(r, skipped)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {autoCount > 0 && (
            <div className="space-y-2 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
              <p className="flex gap-2">
                <TriangleAlert size={16} className="mt-0.5 shrink-0" />
                {tr('{n} task dùng mức quyền Auto: Claude sẽ tự chạy lệnh và sửa file không cần bạn duyệt (trừ lệnh rủi ro cao). Chỉ import nếu bạn tin nội dung file.', {
                  n: autoCount,
                })}
              </p>
              <label className="flex items-center gap-2 font-medium">
                <input type="checkbox" checked={confirmAuto} onChange={(e) => setConfirmAuto(e.target.checked)} />
                {tr('Tôi đã đọc và đồng ý dùng mức quyền Auto cho các task này')}
              </label>
            </div>
          )}
        </>
      )}

      {requestError && <ErrorBox>{requestError}</ErrorBox>}
      {createError && <ErrorBox>{createError}</ErrorBox>}
    </div>
  )

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={tr('Import task từ CSV / Excel')}
        wide="xl"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {tr('Huỷ')}
            </Button>
            {mapped && (
              <Button variant="primary" onClick={submit} disabled={!canCreate}>
                {creating ? tr('Đang tạo…') : tr('Tạo {n} task', { n: counts.ok })}
              </Button>
            )}
          </>
        }
      >
        {mapped && source ? previewStep : pickStep}
      </Modal>
      <ConfirmDialog
        open={confirmQueue}
        title={tr('Đưa vào hàng đợi?')}
        message={tr('{n} task sẽ tự chạy theo thứ tự dòng, tối đa số task song song của project. Mỗi lần chạy dùng hạn mức gói Claude của bạn.', { n: counts.ok })}
        confirmLabel={tr('Tạo và đưa vào hàng đợi')}
        onConfirm={() => void doCreate()}
        onClose={() => setConfirmQueue(false)}
      />
    </>
  )
}

function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
      <CircleX size={16} className="mt-0.5 shrink-0" />
      <div>{children}</div>
    </div>
  )
}

function WarnBox({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
      <TriangleAlert size={16} className="mt-0.5 shrink-0" />
      <div>{children}</div>
    </div>
  )
}
