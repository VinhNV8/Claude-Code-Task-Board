import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Coffee } from 'lucide-react'
import { useStore } from '../store/store'
import { isLimitActive, limitNotice } from '../lib/claudeLimit'
import { AGENT_NAMES } from '../lib/agent'
import { tr } from '../lib/i18n'

/** Gói Claude hết lượt (5 giờ / tuần): dải thông báo nằm dưới thanh trên cùng, hiện ở mọi trang. */
export function ClaudeLimitBanner() {
  const { claudeLimit, tasks } = useStore()
  // Đếm ngược theo phút; tới giờ có lượt lại thì tự ẩn (server cũng gửi lệnh xoá).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!claudeLimit) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [claudeLimit])

  if (!isLimitActive(claudeLimit, now)) return null
  const queued = tasks.filter((t) => t.status === 'queued').length
  const { title, body } = limitNotice(claudeLimit, now, queued)
  // FR-99: task đang chạy tiếp bằng agent dự phòng (đếm theo agent)
  const switched = new Map<string, number>()
  for (const t of tasks)
    if (t.activeAgent && ['queued', 'running', 'needs_input'].includes(t.status))
      switched.set(AGENT_NAMES[t.activeAgent], (switched.get(AGENT_NAMES[t.activeAgent]) ?? 0) + 1)
  const switchedText = [...switched].map(([name, n]) => tr('{n} task đang chạy bằng {agent}', { n, agent: name })).join(', ')
  return (
    <div
      role="status"
      className="flex items-start gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 md:px-6 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
      title={claudeLimit.raw ? `Thông báo gốc của Claude: ${claudeLimit.raw}` : undefined}
    >
      <Coffee size={18} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="text-amber-800/90 dark:text-amber-200/80">{body}</p>
        {switchedText && <p className="text-amber-800/90 dark:text-amber-200/80">↪ {switchedText}</p>}
      </div>
      {queued > 0 && (
        <Link
          to="/?view=ops"
          className="shrink-0 self-center rounded-md border border-amber-300 px-2.5 py-1 text-xs font-medium hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-900/50"
        >
          Xem hàng đợi
        </Link>
      )}
    </div>
  )
}
