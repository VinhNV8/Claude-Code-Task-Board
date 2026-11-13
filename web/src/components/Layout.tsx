import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Bell,
  ChartColumn,
  CheckCircle2,
  FlaskConical,
  FolderGit2,
  KanbanSquare,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Radar,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  Sun,
  TriangleAlert,
  X,
  XCircle,
} from 'lucide-react'
import { CommandPalette } from './CommandPalette'
import { ClaudeLimitBanner } from './ClaudeLimitBanner'
import { ErrorBoundary } from './ErrorBoundary'
import { IS_MOCK, closeDepsConfirm, dismissToast, getState, resetDemo, runTaskNow, setDemo, updateSettings, useStore } from '../store/store'
import { askPermissionOnce } from '../lib/notify'
import { TaskFormModal } from './TaskFormModal'
import { fetchAuthStatus, logout } from '../lib/auth'
import { tr } from '../lib/i18n'
import { compactBadge, isSidebarShortcut, loadCollapsed, saveCollapsed } from '../lib/sidebar'
import { attentionCounts } from '../lib/review'

// Nhãn môi trường để không nhầm tab DEV với UAT. Bản prod/mock không hiện nhãn.
const ENV_BADGE: Record<string, { label: string; cls: string } | undefined> = {
  dev: { label: 'DEV', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300' },
  uat: { label: 'UAT', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300' },
}
const envBadge = ENV_BADGE[__APP_ENV__]
const TITLE = pageTitle({ env: envBadge?.label })
import { Button, ConfirmDialog } from './ui'
import { Logo } from './Logo'
import { APP_NAME, pageTitle } from '../lib/brand'

// ------------------------------------------------------------ mở modal tạo task từ bất kỳ đâu

const NewTaskCtx = createContext<(projectId?: string) => void>(() => {})
export const useNewTask = () => useContext(NewTaskCtx)

// ------------------------------------------------------------ theme

function useTheme() {
  const [dark, setDark] = useState(() => {
    try {
      const v = localStorage.getItem('theme')
      if (v) return v === 'dark'
    } catch {
      /* bỏ qua */
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try {
      localStorage.setItem('theme', dark ? 'dark' : 'light')
    } catch {
      /* bỏ qua */
    }
  }, [dark])
  return [dark, setDark] as const
}

// ------------------------------------------------------------ mở rộng/thu nhỏ left-menu (chỉ áp dụng màn hình md+)

function storage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(storage()))
  useEffect(() => saveCollapsed(storage(), collapsed), [collapsed])
  // phím tắt [: thu/mở menu
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (isSidebarShortcut({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, targetTag: el?.tagName, isContentEditable: el?.isContentEditable })) {
        e.preventDefault()
        setCollapsed((c) => !c)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  return [collapsed, setCollapsed] as const
}

// ------------------------------------------------------------ layout

export function Layout() {
  const s = useStore()
  const [dark, setDark] = useTheme()
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  // Khi thu nhỏ: ẩn chữ trên md+ (mobile vẫn là thanh ngang như cũ)
  const mdHide = collapsed ? 'md:hidden' : ''
  const [newOpen, setNewOpen] = useState(false)
  const [newProject, setNewProject] = useState<string | undefined>()
  // Nút đăng xuất chỉ hiện khi backend bật đăng nhập (truy cập từ xa, PLAN 4.7)
  const [authRequired, setAuthRequired] = useState(false)
  useEffect(() => {
    fetchAuthStatus()
      .then((a) => setAuthRequired(a.required))
      .catch(() => undefined)
  }, [])
  const { total: attention, needsInput } = useMemo(() => attentionCounts(s.tasks, s.permissions), [s.tasks, s.permissions])

  useEffect(() => {
    document.title = attention > 0 ? `(${attention}) ${TITLE}` : TITLE
  }, [attention])

  // Thông báo trình duyệt (PLAN 3.9): xin quyền một lần ở thao tác đầu tiên (trình duyệt chỉ cho hỏi
  // khi có thao tác người dùng). Đồng ý thì bật luôn; từ chối thì không hỏi lại, bật lại trong Cài đặt.
  useEffect(() => {
    const onFirst = () => {
      window.removeEventListener('pointerdown', onFirst)
      window.removeEventListener('keydown', onFirst)
      void askPermissionOnce().then((r) => {
        if (r === 'granted' && !getState().settings.browserNotifications) void updateSettings({ browserNotifications: true })
      })
    }
    window.addEventListener('pointerdown', onFirst)
    window.addEventListener('keydown', onFirst)
    return () => {
      window.removeEventListener('pointerdown', onFirst)
      window.removeEventListener('keydown', onFirst)
    }
  }, [])

  // phím tắt N: tạo task mới · Ctrl/⌘ K: bảng lệnh
  const [paletteOpen, setPaletteOpen] = useState(false)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
        return
      }
      const tag = (e.target as HTMLElement).tagName
      if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) && !document.querySelector('[aria-modal="true"]')) {
        e.preventDefault()
        setNewOpen(true)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // Mục menu đang mở: "Cần bạn" là view Điều phối của trang Công việc
  const loc = useLocation()
  const onWork = loc.pathname === '/'
  const workView = new URLSearchParams(loc.search).get('view')

  const openNew = (projectId?: string) => {
    setNewProject(projectId)
    setNewOpen(true)
  }

  const nav: { to: string; label: string; icon: ReactNode; active: boolean; badge?: number; urgent?: boolean }[] = [
    { to: '/', label: tr('Công việc'), icon: <KanbanSquare size={18} />, active: onWork && workView !== 'ops' },
    {
      to: '/?view=ops',
      label: tr('Cần bạn'),
      icon: <Radar size={18} />,
      active: onWork && workView === 'ops',
      badge: attention,
      urgent: needsInput > 0,
    },
    { to: '/projects', label: 'Projects', icon: <FolderGit2 size={18} />, active: loc.pathname.startsWith('/projects') },
    { to: '/stats', label: tr('Thống kê'), icon: <ChartColumn size={18} />, active: loc.pathname.startsWith('/stats') },
    { to: '/settings', label: tr('Cài đặt'), icon: <SettingsIcon size={18} />, active: loc.pathname.startsWith('/settings') },
  ]

  return (
    <NewTaskCtx.Provider value={openNew}>
      <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900 md:flex-row dark:bg-slate-950 dark:text-slate-100">
        {/* Sidebar */}
        <aside
          data-collapsed={collapsed}
          className={`flex shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 md:sticky md:top-0 md:h-screen md:flex-col md:items-stretch md:overflow-x-hidden md:border-b-0 md:border-r md:py-4 md:transition-[width] md:duration-200 dark:border-slate-800 dark:bg-slate-900 ${
            collapsed ? 'md:w-16 md:px-2' : 'md:w-56 md:px-3'
          }`}
        >
          <Link to="/" className="mr-2 flex items-center gap-2 px-2 font-semibold md:mb-4 md:mr-0" title={APP_NAME}>
            <Logo size={28} className="shrink-0" />
            <span className={`hidden whitespace-nowrap ${collapsed ? '' : 'md:inline'}`}>{APP_NAME}</span>
            {envBadge && (
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${envBadge.cls} ${mdHide}`}>{envBadge.label}</span>
            )}
          </Link>
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              title={collapsed ? n.label : undefined}
              aria-label={n.label}
              aria-current={n.active ? 'page' : undefined}
              className={`relative flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-sm ${
                n.active
                  ? 'bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              {n.icon}
              <span className={`hidden whitespace-nowrap sm:inline ${mdHide}`}>{n.label}</span>
              {!!n.badge && (
                <span className={`ml-auto rounded-full px-1.5 text-xs font-semibold text-white ${n.urgent ? 'bg-amber-500' : 'bg-violet-500'} ${mdHide}`}>{n.badge}</span>
              )}
              {!!n.badge && collapsed && (
                <span
                  className={`absolute right-0.5 top-0.5 hidden min-w-[16px] rounded-full px-1 text-center text-[10px] font-semibold leading-4 text-white md:block ${
                    n.urgent ? 'bg-amber-500' : 'bg-violet-500'
                  }`}
                >
                  {compactBadge(n.badge)}
                </span>
              )}
            </Link>
          ))}
          <div className="ml-auto flex items-center gap-1 md:ml-0 md:mt-auto md:flex-col md:items-stretch">
            <button
              onClick={() => setDark(!dark)}
              title={collapsed ? (dark ? tr('Giao diện sáng') : tr('Giao diện tối')) : undefined}
              className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
              <span className={`hidden whitespace-nowrap ${collapsed ? '' : 'md:inline'}`}>{dark ? tr('Giao diện sáng') : tr('Giao diện tối')}</span>
            </button>
            {authRequired && (
              <button
                onClick={() => void logout()}
                className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                title={tr('Đăng xuất')}
              >
                <LogOut size={18} />
                <span className={`hidden whitespace-nowrap ${collapsed ? '' : 'md:inline'}`}>{tr('Đăng xuất')}</span>
              </button>
            )}
            {/* Nút mở rộng/thu nhỏ menu — chỉ có trên md+ (mobile là thanh ngang) */}
            <button
              onClick={() => setCollapsed(!collapsed)}
              aria-expanded={!collapsed}
              aria-label={collapsed ? tr('Mở rộng menu') : tr('Thu nhỏ menu')}
              title={`${collapsed ? tr('Mở rộng menu') : tr('Thu nhỏ menu')} (${tr('phím tắt')}: [)`}
              className="hidden items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-slate-600 hover:bg-slate-100 md:flex dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
              <span className={`whitespace-nowrap ${collapsed ? 'hidden' : ''}`}>{tr('Thu nhỏ menu')}</span>
            </button>
          </div>
        </aside>

        {/* Main */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-slate-200 bg-white/80 px-4 py-2.5 backdrop-blur md:px-6 dark:border-slate-800 dark:bg-slate-900/80">
            <RunningIndicator />
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => setPaletteOpen(true)}
                className="hidden w-56 items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-400 hover:border-slate-300 hover:text-slate-600 md:flex dark:border-slate-700 dark:bg-slate-900 dark:hover:text-slate-300"
                title={tr('Tìm task hoặc chạy lệnh (Ctrl K)')}
              >
                <Search size={15} />
                <span className="flex-1 text-left">{tr('Tìm task, lệnh…')}</span>
                <kbd className="rounded border border-slate-300 px-1 font-mono text-[10px] dark:border-slate-600">Ctrl K</kbd>
              </button>
              <button onClick={() => setPaletteOpen(true)} className="rounded-md p-2 text-slate-500 hover:bg-slate-100 md:hidden dark:hover:bg-slate-800" aria-label={tr('Tìm task hoặc lệnh')}>
                <Search size={18} />
              </button>
              {attention > 0 && (
                <Link
                  to="/?view=ops"
                  className={`hidden items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium sm:inline-flex ${
                    needsInput > 0
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                      : 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300'
                  }`}
                >
                  <Bell size={13} /> {tr('{n} việc cần bạn xử lý', { n: attention })}
                </Link>
              )}
              <Button variant="primary" onClick={() => openNew()} title={`${tr('Phím tắt')}: N`}>
                <Plus size={16} /> {tr('Giao việc')}
              </Button>
            </div>
          </header>
          <ClaudeLimitBanner />
          {(s as { connection?: string }).connection === 'offline' && (
            <div className="flex items-center gap-2 border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800 md:px-6 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-300">
              <XCircle size={16} /> {tr('Mất kết nối tới server. Đang thử kết nối lại…')}
            </div>
          )}
          <main className="flex-1 px-4 py-5 md:px-6">
            {(s as { loaded?: boolean }).loaded === false ? (
              <p className="py-12 text-center text-sm text-slate-400">{tr('Đang tải dữ liệu…')}</p>
            ) : (
              // Lỗi hiển thị trong một trang không làm trắng cả ứng dụng; đổi trang thì thử lại
              <ErrorBoundary resetKey={loc.pathname}>
                <Outlet />
              </ErrorBoundary>
            )}
          </main>
        </div>

        <TaskFormModal open={newOpen} onClose={() => setNewOpen(false)} defaultProjectId={newProject} />
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNewTask={() => openNew()} />
        <Toasts />
        <DepsConfirm />
        {IS_MOCK && <DemoPanel />}
      </div>
    </NewTaskCtx.Provider>
  )
}

