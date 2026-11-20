// Mở task trong Claude Code (SPEC-PLAN-HANDOFF Phần B, FR-110..116).
// - Nút "Mở trong Claude Code": khoá task, extension VS Code (nếu đang chạy) tự mở terminal `claude --resume <id>`.
//   Sau vài giây chưa có cửa sổ VS Code nào nhận thì gợi ý mở bằng link vscode:// hoặc sao chép lệnh.
// - Banner khi task đang khoá, kèm nút "Đưa về Review".
import { useEffect, useState } from 'react'
import { Copy, ExternalLink, Lock, Loader2, SquareTerminal, Undo2 } from 'lucide-react'
import { endHandoff, startHandoff, type HandoffStart } from '../store/store'
import { AGENT_NAMES } from '../lib/agent'
import { Button, ConfirmDialog } from './ui'
import { tr } from '../lib/i18n'
import type { AgentId, Run, Task } from '../types'

/** URI extension VS Code nhận (publisher.name trong vscode-extension/package.json). */
const EXTENSION_URI = 'vscode://vinhnguyen.agent-task-board/openTask'
/** Chưa cửa sổ VS Code nào nhận sau mốc này thì hiện cách mở khác. */
const CLAIM_WAIT_MS = 4000

/** Agent có lệnh chạy tiếp phiên ở chế độ tương tác (D10). */
const INTERACTIVE: AgentId[] = ['claude', 'codex']

/** Agent sở hữu phiên đang lưu: agent của lượt chạy cuối (không tính lượt làm tay). */
export function sessionAgentOf(runs: Run[]): AgentId {
  return runs.filter((r) => r.kind !== 'manual').at(-1)?.agent ?? 'claude'
}

/** Nút hiện khi task đã có phiên và không ở Backlog / Done (bảng B3). */
export function canHandoff(task: Task, runs: Run[]) {
  return (
    !task.handoff &&
    !!task.sessionId &&
    ['review', 'failed', 'running', 'needs_input', 'queued'].includes(task.status) &&
    INTERACTIVE.includes(sessionAgentOf(runs))
  )
}

const agentLabel = (a: AgentId) => (a === 'claude' ? 'Claude Code' : AGENT_NAMES[a])

export function HandoffButton({ task, runs, onStarted }: { task: Task; runs: Run[]; onStarted: (s: HandoffStart) => void }) {
  const [busy, setBusy] = useState(false)
  const [askStop, setAskStop] = useState(false)
  const agent = sessionAgentOf(runs)
  if (!canHandoff(task, runs)) return null

  const go = async (stop = false) => {
    setBusy(true)
    try {
      const r = await startHandoff(task.id, 'extension', stop)
      if (r === 'needs_stop') setAskStop(true)
      else if (r) onStarted(r)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        disabled={busy}
        onClick={() => void go()}
        title={tr('Làm tiếp task này trong một phiên {agent} tương tác, giữ nguyên ngữ cảnh agent đã có', { agent: agentLabel(agent) })}
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <SquareTerminal size={16} />} {tr('Mở trong {agent}', { agent: agentLabel(agent) })}
      </Button>
      <ConfirmDialog
        open={askStop}
        title={tr('Dừng task để mở trong {agent}?', { agent: agentLabel(agent) })}
        message={tr('Task đang chạy hoặc đang chờ trong hàng đợi. Task sẽ dừng hẳn rồi mới mở phiên tương tác, để không có hai tiến trình cùng làm trên một phiên.')}
        confirmLabel={tr('Dừng và mở')}
        onConfirm={() => void go(true)}
        onClose={() => setAskStop(false)}
      />
    </>
  )
}

/** Banner khi task đang khoá (FR-113): cách mở nếu VS Code chưa nhận, nút "Đưa về Review". */
export function HandoffBanner({ task, runs, started }: { task: Task; runs: Run[]; started?: HandoffStart }) {
  const [ending, setEnding] = useState(false)
  const [slow, setSlow] = useState(false)
  const [copied, setCopied] = useState(false)
  const h = task.handoff
  useEffect(() => {
    setSlow(false)
    if (!h || h.claimed) return
    const t = setTimeout(() => setSlow(true), Math.max(0, h.startedAt + CLAIM_WAIT_MS - Date.now()))
    return () => clearTimeout(t)
  }, [h?.startedAt, h?.claimed])
  if (!h) return null
  const agent = agentLabel(sessionAgentOf(runs))
  const command = started?.command.display

  const copy = async () => {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* trình duyệt chặn clipboard: người dùng tự chọn và sao chép dòng lệnh */
    }
  }

  return (
    <div className="mb-4 flex gap-2 rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-200">
      <Lock size={18} className="shrink-0" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium">{tr('Đang mở trong {agent}', { agent })}</p>
        <p>
          {h.claimed
            ? tr('Terminal đã mở trong VS Code. Làm xong thì thoát {agent} (hoặc đóng terminal): task tự về Review. Trong lúc này task bị khoá, không chạy hay duyệt được.', { agent })
            : tr('Task bị khoá trong lúc bạn làm tay. Làm xong bấm Đưa về Review.')}
        </p>
        {started?.warning && <p className="text-amber-700 dark:text-amber-300">{started.warning}</p>}
        {!h.claimed && (slow || h.via === 'copy') && (
          <div className="space-y-2 rounded-md border border-violet-200 bg-white/70 p-2 dark:border-violet-900 dark:bg-slate-900/50">
            <p className="text-xs">{tr('Chưa có cửa sổ VS Code nào mở terminal. Mở bằng VS Code, hoặc tự chạy lệnh dưới đây trong terminal:')}</p>
            <div className="flex flex-wrap gap-2">
              {started && (
                <a
                  className="inline-flex items-center gap-1 rounded-md border border-violet-300 px-2.5 py-1 text-xs font-medium hover:bg-violet-100 dark:border-violet-800 dark:hover:bg-violet-900/40"
                  href={`${EXTENSION_URI}?${new URLSearchParams({ id: String(task.id), req: started.requestId })}`}
                >
                  <ExternalLink size={13} /> {tr('Mở bằng VS Code')}
                </a>
              )}
              {command && (
                <Button size="sm" onClick={() => void copy()}>
                  <Copy size={13} /> {copied ? tr('Đã sao chép') : tr('Sao chép lệnh')}
                </Button>
              )}
            </div>
            {command && <code className="block break-all rounded bg-slate-100 px-2 py-1 font-mono text-xs dark:bg-slate-800">{command}</code>}
          </div>
        )}
      </div>
      <Button
        size="sm"
        variant="primary"
        className="shrink-0 self-start"
        disabled={ending}
        onClick={async () => {
          setEnding(true)
          try {
            await endHandoff(task.id)
          } finally {
            setEnding(false)
          }
        }}
        title={tr('Mở khoá task, ghi nhận các thay đổi bạn đã làm tay và chuyển task về Review')}
      >
        {ending ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />} {tr('Đưa về Review')}
      </Button>
    </div>
  )
}
