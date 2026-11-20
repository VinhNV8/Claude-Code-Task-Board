// Mở task trong Claude Code (SPEC-PLAN-HANDOFF Phần B, FR-110..116).
// Người dùng chuyển task sang một phiên tương tác của agent (terminal VS Code chạy `claude --resume <id>`),
// làm tay xong thì đưa task về Review. Trong lúc làm tay task bị KHOÁ: không tiến trình nào của Task Board
// chạy trên cùng phiên / thư mục (D8).
//
// Trạng thái khoá lưu ở bảng riêng `task_handoffs` (bền qua khởi động lại server, AC-59).
// Extension VS Code nghe /ws/handoff: server phát yêu cầu mở, extension đầu tiên "nhận việc" (claim) thì mở
// terminal, nên mở nhiều cửa sổ VS Code cũng chỉ có một terminal.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { db } from './db.ts'
import type { AgentId, Run, Task, TaskStatus } from './types.ts'

db.exec(`
CREATE TABLE IF NOT EXISTS task_handoffs (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  via TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  claimed_at INTEGER,
  cwd TEXT NOT NULL,
  agent TEXT NOT NULL,
  reminded_at INTEGER
);
`)

/** Cách mở: extension VS Code tự mở terminal, hoặc người dùng tự chạy lệnh đã sao chép. */
export type HandoffVia = 'extension' | 'copy'

export interface Handoff {
  taskId: number
  requestId: string
  via: HandoffVia
  startedAt: number
  /** Extension đã nhận việc và mở terminal. */
  claimedAt?: number
  cwd: string
  agent: AgentId
  remindedAt?: number
}

type Row = Record<string, unknown>
const toHandoff = (r: Row): Handoff => ({
  taskId: r.task_id as number,
  requestId: r.request_id as string,
  via: r.via === 'copy' ? 'copy' : 'extension',
  startedAt: r.started_at as number,
  claimedAt: (r.claimed_at as number | null) ?? undefined,
  cwd: r.cwd as string,
  agent: r.agent as AgentId,
  remindedAt: (r.reminded_at as number | null) ?? undefined,
})

export const handoffs = {
  get: (taskId: number): Handoff | undefined => {
    const r = db.prepare('SELECT * FROM task_handoffs WHERE task_id = ?').get(taskId) as Row | undefined
    return r && toHandoff(r)
  },
  all: (): Handoff[] => (db.prepare('SELECT * FROM task_handoffs ORDER BY started_at').all() as Row[]).map(toHandoff),
  start: (h: Omit<Handoff, 'requestId' | 'startedAt' | 'claimedAt' | 'remindedAt'>, now = Date.now()): Handoff => {
    db.prepare(
      `INSERT INTO task_handoffs (task_id, request_id, via, started_at, cwd, agent) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET request_id=excluded.request_id, via=excluded.via, started_at=excluded.started_at,
         claimed_at=NULL, cwd=excluded.cwd, agent=excluded.agent, reminded_at=NULL`,
    ).run(h.taskId, randomUUID(), h.via, now, h.cwd, h.agent)
    return handoffs.get(h.taskId)!
  },
  /** Nhận việc mở terminal. Chỉ lần claim đầu tiên với đúng requestId thành công. */
  claim: (taskId: number, requestId: string, now = Date.now()): boolean =>
    Number(
      db.prepare('UPDATE task_handoffs SET claimed_at = ? WHERE task_id = ? AND request_id = ? AND claimed_at IS NULL').run(now, taskId, requestId)
        .changes,
    ) > 0,
  markReminded: (taskId: number, now = Date.now()) => db.prepare('UPDATE task_handoffs SET reminded_at = ? WHERE task_id = ?').run(now, taskId),
  end: (taskId: number) => db.prepare('DELETE FROM task_handoffs WHERE task_id = ?').run(taskId),
}

/** Task đang được làm tay trong Claude Code (FR-113): mọi thao tác chạy bị chặn. */
export const isHandedOff = (taskId: number) => !!handoffs.get(taskId)