function RunningIndicator() {
  const s = useStore()
  const running = s.tasks.filter((t) => t.status === 'running').length
  const queued = s.tasks.filter((t) => t.status === 'queued').length
  const slots = s.tasks.filter((t) => t.status === 'running' || t.status === 'needs_input').length
  const max = Math.max(s.settings.maxParallel, slots)
  return (
    <Link
      to="/?view=ops"
      className="flex items-center gap-2.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs tabular-nums text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      title={tr('{running} đang chạy, {waiting} chờ quyền, {queued} trong hàng đợi. Bấm để mở Điều phối', { running, waiting: slots - running, queued })}
    >
      <span className="inline-flex gap-0.5" aria-hidden="true">
        {Array.from({ length: max }, (_, i) => (
          <span key={i} className={`h-2.5 w-1.5 rounded-sm ${i < running ? 'bg-indigo-500' : i < slots ? 'bg-amber-500' : 'bg-slate-200 dark:bg-slate-700'}`} />
        ))}
      </span>
      <span>
        {slots}/{s.settings.maxParallel} {tr('slot')}
      </span>
      <span className="hidden sm:inline">· {tr('{n} chờ', { n: queued })}</span>
    </Link>
  )
}

function Toasts() {
  const { toasts } = useStore()
  const navigate = useNavigate()
  const icon: Record<string, ReactNode> = {
    success: <CheckCircle2 size={18} className="text-emerald-500" />,
    info: <Bell size={18} className="text-violet-500" />,
    warning: <TriangleAlert size={18} className="text-amber-500" />,
    error: <XCircle size={18} className="text-rose-500" />,
  }
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex cursor-pointer gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-lg dark:border-slate-700 dark:bg-slate-900"
          onClick={() => {
            if (t.taskId) navigate(`/tasks/${t.taskId}`)
            dismissToast(t.id)
          }}
        >
          {icon[t.kind]}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t.title}</p>
            {t.body && <p className="truncate text-xs text-slate-500 dark:text-slate-400">{t.body}</p>}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation()
              dismissToast(t.id)
            }}
            className="self-start text-slate-400 hover:text-slate-600"
            aria-label={tr('Đóng')}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

