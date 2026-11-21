// FR-64: mode Ghi thẳng chỉ ghi nhận thay đổi của chính task.
// Snapshot trước/sau lần chạy chụp cả thư mục project, nên thay đổi của session/công cụ khác trong lúc task chạy cũng lọt vào.
// Ở đây chia các file trong diff thành của task và "thay đổi khác" theo dấu vết trong log của task:
//   (a) agent ghi bằng tool ghi file → đường dẫn có trong log;
//   (b) file thêm/sửa có mtime nằm trong lúc agent đang chạy lệnh shell (hoặc tool có thể ghi file khác: subagent, MCP…);
//   (c) file bị xoá mà lệnh shell của task nhắc tới;
//   (d) lần chạy làm tay trong Claude Code (run kind `manual`): mọi file sửa trong khoảng thời gian của lần chạy.
import { statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { events, runs } from './db.ts'
import { relToCwd } from './writeScopeGuard.ts'
import type { FileDiff, LogEvent, Run } from './types.ts'

/** Tool ghi file (Claude; Codex/Antigravity cũng được driver đổi về các tên này). */
export const WRITE_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** Tool chỉ đọc hoặc không chạm tới file: không mở "cửa sổ" ghi nhận theo thời gian. */
const NO_WRITE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'AskUserQuestion', 'NotebookRead', 'ExitPlanMode'])
/** Độ lệch cho phép giữa đồng hồ sự kiện và mtime của file. */
export const WINDOW_MARGIN_MS = 2000

export interface Activity {
  /** Đường dẫn (tương đối với thư mục làm việc, dùng `/`) mà agent ghi bằng tool ghi file. */
  writes: string[]
  /** Khoảng thời gian [bắt đầu, kết thúc] (ms) agent đang chạy lệnh có thể ghi file. */
  windows: [number, number][]
  /** Nội dung các lệnh shell, để nhận ra file bị xoá bằng lệnh (vd `rm build/x`). */
  shellText: string
}

type RunLite = Pick<Run, 'id' | 'kind' | 'startedAt' | 'endedAt'>
type ToolUse = Extract<LogEvent, { type: 'tool_use' }> & { startedAt?: number }

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '')

/** Hàm thuần: dấu vết ghi file của task qua các lần chạy. */
export function activityOf(runList: RunLite[], eventsOf: (runId: string) => LogEvent[], cwd: string, now: number): Activity {
  const writes: string[] = []
  const windows: [number, number][] = []
  const shell: string[] = []
  for (const run of runList) {
    const runEnd = run.endedAt ?? now
    // (d) làm tay trong Claude Code: không có log thao tác, tính theo khoảng thời gian của lần chạy
    if (run.kind === 'manual') {
      windows.push([run.startedAt - WINDOW_MARGIN_MS, runEnd + WINDOW_MARGIN_MS])
      continue
    }
    const evs = eventsOf(run.id)
    evs.forEach((e, i) => {
      if (e.type !== 'tool_use') return
      const ev = e as ToolUse
      if (WRITE_TOOL_NAMES.has(ev.tool)) {
        for (const raw of ev.input.split(', ')) {
          const p = raw.trim()
          if (!p) continue
          writes.push(norm(relToCwd(p, cwd) ?? p))
        }
        return
      }
      if (NO_WRITE_TOOLS.has(ev.tool)) return
      // (b) lệnh shell, subagent, MCP…: mở cửa sổ từ lúc bắt đầu tới kết quả của chính tool đó
      const start = ev.startedAt ?? ev.ts
      const result = evs.slice(i + 1).find((r) => r.type === 'tool_result' && r.tool === ev.tool)
      const end = result?.ts ?? runEnd
      windows.push([start - WINDOW_MARGIN_MS, end + WINDOW_MARGIN_MS])
      if (ev.tool === 'Bash' || ev.tool === 'PowerShell') shell.push(ev.input)
    })
  }
  return { writes, windows, shellText: shell.join('\n') }
}

/**
 * Hàm thuần: chia file trong diff thành của task (`own`) và thay đổi khác (`foreign`, chỉ đường dẫn).
 * `mtimeOf` trả mtime (ms) của file trong thư mục làm việc, undefined nếu không đọc được.
 */
export function splitByActivity(
  files: FileDiff[],
  act: Activity,
  mtimeOf: (rel: string) => number | undefined,
  caseInsensitive = process.platform === 'win32',
): { own: FileDiff[]; foreign: string[] } {
  const key = (p: string) => (caseInsensitive ? norm(p).toLowerCase() : norm(p))
  const written = new Set(act.writes.map(key))
  const shell = caseInsensitive ? act.shellText.toLowerCase() : act.shellText
  const own: FileDiff[] = []
  const foreign: string[] = []
  for (const f of files) {
    const paths = [f.path, ...(f.oldPath ? [f.oldPath] : [])]
    let mine = paths.some((p) => written.has(key(p)))
    if (!mine && f.status !== 'deleted') {
      const m = mtimeOf(f.path)
      mine = m !== undefined && act.windows.some(([a, b]) => m >= a && m <= b)
    }
    if (!mine && f.status === 'deleted' && shell) {
      const base = basename(f.path)
      mine = shell.includes(key(f.path)) || (base.length >= 3 && shell.includes(caseInsensitive ? base.toLowerCase() : base))
    }
    if (mine) own.push(f)
    else foreign.push(f.path)
  }
  return { own, foreign }
}

/** Chia diff của task theo dấu vết trong DB và mtime hiện tại của file (dùng lúc run kết thúc hoặc khi task đang chạy). */
export function attributeDiff(taskId: number, cwd: string, files: FileDiff[], now = Date.now()) {
  const act = activityOf(runs.byTask(taskId), (id) => events.byRun(id), cwd, now)
  return splitByActivity(files, act, (rel) => {
    try {
      return statSync(join(cwd, rel)).mtimeMs
    } catch {
      return undefined
    }
  })
}
