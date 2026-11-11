import { Link } from 'react-router-dom'
import { ArrowRight, CircleCheckBig, GitPullRequest, Hand, XCircle } from 'lucide-react'
import { useStore } from '../store/store'
import { PermissionCard } from '../components/PermissionCard'
import { EmptyState, StatusBadge } from '../components/ui'
import { timeAgo } from '../lib/format'

export function Inbox() {
  const s = useStore()
  const pending = s.permissions.filter((p) => p.status === 'pending')
  const reviews = s.tasks.filter((t) => t.status === 'review').sort((a, b) => a.updatedAt - b.updatedAt)
  const failed = s.tasks
    .filter((t) => t.status === 'failed' && Date.now() - t.updatedAt < 24 * 3600_000)
    .sort((a, b) => b.updatedAt - a.updatedAt)

  if (pending.length + reviews.length + failed.length === 0)
    return <EmptyState icon={<CircleCheckBig size={48} />} title="Không có việc gì cần bạn xử lý" body="Khi Claude cần cấp quyền hoặc hoàn thành task cần review, chúng sẽ xuất hiện ở đây." />

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <h1 className="text-lg font-semibold">Cần xử lý</h1>

      {pending.length > 0 && (
        <section>
          <h2 className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-400">
            <Hand size={16} /> Claude đang chờ cấp quyền ({pending.length})
          </h2>
          <div className="space-y-3">
            {pending.map((p) => (
              <PermissionCard key={p.id} req={p} task={s.tasks.find((t) => t.id === p.taskId)} showTask />
            ))}
          </div>
        </section>
      )}

      {reviews.length > 0 && (
        <section>
          <h2 className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-violet-700 dark:text-violet-400">
            <GitPullRequest size={16} /> Chờ review ({reviews.length})
          </h2>
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {reviews.map((t) => {
              const files = s.diffs[t.id] ?? []
              const lastRun = [...s.runs].reverse().find((r) => r.taskId === t.id)
              return (
                <li key={t.id}>
                  <Link to={`/tasks/${t.id}?tab=review`} className="flex items-center gap-4 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        <span className="mr-2 font-mono text-slate-400">#{t.id}</span>
                        {t.title}
                      </p>
                      <p className="mt-0.5 line-clamp-1 text-xs text-slate-500 dark:text-slate-400">{lastRun?.summary}</p>
                      {t.reviewWarning && <p className="mt-1 text-xs text-rose-600">⚠ {t.reviewWarning}</p>}
                    </div>
                    <div className="shrink-0 text-right text-xs text-slate-500 dark:text-slate-400">
                      <p>
                        {files.length} file · <span className="text-emerald-600">+{files.reduce((a, f) => a + f.additions, 0)}</span>{' '}
                        <span className="text-rose-600">−{files.reduce((a, f) => a + f.deletions, 0)}</span>
                      </p>
                      <p>{timeAgo(t.updatedAt)}</p>
                    </div>
                    <ArrowRight size={16} className="shrink-0 text-slate-400" />
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {failed.length > 0 && (
        <section>
          <h2 className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-rose-700 dark:text-rose-400">
            <XCircle size={16} /> Lỗi trong 24 giờ qua ({failed.length})
          </h2>
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {failed.map((t) => (
              <li key={t.id}>
                <Link to={`/tasks/${t.id}`} className="flex items-center gap-4 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      <span className="mr-2 font-mono text-slate-400">#{t.id}</span>
                      {t.title}
                    </p>
                    <p className="mt-0.5 line-clamp-1 text-xs text-rose-600 dark:text-rose-400">{t.failReason}</p>
                  </div>
                  <StatusBadge status={t.status} />
                  <ArrowRight size={16} className="shrink-0 text-slate-400" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
