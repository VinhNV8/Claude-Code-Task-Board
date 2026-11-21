// P5-02 / P5-05: hiển thị model của run (badge trên thẻ task, dòng Model + bảng modelUsage ở tab Lịch sử).
import type { ModelSource, ModelUsage, Run } from '../types'
import { modelLabel, modelTier, type ModelTier } from '../lib/format'
import { LOCALE, tr } from '../lib/i18n'

export const TIER_CLS: Record<ModelTier, string> = {
  haiku: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  sonnet: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  opus: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  other: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
}

/** Biểu tượng nguồn chọn model (D8): tự động, chọn tay, tự nâng. `default` không có biểu tượng. */
export const SOURCE_ICON: Record<ModelSource, string> = { auto: '🤖', manual: '✋', escalated: '⬆', default: '' }

export function sourceTitle(source: ModelSource | undefined) {
  if (source === 'auto') return tr('Hệ thống tự chọn')
  if (source === 'manual') return tr('Bạn chọn')
  if (source === 'escalated') return tr('Tự nâng model sau lần lỗi / yêu cầu sửa')
  return tr('Theo mặc định')
}

/** Run mới nhất của task (theo thời điểm bắt đầu). */
export function latestRun(runs: Run[], taskId: number): Run | undefined {
  let best: Run | undefined
  for (const r of runs) if (r.taskId === taskId && (!best || r.startedAt > best.startedAt)) best = r
  return best
}

/** Badge model của một run: màu theo họ model, biểu tượng nguồn, tooltip là lý do chọn. Run chưa có model thì không hiện. */
export function ModelBadge({ run }: { run?: Pick<Run, 'model' | 'requestedModel' | 'modelSource' | 'modelReason'> }) {
  const id = run?.model ?? run?.requestedModel
  if (!run || !id) return null
  const icon = run.modelSource ? SOURCE_ICON[run.modelSource] : ''
  const title = [sourceTitle(run.modelSource), run.modelReason].filter(Boolean).join(': ')
  return (
    <span className={`inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium ${TIER_CLS[modelTier(id)]}`} title={title}>
      {icon && <span aria-hidden>{icon}</span>}
      {modelLabel(id)}
    </span>
  )
}

const num = (n: number) => n.toLocaleString(LOCALE)
const cost = (v: number) => `$${v.toFixed(v > 0 && v < 1 ? 4 : 2)}`

/** Dòng "Model: Opus 5.5 · 🤖 lý do" của một run; run cũ không có model hiện "—". */
export function ModelLine({ run }: { run: Run }) {
  const id = run.model ?? run.requestedModel
  const icon = run.modelSource ? SOURCE_ICON[run.modelSource] : ''
  return (
    <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
      <span className="text-slate-500">Model:</span> <span className="font-medium">{id ? modelLabel(id) : '—'}</span>
      {(icon || run.modelReason) && (
        <span className="text-slate-500" title={sourceTitle(run.modelSource)}>
          {' · '}
          {icon} {run.modelReason}
        </span>
      )}
    </p>
  )
}

/** Bảng token và chi phí theo model của một run (`modelUsage`). */
export function ModelUsageTable({ usage }: { usage?: Record<string, ModelUsage> }) {
  const rows = Object.entries(usage ?? {})
  if (!rows.length) return null
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <th className="pb-1 font-medium">Model</th>
            <th className="pb-1 text-right font-medium">Input</th>
            <th className="pb-1 text-right font-medium">{tr('Cache đọc')}</th>
            <th className="pb-1 text-right font-medium">{tr('Cache ghi')}</th>
            <th className="pb-1 text-right font-medium">Output</th>
            <th className="pb-1 text-right font-medium">{tr('Chi phí')}</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map(([model, u]) => (
            <tr key={model} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
              <td className="py-1 font-medium">{modelLabel(model)}</td>
              <td className="py-1 text-right">{num(u.inputTokens)}</td>
              <td className="py-1 text-right">{num(u.cacheReadInputTokens)}</td>
              <td className="py-1 text-right">{num(u.cacheCreationInputTokens)}</td>
              <td className="py-1 text-right">{num(u.outputTokens)}</td>
              <td className="py-1 text-right">{cost(u.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-slate-400">{tr('Chi phí ước tính theo giá niêm yết')}</p>
    </div>
  )
}
