import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2, Monitor, RotateCw, ShieldCheck, Smartphone, Tablet } from 'lucide-react'
import type { FileDiff } from '../types'

const VIEWPORTS = [
  { id: 'desktop', label: 'Desktop', width: 1280, icon: Monitor },
  { id: 'tablet', label: 'Tablet', width: 768, icon: Tablet },
  { id: 'mobile', label: 'Mobile', width: 390, icon: Smartphone },
] as const
type ViewportId = (typeof VIEWPORTS)[number]['id']

const VP_KEY = 'html-preview-viewport'
const FRAME_HEIGHT = 640

function loadViewport(): ViewportId {
  try {
    const v = localStorage.getItem(VP_KEY)
    if (VIEWPORTS.some((x) => x.id === v)) return v as ViewportId
  } catch {
    /* bỏ qua */
  }
  return 'desktop'
}

const segCls = (on: boolean) =>
  `inline-flex items-center gap-1 px-2 py-1 text-xs ${on ? 'bg-slate-100 font-medium text-slate-900 dark:bg-slate-700 dark:text-white' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'}`

/**
 * Xem trước trang HTML tĩnh của task trong iframe sandbox (origin riêng, không đụng được Task Board).
 * Khổ màn hình được thu nhỏ cho vừa khung; Trước = bản trên nhánh chính, Sau = bản của task.
 */
export function HtmlPreview({ file, getUrl }: { file: FileDiff; getUrl: (path: string, side: 'old' | 'new') => Promise<string> }) {
  const sides: ('old' | 'new')[] = file.status === 'added' ? ['new'] : file.status === 'deleted' ? ['old'] : ['old', 'new']
  const [side, setSide] = useState<'old' | 'new'>(sides[sides.length - 1])
  const [vp, setVp] = useState<ViewportId>(loadViewport)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [boxWidth, setBoxWidth] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => setSide(sides[sides.length - 1]), [file.path, file.status])

  // Link có token hết hạn sau 30 phút: lấy mới khi đổi file/bên hoặc bấm Tải lại
  useEffect(() => {
    let alive = true
    setUrl(null)
    setError(null)
    setLoading(true)
    getUrl(side === 'old' ? (file.oldPath ?? file.path) : file.path, side)
      .then((u) => alive && setUrl(u))
      .catch((e: Error) => {
        if (!alive) return
        setError(e.message || 'Không tạo được link xem trước')
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [file.path, file.oldPath, side, reload])

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth))
    ro.observe(el)
    setBoxWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const viewport = VIEWPORTS.find((v) => v.id === vp)!
  const scale = boxWidth > 0 ? Math.min(1, (boxWidth - 24) / viewport.width) : 1
  const chooseVp = (id: ViewportId) => {
    setVp(id)
    try {
      localStorage.setItem(VP_KEY, id)
    } catch {
      /* bỏ qua */
    }
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-1.5 dark:border-slate-800">
        <div className="flex overflow-hidden rounded-md ring-1 ring-slate-200 dark:ring-slate-700" role="group" aria-label="Khổ màn hình">
          {VIEWPORTS.map((v) => (
            <button key={v.id} onClick={() => chooseVp(v.id)} className={segCls(vp === v.id)} title={`${v.label} · ${v.width}px`}>
              <v.icon size={13} /> <span className="hidden sm:inline">{v.label}</span>
            </button>
          ))}
        </div>
        {sides.length > 1 && (
          <div className="flex overflow-hidden rounded-md ring-1 ring-slate-200 dark:ring-slate-700" role="group" aria-label="Phiên bản">
            <button onClick={() => setSide('old')} className={segCls(side === 'old')} title="Bản trên nhánh chính">
              Trước
            </button>
            <button onClick={() => setSide('new')} className={segCls(side === 'new')} title="Bản của task">
              Sau
            </button>
          </div>
        )}
        <span className="text-xs tabular-nums text-slate-400">
          {viewport.width}px{scale < 1 ? ` · thu nhỏ ${Math.round(scale * 100)}%` : ''}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setReload((n) => n + 1)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            title="Tải lại trang (lấy link mới)"
          >
            <RotateCw size={13} /> Tải lại
          </button>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              title="Mở trang ở tab mới (link hết hạn sau 30 phút)"
            >
              <ExternalLink size={13} /> Mở tab mới
            </a>
          )}
        </div>
      </div>

      <div ref={boxRef} className="relative overflow-hidden bg-slate-100 p-3 dark:bg-slate-950/60" style={{ height: FRAME_HEIGHT * scale + 24 }}>
        {loading && !error && (
          <div className="absolute inset-0 grid place-items-center">
            <Loader2 size={20} className="animate-spin text-slate-400" />
          </div>
        )}
        {error && <p className="absolute inset-0 grid place-items-center px-4 text-center text-sm text-rose-600 dark:text-rose-400">{error}</p>}
        {url && (
          <div className="mx-auto overflow-hidden rounded-md bg-white shadow ring-1 ring-slate-200 dark:ring-slate-700" style={{ width: viewport.width * scale, height: FRAME_HEIGHT * scale }}>
            <iframe
              key={`${url}:${reload}`}
              src={url}
              title={`Xem trước ${file.path}`}
              // Không có allow-same-origin: trang chạy với origin rỗng, không đọc được cookie/dữ liệu của Task Board
              sandbox="allow-scripts allow-forms allow-modals allow-popups"
              referrerPolicy="no-referrer"
              onLoad={() => setLoading(false)}
              className="origin-top-left border-0 bg-white"
              style={{ width: viewport.width, height: FRAME_HEIGHT, transform: `scale(${scale})` }}
            />
          </div>
        )}
      </div>
      <p className="flex items-center gap-1.5 border-t border-slate-200 px-3 py-1.5 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
        <ShieldCheck size={12} className="shrink-0" />
        Trang chạy trong vùng cách ly: không truy cập được Task Board, không dùng cookie/localStorage. Đường dẫn tương đối (CSS, JS, ảnh) lấy từ cùng thư mục của task.
      </p>
    </div>
  )
}