function DemoPanel() {
  const { demo } = useStore()
  const [open, setOpen] = useState(false)
  const toggle = (k: keyof typeof demo, label: string, hint: string) => (
    <label className="flex cursor-pointer items-start gap-2 py-1">
      <input type="checkbox" className="mt-0.5" checked={!!demo[k]} onChange={(e) => setDemo({ [k]: e.target.checked })} />
      <span>
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-[11px] text-slate-500 dark:text-slate-400">{hint}</span>
      </span>
    </label>
  )
  return (
    <div className="fixed bottom-4 left-4 z-[55]">
      {open ? (
        <div className="w-72 rounded-lg border border-fuchsia-300 bg-white p-3 shadow-xl dark:border-fuchsia-800 dark:bg-slate-900">
          <div className="mb-2 flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-fuchsia-700 dark:text-fuchsia-400">
              <FlaskConical size={15} /> {tr('Bảng điều khiển demo')}
            </span>
            <button onClick={() => setOpen(false)} className="text-slate-400" aria-label={tr('Đóng')}>
              <X size={15} />
            </button>
          </div>
          <p className="mb-2 text-[11px] text-slate-500">{tr('Chỉ có trong prototype, dùng để thử các tình huống.')}</p>

          <div className="mb-2">
            <span className="text-xs font-medium">{tr('Tốc độ giả lập: {n}×', { n: demo.speed })}</span>
            <input type="range" min={0.5} max={5} step={0.5} value={demo.speed} onChange={(e) => setDemo({ speed: Number(e.target.value) })} className="w-full" />
          </div>

          <div className="border-t border-slate-200 pt-1 dark:border-slate-700">
            {toggle('nextRunAsksPermission', tr('Lần chạy tới: Claude xin quyền'), tr('Cho mỗi task mới đi qua trạng thái Needs Input'))}
            {toggle('nextRunFails', tr('Lần chạy tới: bị lỗi'), tr('Task sẽ kết thúc ở Failed'))}
            {toggle('mergeConflict', tr('Lần Merge tới: conflict'), tr('Merge thất bại, task giữ ở Review'))}
            {toggle('dirtyMainRepo', tr('Repo chính chưa sạch'), tr('Merge bị chặn cho tới khi bỏ chọn'))}
            {toggle('claudeLimited', tr('Gói Claude hết lượt'), tr('Hiện thông báo hết lượt 5 giờ trên mọi trang'))}
          </div>

          <div className="mt-2 border-t border-slate-200 pt-2 dark:border-slate-700">
            <span className="mb-1 block text-xs font-medium">{tr('Nạp dữ liệu')}</span>
            <div className="flex flex-wrap gap-1">
              <Button size="sm" onClick={() => resetDemo('seed')}>
                <RotateCcw size={12} /> {tr('Mẫu')}
              </Button>
              <Button size="sm" onClick={() => resetDemo('empty')}>
                {tr('Trống')}
              </Button>
              <Button size="sm" onClick={() => resetDemo('many')}>
                {tr('Nhiều task')}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 rounded-full bg-fuchsia-600 px-3 py-2 text-xs font-medium text-white shadow-lg hover:bg-fuchsia-500"
          title={tr('Bảng điều khiển demo')}
        >
          <FlaskConical size={14} /> Demo
        </button>
      )}
    </div>
  )
}

/** FR-08 (R8): "Chạy ngay" task còn chờ task chưa Done → hỏi trước khi gỡ phụ thuộc và chạy. */
function DepsConfirm() {
  const c = useStore().depsConfirm
  return (
    <ConfirmDialog
      open={!!c}
      onClose={closeDepsConfirm}
      title={c ? tr('Chạy ngay #{id}?', { id: c.taskId }) : ''}
      message={
        <>
          <p>{c?.message}</p>
          <p className="mt-2">{tr('Chạy ngay sẽ gỡ toàn bộ phụ thuộc của task này. Phần việc của các task đang chờ có thể chưa có trên nhánh chính.')}</p>
        </>
      }
      confirmLabel={tr('Gỡ phụ thuộc và chạy')}
      danger
      onConfirm={() => c && runTaskNow(c.taskId, true)}
    />
  )
}
