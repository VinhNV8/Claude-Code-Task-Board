import { useCallback, useEffect, useState } from 'react'
import { CircleCheck, Info, Loader2, RotateCcw, TriangleAlert } from 'lucide-react'
import type { MergeCheck } from '../types'
import { fetchMergeCheck } from '../store/store'

/**
 * Trạng thái repo chính trước khi Approve & Merge (G3). Tự kiểm tra khi mở, khi diff đổi và khi quay lại tab
 * trình duyệt (ví dụ vừa commit xong ở VSCode); có nút "Kiểm tra lại".
 */
export function useMergeCheck(taskId: number | undefined, enabled: boolean, diffKey: string) {
  const [check, setCheck] = useState<MergeCheck | null>(null)
  const [loading, setLoading] = useState(false)
  const refresh = useCallback(async () => {
    if (taskId === undefined || !enabled) return
    setLoading(true)
    const r = await fetchMergeCheck(taskId)
    setCheck(r)
    setLoading(false)
  }, [taskId, enabled])

  useEffect(() => {
    if (!enabled) return setCheck(null)
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh, enabled, diffKey])

  return { check, loading, refresh }
}

function FileList({ title, files, tone }: { title: string; files: string[]; tone: 'danger' | 'muted' }) {
  if (!files.length) return null
  return (
    <div>
      <p className="font-medium">
        {title} ({files.length})
      </p>
      <ul className={`max-h-32 overflow-y-auto font-mono ${tone === 'danger' ? 'text-rose-700 dark:text-rose-300' : 'text-slate-500 dark:text-slate-400'}`}>
        {files.map((f) => (
          <li key={f} className="truncate" title={f}>
            {f}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function MergeStatus({ check, loading, onRefresh }: { check: MergeCheck | null; loading: boolean; onRefresh: () => void }) {
  const refreshBtn = (
    <button onClick={onRefresh} disabled={loading} className="inline-flex shrink-0 items-center gap-1 text-xs text-indigo-600 hover:underline disabled:opacity-60 dark:text-indigo-400">
      {loading ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} Kiểm tra lại
    </button>
  )
  if (!check)
    return (
      <div className="flex items-center gap-2 text-xs text-slate-500">
        {loading ? <Loader2 size={14} className="animate-spin" /> : <Info size={14} />}
        <span className="mr-auto">{loading ? 'Đang kiểm tra repo chính…' : 'Chưa kiểm tra được repo chính.'}</span>
        {!loading && refreshBtn}
      </div>
    )
  if (!check.hasChanges) return null

  const others = check.dirty.filter((f) => !check.overlap.includes(f) && !check.staged.includes(f))
  if (check.ready && !check.dirty.length)
    return (
      <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400">
        <CircleCheck size={14} />
        <span className="mr-auto">
          Repo chính sạch, sẵn sàng merge vào <span className="font-mono">{check.mainBranch}</span>.
        </span>
        {refreshBtn}
      </div>
    )
  if (check.ready)
    return (
      <details className="text-xs text-sky-800 dark:text-sky-300">
        <summary className="flex cursor-pointer list-none items-center gap-2">
          <Info size={14} className="shrink-0" />
          <span className="mr-auto">
            Repo chính có {check.dirty.length} file chưa commit nhưng <b>không trùng</b> với file task sửa. Merge vẫn an toàn, các file đó giữ nguyên. <u>Xem file</u>
          </span>
          {refreshBtn}
        </summary>
        <div className="mt-1 pl-6">
          <FileList title="File chưa commit (không liên quan)" files={check.dirty} tone="muted" />
        </div>
      </details>
    )
  return (
    <div className="space-y-1 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
      <div className="flex items-start gap-2">
        <TriangleAlert size={14} className="mt-0.5 shrink-0" />
        <span className="mr-auto">{check.warning ?? 'Repo chính chưa sẵn sàng để merge.'}</span>
        {refreshBtn}
      </div>
      <div className="grid gap-2 pl-6 sm:grid-cols-2">
        <FileList title="Trùng với file task sửa (cần commit hoặc bỏ thay đổi)" files={check.overlap} tone="danger" />
        <FileList title="Đã stage nhưng chưa commit" files={check.staged} tone="danger" />
        <FileList title="Chưa commit, không liên quan (không chặn)" files={others} tone="muted" />
      </div>
      <p className="pl-6 text-slate-600 dark:text-slate-400">Sau khi commit xong, quay lại trang này: trạng thái tự kiểm tra lại.</p>
    </div>
  )
}
