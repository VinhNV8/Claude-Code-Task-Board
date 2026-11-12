import { Link } from 'react-router-dom'
import { Check, Hand, ShieldCheck, Timer, X } from 'lucide-react'
import type { PermissionRequest, Task } from '../types'
import { decidePermission } from '../store/store'
import { duration } from '../lib/format'
import { Button, useNow } from './ui'

export function PermissionCard({ req, task, showTask }: { req: PermissionRequest; task?: Task; showTask?: boolean }) {
  const now = useNow(1000)
  const left = req.timeoutAt - now
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
      <div className="flex flex-wrap items-start gap-3">
        <Hand className="mt-0.5 shrink-0 text-amber-600" size={20} />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-amber-900 dark:text-amber-200">
            Claude xin quyền dùng <span className="font-mono">{req.tool}</span>
            {showTask && task && (
              <>
                {' '}
                trong{' '}
                <Link to={`/tasks/${task.id}`} className="underline">
                  #{task.id} {task.title}
                </Link>
              </>
            )}
          </p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 px-3 py-2 font-mono text-[13px] text-slate-100">$ {req.input}</pre>
          <p className="mt-2 inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
            <Timer size={13} /> Tự động từ chối sau {duration(left)}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={() => decidePermission(req.id, 'deny')}>
          <X size={16} /> Từ chối
        </Button>
        <Button
          variant="secondary"
          onClick={() => decidePermission(req.id, 'always')}
          title={`Cho phép và thêm quy tắc vào project${req.rules?.length ? `: ${req.rules.join(', ')}` : ''}`}
        >
          <ShieldCheck size={16} /> Luôn cho phép
        </Button>
        <Button variant="success" onClick={() => decidePermission(req.id, 'allow')}>
          <Check size={16} /> Cho phép
        </Button>
      </div>
    </div>
  )
}