/** Thông báo khi chặn thao tác trên task đang khoá. */
export const LOCKED_MESSAGE = 'Task đang được mở trong Claude Code. Bấm "Đưa về Review" (hoặc đóng terminal) trước khi chạy hay duyệt task.'

// ---------------------------------------------------------------- lệnh chạy tiếp phiên

export interface InteractiveCommand {
  /** File chạy (đường dẫn CLI agent). */
  file: string
  args: string[]
  cwd: string
  /** Dòng lệnh để người dùng sao chép (FR-112): `cd "<thư mục>" && <cli> --resume <id>`. */
  display: string
}

/** Alias model Claude truyền lại được cho phiên tương tác (giữ prompt cache, FR-74). */
const CLAUDE_MODEL = /^(haiku|sonnet|opus|claude-[\w.-]+)$/i

/**
 * Tham số chạy tiếp phiên ở chế độ tương tác của từng agent (D10). undefined = agent chưa hỗ trợ
 * (ẩn nút "Mở trong…", AC-58).
 */
export function interactiveArgs(agent: AgentId, sessionId: string, model?: string): string[] | undefined {
  if (agent === 'claude') return ['--resume', sessionId, ...(model && CLAUDE_MODEL.test(model) ? ['--model', model] : [])]
  if (agent === 'codex') return ['resume', sessionId]
  return undefined
}

/** Đặt một tham số trong ngoặc kép nếu cần (PowerShell / bash / cmd đều hiểu `"..."` cho đường dẫn có dấu cách). */
export function quoteArg(a: string) {
  return /^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`
}

export function displayCommand(file: string, args: string[], cwd: string) {
  return `cd ${quoteArg(cwd)} && ${[file, ...args].map(quoteArg).join(' ')}`
}

// ---------------------------------------------------------------- điều kiện được mở (B3)

/** Trạng thái mở được ngay; các trạng thái còn lại cần dừng / bỏ hàng đợi trước (hỏi xác nhận). */
const OPEN_NOW: TaskStatus[] = ['review', 'failed']
const OPEN_AFTER_STOP: TaskStatus[] = ['running', 'needs_input', 'queued']

export type HandoffCheck =
  | { ok: true; needsStop: boolean }
  | { ok: false; reason: string }

/**
 * Task có mở được trong agent tương tác không (bảng B3).
 * `needsStop`: task đang chạy / chờ trong hàng đợi, phải dừng trước (giao diện hỏi xác nhận, AC-56).
 */
export function handoffCheck(
  task: Pick<Task, 'status' | 'sessionId'>,
  o: { agent: AgentId; cwd?: string; cwdExists?: (p: string) => boolean; locked?: boolean },
): HandoffCheck {
  if (o.locked) return { ok: false, reason: 'Task đang được mở trong Claude Code.' }
  if (task.status === 'backlog') return { ok: false, reason: 'Task chưa chạy lần nào nên chưa có phiên để mở.' }
  if (task.status === 'done') return { ok: false, reason: 'Task đã xong.' }
  if (!task.sessionId) return { ok: false, reason: 'Task không còn mã phiên của agent để chạy tiếp.' }
  if (!interactiveArgs(o.agent, task.sessionId)) return { ok: false, reason: `Agent ${o.agent} chưa hỗ trợ mở phiên tương tác.` }
  if (!o.cwd || !(o.cwdExists ?? existsSync)(o.cwd)) return { ok: false, reason: 'Thư mục làm việc của task không còn tồn tại.' }
  if (OPEN_NOW.includes(task.status)) return { ok: true, needsStop: false }
  if (OPEN_AFTER_STOP.includes(task.status)) return { ok: true, needsStop: true }
  return { ok: false, reason: 'Task không ở trạng thái mở được.' }
}

/** Agent của lượt chạy cuối (phiên đang lưu thuộc agent này). Run cũ không ghi agent = Claude. */
export const sessionAgent = (lastRun: Pick<Run, 'agent'> | undefined): AgentId => lastRun?.agent ?? 'claude'

/** Mốc nhắc người dùng khi task khoá lâu mà thư mục không đổi (FR-114c). */
export const HANDOFF_REMIND_MS = 12 * 60 * 60 * 1000
