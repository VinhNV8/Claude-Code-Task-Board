// Gói Claude hết lượt (5 giờ / tuần): báo ngay trong VS Code, kể cả khi chưa mở tab Task Board.
// - Thanh trạng thái đổi thành "Claude hết lượt · 14:30" (nền cảnh báo), tooltip là nội dung đầy đủ.
// - Hiện thông báo VS Code một lần cho mỗi lần hết lượt, có nút mở Task Board.
// Chỉ hỏi server khi server đang chạy (không tự khởi động server chỉ để hỏi).
import * as vscode from 'vscode'
import type { ServerInfo } from './core'
import { formatResetAt, isLimitActive, limitNotice, type ClaudeLimit } from '../../web/src/lib/claudeLimit.ts'

const POLL_MS = 60_000
const SEEN_KEY = 'agentTaskBoard.claudeLimitSeen'

export interface LimitWatchOptions {
  ctx: vscode.ExtensionContext
  status: vscode.StatusBarItem
  readInfo: () => ServerInfo | undefined
  openBoard: () => unknown
}

/** Nội dung thanh trạng thái khi hết lượt (hàm thuần, để test). */
export function limitStatusText(l: ClaudeLimit, now = Date.now()) {
  return l.resetAt ? `$(coffee) Claude hết lượt · ${formatResetAt(l.resetAt, now)}` : '$(coffee) Claude hết lượt'
}

export function startClaudeLimitWatch(o: LimitWatchOptions): vscode.Disposable {
  const normal = { text: o.status.text, tooltip: o.status.tooltip }
  let limit: ClaudeLimit | null = null

  const render = () => {
    const now = Date.now()
    if (!isLimitActive(limit, now)) {
      o.status.text = normal.text
      o.status.tooltip = normal.tooltip
      o.status.backgroundColor = undefined
      return
    }
    const n = limitNotice(limit, now)
    o.status.text = limitStatusText(limit, now)
    o.status.tooltip = `${n.title}\n${n.body}`
    o.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
  }

  const notifyOnce = async (l: ClaudeLimit) => {
    // Mỗi lần hết lượt (theo `since`) chỉ báo một lần, dùng chung cho mọi cửa sổ VS Code
    if (o.ctx.globalState.get<number>(SEEN_KEY) === l.since) return
    await o.ctx.globalState.update(SEEN_KEY, l.since)
    const n = limitNotice(l)
    const open = 'Mở Task Board'
    const pick = await vscode.window.showWarningMessage(`${n.title}. ${n.body}`, open)
    if (pick === open) o.openBoard()
  }

  const poll = async () => {
    const info = o.readInfo()
    let next: ClaudeLimit | null = null
    if (info) {
      try {
        const res = await fetch(`http://127.0.0.1:${info.port}/api/claude-limit`, { signal: AbortSignal.timeout(3000) })
        if (res.ok) next = ((await res.json()) as { limit?: ClaudeLimit | null }).limit ?? null
      } catch {
        /* server chưa chạy / đã tắt: coi như không có thông báo */
      }
    }
    limit = next
    render()
    if (isLimitActive(limit)) void notifyOnce(limit)
  }

  void poll()
  const timer = setInterval(() => void poll(), POLL_MS)
  return new vscode.Disposable(() => clearInterval(timer))
}
