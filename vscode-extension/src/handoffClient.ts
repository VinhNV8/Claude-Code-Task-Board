// Mở task trong Claude Code (SPEC-PLAN-HANDOFF FR-111, FR-112, FR-114a).
// - Long-poll GET /api/handoffs/wait: server trả các yêu cầu "mở trong Claude Code" chưa ai nhận.
// - Cửa sổ VS Code đang mở đúng project nhận việc ngay; cửa sổ khác chờ một chút rồi mới nhận, để terminal
//   mở ở đúng cửa sổ người dùng đang làm. Server chỉ cho lần claim đầu tiên thành công.
// - Terminal chạy thẳng CLI của agent (`claude --resume <id>`) trong thư mục của task. Đóng terminal (hoặc thoát
//   agent) thì báo server mở khoá task, server tính lại diff và đưa task về Review.
// - URI `vscode://<publisher>.agent-task-board/openTask?id=<task>&req=<requestId>` (mở từ trình duyệt) đi cùng đường.
import * as vscode from 'vscode'
import { samePath, type ServerInfo } from './core'

const t = vscode.l10n.t

/** Một yêu cầu mở đang chờ (GET /api/handoffs/wait). */
export interface PendingHandoff {
  taskId: number
  requestId: string
  repoPath: string
}

/** Lệnh mở terminal server trả về khi claim thành công. */
export interface HandoffLaunch {
  title: string
  file: string
  args: string[]
  cwd: string
}

/** Cửa sổ đang mở đúng project thì nhận ngay; cửa sổ khác chờ (ms) để nhường (hàm thuần, để test). */
export function claimDelay(repoPath: string, workspaceDirs: string[], platform: NodeJS.Platform = process.platform) {
  return workspaceDirs.some((d) => samePath(d, repoPath, platform)) ? 0 : 1500
}

/** Tên terminal: `Task #12: Tiêu đề` (cắt ngắn). */
export function terminalName(taskId: number, title: string) {
  const short = title.length > 40 ? `${title.slice(0, 39)}…` : title
  return `Task #${taskId}: ${short}`
}

const WAIT_MS = 25_000
const IDLE_MS = 5_000

export interface HandoffClientOptions {
  readInfo: () => ServerInfo | undefined
  ensureServer: () => Promise<ServerInfo | undefined>
  log: (line: string) => void
}

export function startHandoffClient(o: HandoffClientOptions): vscode.Disposable {
  let stopped = false
  const open = new Map<vscode.Terminal, { taskId: number; requestId: string; port: number }>()
  const seen = new Set<string>()

  const post = async (port: number, path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return { ok: res.ok, json }
  }

  async function launch(info: ServerInfo, taskId: number, requestId: string) {
    if (seen.has(requestId)) return
    seen.add(requestId)
    const r = await post(info.port, `/api/tasks/${taskId}/handoff/claim`, { requestId }).catch((e: Error) => ({ ok: false, json: { error: e.message } }))
    // 409: cửa sổ khác đã nhận, hoặc yêu cầu đã bị huỷ — không làm gì.
    if (!r.ok) {
      o.log(`Handoff task #${taskId}: ${String(r.json.error ?? 'not claimed')}`)
      return
    }
    const l = r.json as unknown as HandoffLaunch
    const term = vscode.window.createTerminal({ name: terminalName(taskId, l.title), cwd: l.cwd, shellPath: l.file, shellArgs: l.args })
    open.set(term, { taskId, requestId, port: info.port })
    term.show()
  }

  async function loop() {
    while (!stopped) {
      const info = o.readInfo()
      if (!info) {
        await sleep(IDLE_MS)
        continue
      }
      try {
        const res = await fetch(`http://127.0.0.1:${info.port}/api/handoffs/wait`, { signal: AbortSignal.timeout(WAIT_MS + 5_000) })
        if (!res.ok) {
          await sleep(IDLE_MS)
          continue
        }
        const { pending } = (await res.json()) as { pending?: PendingHandoff[] }
        const dirs = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)
        for (const p of pending ?? []) {
          if (seen.has(p.requestId)) continue
          const delay = claimDelay(p.repoPath, dirs)
          setTimeout(() => void launch(info, p.taskId, p.requestId), delay)
        }
        // Đã có yêu cầu (đang nhường cửa sổ khác): chờ hết thời gian nhường rồi mới hỏi tiếp, tránh lặp nhanh.
        if (pending?.length) await sleep(2_000)
      } catch {
        await sleep(IDLE_MS) // server tắt / khởi động lại: thử lại sau
      }
    }
  }
  void loop()

  const closeSub = vscode.window.onDidCloseTerminal((term) => {
    const h = open.get(term)
    if (!h) return
    open.delete(term)
    void post(h.port, `/api/tasks/${h.taskId}/handoff/end`, { requestId: h.requestId })
      .then((r) => {
        if (!r.ok) o.log(`Handoff end task #${h.taskId}: ${String(r.json.error ?? '')}`)
      })
      .catch((e: Error) => o.log(`Handoff end task #${h.taskId}: ${e.message}`))
  })

  const uriSub = vscode.window.registerUriHandler({
    async handleUri(uri) {
      if (uri.path !== '/openTask') return
      const q = new URLSearchParams(uri.query)
      const taskId = Number(q.get('id'))
      const requestId = q.get('req') ?? ''
      if (!Number.isInteger(taskId) || !requestId) {
        void vscode.window.showWarningMessage(t('Invalid Task Board link.'))
        return
      }
      const info = await o.ensureServer()
      if (info) await launch(info, taskId, requestId)
    },
  })

  return new vscode.Disposable(() => {
    stopped = true
    closeSub.dispose()
    uriSub.dispose()
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
