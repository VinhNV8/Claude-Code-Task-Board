// Chạy lệnh test của project trong worktree của task, ngay trên trang Review (FR-34).
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, CircleAlert, CircleCheck, CircleSlash, FlaskConical, Loader2, Play, RotateCcw, Square } from 'lucide-react'
import { IS_MOCK, ensureTestOutput, runTests, stopTests, useStore } from '../store/store'
import { Button } from './ui'
import { duration, timeAgo } from '../lib/format'
import type { Project, Task, TestStatus } from '../types'

const STATUS: Record<TestStatus, { label: string; cls: string; icon: JSX.Element }> = {
  running: {
    label: 'Đang chạy',
    cls: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300',
    icon: <Loader2 size={13} className="animate-spin" />,
  },
  passed: {
    label: 'Đạt',
    cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
    icon: <CircleCheck size={13} />,
  },
  failed: { label: 'Lỗi', cls: 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300', icon: <CircleAlert size={13} /> },
  stopped: { label: 'Đã dừng', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300', icon: <CircleSlash size={13} /> },
  error: {
    label: 'Không chạy được',
    cls: 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
    icon: <CircleAlert size={13} />,
  },
}

export function TestPanel({ task, project, now }: { task: Task; project?: Project; now: number }) {
  const s = useStore()
  const run = s.testRuns.find((r) => r.taskId === task.id)
  const output = s.testOutputs[task.id]
  const running = run?.status === 'running'
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const pre = useRef<HTMLPreElement>(null)
  const follow = useRef(true)

  // Mở sẵn output khi đang chạy hoặc khi lỗi
  useEffect(() => {
    if (run && run.status !== 'passed') setOpen(true)
  }, [run?.startedAt, run?.status])
  useEffect(() => {
    if (open && run) ensureTestOutput(task.id)
  }, [open, task.id, run?.startedAt])
  // Tự cuộn theo output mới khi người dùng đang ở cuối
  useEffect(() => {
    const el = pre.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  }, [output?.end, open])

  const command = project?.testCommand
  const claudeBusy = task.status === 'running' || task.status === 'needs_input' || task.status === 'queued'
  const blocked = !command
    ? 'Project chưa cấu hình lệnh test'
    : !task.worktreePath && !IS_MOCK
      ? 'Task chưa có worktree' : claudeBusy ? 'Claude đang làm việc trong worktree' : undefined

  if (!command && !run)
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        <FlaskConical size={15} className="shrink-0" />
        Chưa cấu hình lệnh test cho project này. Thêm trong trang Projects (ví dụ <span className="font-mono">npm test</span>) để chạy test ngay tại đây.
      </div>
    )

  const meta = run && STATUS[run.status]
  const elapsed = run && (run.endedAt ?? now) - run.startedAt

  return (
    <div className="rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <FlaskConical size={15} className="shrink-0 text-slate-500" />
        <span className="text-sm font-medium">Kiểm thử</span>
        <span className="min-w-0 truncate font-mono text-xs text-slate-500" title={run?.command ?? command}>
          $ {running ? run?.command : command ?? run?.command}
        </span>
        {run && meta && (
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
            {meta.icon} {meta.label}
            {run.exitCode !== undefined && run.status === 'failed' && <span className="font-mono opacity-75">(mã {run.exitCode})</span>}
          </span>
        )}
        {run && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {duration(elapsed!)}
            {run.endedAt && <> · {timeAgo(run.endedAt, now)}</>}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          {running ? (
            <Button size="sm" variant="danger" onClick={() => stopTests(task.id)}>
              <Square size={12} /> Dừng
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!!blocked || busy}
              title={blocked}
              onClick={async () => {
                setBusy(true)
                follow.current = true
                await runTests(task.id)
                setBusy(false)
              }}
            >
              {run ? <RotateCcw size={13} /> : <Play size={13} />} {run ? 'Chạy lại test' : 'Chạy test'}
            </Button>
          )}
        </div>
      </div>
      {run?.error && run.status !== 'running' && <p className="border-t border-slate-100 px-3 py-1.5 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">{run.error}</p>}
      {run && (
        <div className="border-t border-slate-100 dark:border-slate-800">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
          >
            <ChevronRight size={12} className={`transition ${open ? 'rotate-90' : ''}`} /> Output
          </button>
          {open && (
            <pre
              ref={pre}
              onScroll={() => {
                const el = pre.current
                if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
              }}
              className="mx-3 mb-3 max-h-80 min-h-[3rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-900 p-2.5 font-mono text-[12px] leading-relaxed text-slate-100"
            >
              {output === undefined ? 'Đang tải…' : output.text || (running ? 'Đang chờ output…' : '(không có output)')}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
