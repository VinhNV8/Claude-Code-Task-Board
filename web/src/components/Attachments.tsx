// F1: tệp đính kèm của task (ảnh, PDF, văn bản). Kéo thả hoặc chọn file; ảnh có xem trước.
import { useRef, useState, type DragEvent } from 'react'
import { FileText, Image as ImageIcon, Paperclip, Trash2, Upload } from 'lucide-react'
import type { Attachment, Task } from '../types'
import { attachmentUrl, deleteAttachment, uploadAttachments } from '../store/store'
import { tr } from '../lib/i18n'

/** Phần mở rộng được nhận, trùng với server/src/attachments.ts. */
export const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.pdf,.md,.txt,.csv,.json,.log'
export const MAX_FILE_MB = 10

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const isImage = (type: string) => type.startsWith('image/')

/** Ô thả file / nút chọn file. Dùng chung cho danh sách đính kèm của task và form tạo task. */
export function FileDrop({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    if (!disabled && e.dataTransfer.files.length) onFiles([...e.dataTransfer.files])
  }
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={`flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs ${
        over ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/40' : 'border-slate-300 dark:border-slate-700'
      } ${disabled ? 'opacity-60' : ''}`}
    >
      <Upload size={14} className="text-slate-400" />
      <span className="text-slate-500 dark:text-slate-400">{tr('Kéo thả file vào đây, hoặc')}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className="rounded border border-slate-200 px-2 py-0.5 font-medium text-indigo-600 hover:border-indigo-400 dark:border-slate-700 dark:text-indigo-400"
      >
        {tr('Chọn file')}
      </button>
      <span className="text-slate-400">{tr('Ảnh, PDF, md, txt, csv, json, log · tối đa {n} MB/file', { n: MAX_FILE_MB })}</span>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) onFiles([...e.target.files])
          e.target.value = ''
        }}
      />
    </div>
  )
}

function AttachmentItem({ taskId, a, onRemove }: { taskId: number; a: Attachment; onRemove?: () => void }) {
  const url = attachmentUrl(taskId, a.name)
  return (
    <li className="flex items-center gap-2 rounded-md border border-slate-200 p-1.5 text-sm dark:border-slate-800">
      <a href={url} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-center gap-2 hover:text-indigo-600" title={tr('Mở file')}>
        {isImage(a.type) ? (
          <img src={url} alt="" className="h-10 w-10 shrink-0 rounded object-cover" loading="lazy" />
        ) : (
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded bg-slate-100 text-slate-500 dark:bg-slate-800">
            <FileText size={18} />
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate font-medium">{a.name}</span>
          <span className="text-xs text-slate-500">{formatSize(a.size)}</span>
        </span>
      </a>
      {onRemove && (
        <button type="button" onClick={onRemove} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600 dark:hover:bg-slate-800" title={tr('Xoá file')}>
          <Trash2 size={14} />
        </button>
      )}
    </li>
  )
}

/** Danh sách đính kèm của task đã lưu. `editable`: thêm/xoá được (task không đang chạy). */
export function AttachmentList({ task, editable }: { task: Task; editable: boolean }) {
  const [busy, setBusy] = useState(false)
  const list = task.attachments ?? []
  const add = async (files: File[]) => {
    setBusy(true)
    await uploadAttachments(task.id, files)
    setBusy(false)
  }
  if (!list.length && !editable) return null
  return (
    <section className="space-y-2">
      <h3 className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700 dark:text-slate-200">
        <Paperclip size={14} /> {tr('Tệp đính kèm')} {list.length > 0 && <span className="text-slate-400">({list.length})</span>}
      </h3>
      {list.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {list.map((a) => (
            <AttachmentItem key={a.name} taskId={task.id} a={a} onRemove={editable ? () => deleteAttachment(task.id, a.name) : undefined} />
          ))}
        </ul>
      )}
      {editable && <FileDrop onFiles={add} disabled={busy} />}
      <p className="text-xs text-slate-400">
        {tr('Agent đọc các file này khi chạy (đường dẫn được thêm vào prompt). File chỉ là tài liệu tham khảo: đừng đính kèm thông tin nhạy cảm.')}
      </p>
    </section>
  )
}

/** File đã chọn trong form tạo task, chưa tải lên (task chưa có id). */
export function PendingFiles({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  return (
    <div className="space-y-1.5">
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">
              {f.type.startsWith('image/') ? <ImageIcon size={11} /> : <FileText size={11} />}
              <span className="max-w-[14rem] truncate">{f.name}</span>
              <span className="text-slate-500">{formatSize(f.size)}</span>
              <button type="button" onClick={() => onChange(files.filter((_, j) => j !== i))} className="text-slate-400 hover:text-rose-600" title={tr('Bỏ')}>
                <Trash2 size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <FileDrop onFiles={(more) => onChange([...files, ...more])} />
    </div>
  )
}
