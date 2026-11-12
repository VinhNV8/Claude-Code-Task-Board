import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, CircleCheckBig, GitPullRequest, Hand, Layers, X, XCircle } from 'lucide-react'
import { decidePermissionsBatch, useStore } from '../store/store'
import { DenyReasonBox, PermissionCard } from '../components/PermissionCard'
import { stripMarkdown } from '../components/Markdown'
import { Button, ConfirmDialog, EmptyState, StatusBadge } from '../components/ui'
import { timeAgo } from '../lib/format'
import type { PermissionRequest, Task } from '../types'

/** FR-46: nhóm yêu cầu "giống hệt" (cùng tool, cùng chuỗi input sau khi trim), giữ thứ tự xuất hiện. */
function groupSame(reqs: PermissionRequest[]): PermissionRequest[][] {
  const groups = new Map<string, PermissionRequest[]>()
  for (const r of reqs) {
    const key = `${r.tool}\u0000${r.input.trim()}`
    const g = groups.get(key)
    if (g) g.push(r)
    else groups.set(key, [r])
  }
  return [...groups.values()]
}

/** Nhóm ≥ 2 yêu cầu giống hệt: duyệt một lần cho tất cả; từng thẻ bên trong vẫn duyệt riêng được. */
function PermissionGroup({ reqs, tasks }: { reqs: PermissionRequest[]; tasks: Task[] }) {
  const [busy, setBusy] = useState(false)
  const [denying, setDenying] = useState(false)
  const [confirmHigh, setConfirmHigh] = useState(false)
  const high = reqs.some((r) => r.risk === 'high')
  const ids = reqs.map((r) => r.id)
  const riskReasons = [...new Set(reqs.flatMap((r) => r.riskReasons ?? []))]

  async function run(decision: 'allow' | 'deny', reason?: string) {
    if (busy) return
    setBusy(true)
    try {
      await decidePermissionsBatch(ids, decision, reason)
    } finally {
      setBusy(false)
      setDenying(false)
    }
  }

  return (
    <div className={`rounded-xl border-2 border-dashed p-3 ${high ? 'border-red-300 dark:border-red-800' : 'border-amber-300 dark:border-amber-800'}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="inline-flex flex-1 items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <Layers size={16} /> {reqs.length} task đang chờ cùng lệnh này
        </p>
        {!denying && (
          <>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setDenying(true)}>
              <X size={14} /> Từ chối tất cả
            </Button>
            <Button variant="success" size="sm" disabled={busy} onClick={() => (high ? setConfirmHigh(true) : run('allow'))}>
              <Check size={14} /> Cho phép tất cả
            </Button>
          </>
        )}
      </div>
      {denying && (
        <div className="mb-3">
          <DenyReasonBox busy={busy} submitLabel="Từ chối tất cả" onSubmit={(r) => run('deny', r)} onCancel={() => setDenying(false)} />
        </div>
      )}
      <div className="space-y-3">
        {reqs.map((p) => (
          <PermissionCard key={p.id} req={p} task={tasks.find((t) => t.id === p.taskId)} showTask />
        ))}
      </div>
      <ConfirmDialog
        open={confirmHigh}
        danger
        title="Cho phép lệnh rủi ro cao?"
        confirmLabel={`Cho phép cả ${reqs.length} task`}
        message={
          <>
            <p>Lệnh này được xếp rủi ro cao{riskReasons.length ? ':' : '.'}</p>
            {riskReasons.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-red-700 dark:text-red-300">
                {riskReasons.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
            <p className="mt-2">Bạn chắc chắn muốn cho phép cho cả {reqs.length} task cùng lúc?</p>
          </>
        }
        onConfirm={() => run('allow')}
        onClose={() => setConfirmHigh(false)}
      />
    </div>
  )
}

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
            {groupSame(pending).map((g) =>
              g.length === 1 ? (
                <PermissionCard key={g[0].id} req={g[0]} task={s.tasks.find((t) => t.id === g[0].taskId)} showTask />
              ) : (
                <PermissionGroup key={g[0].id} reqs={g} tasks={s.tasks} />
              ),
            )}
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
                      <p className="mt-0.5 line-clamp-1 text-xs text-slate-500 dark:text-slate-400">{lastRun?.summary && stripMarkdown(lastRun.summary)}</p>
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
