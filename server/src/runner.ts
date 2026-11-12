// Hàng đợi và thực thi task bằng Claude Code CLI (headless, không dùng API key).
import { spawn, type ChildProcess } from 'node:child_process'
import { killTree } from './proc.ts'
import { shutdownTests, stopTests } from './testRunner.ts'
import { createWriteStream, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import readline from 'node:readline'
import { claudeEnv, findClaudeBin } from './claude.ts'
import { DATA_DIR, events, projects, runs, settings, tasks, testRuns } from './db.ts'
import { broadcast } from './bus.ts'
import { StreamParser, type ResultInfo } from './stream.ts'
import { INTERNAL_TOKEN, PORT } from './config.ts'
import { buildClaudeArgs, cleanupMcpConfigs, permissionToolEnabled, removeMcpConfig, writeMcpConfig } from './permissionTool.ts'
import { cleanupHookSettings, formatNotification, removeHookSettings, writeHookSettings } from './hookSettings.ts'
import type { Priority, RunKind, Task, TaskStatus } from './types.ts'

interface Proc {
  child: ChildProcess
  runId: string
  stopping: boolean
}

/** Xoá các file cấu hình tạm của một run (MCP config, settings hooks). */
function removeTempFiles(f: { mcpConfig?: string; hookSettings?: string }) {
  removeMcpConfig(f.mcpConfig)
  removeHookSettings(f.hookSettings)
}

const procs = new Map<number, Proc>()
const RUN_LOG_DIR = join(DATA_DIR, 'runs')
mkdirSync(RUN_LOG_DIR, { recursive: true })

const PRIORITY_ORDER: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 }

// ---------------------------------------------------------------- helpers

export function updateTask(id: number, patch: Parameters<typeof tasks.patch>[1]) {
  const t = tasks.patch(id, patch)
  if (t) broadcast({ type: 'task', task: t })
  return t
}

function addEvent(runId: string, e: Parameters<typeof events.add>[1]) {
  broadcast({ type: 'event', event: events.add(runId, e) })
}

const ACTIVE: TaskStatus[] = ['running', 'needs_input']

function activeCount(projectId?: string) {
  return tasks.byStatus(...ACTIVE).filter((t) => !projectId || t.projectId === projectId).length
}

// ---------------------------------------------------------------- hàng đợi

let pumping = false
let pumpAgain = false

/** Lấy task Queued theo ưu tiên, chạy cho tới khi hết slot (NFR-03). */
export function pump() {
  if (pumping) {
    pumpAgain = true
    return
  }
  pumping = true
  try {
    do {
      pumpAgain = false
      const max = settings.get().maxParallel
      const queued = tasks
        .byStatus('queued')
        .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt)
      for (const t of queued) {
        if (activeCount() >= max) break
        const p = projects.get(t.projectId)
        if (!p) {
          updateTask(t.id, { status: 'failed', failReason: 'Project không còn tồn tại' })
          continue
        }
        if (activeCount(p.id) >= p.maxParallel) continue
        // Task Queued đã từng chạy = được Retry (route /retry đã đưa worktree về mainBranch) → run kind 'retry'.
        const hasRuns = runs.byTask(t.id).length > 0
        startRun(t, hasRuns ? 'retry' : 'initial')
      }
    } while (pumpAgain)
  } finally {
    pumping = false
  }
}

// ---------------------------------------------------------------- chạy

export function startRun(task: Task, kind: RunKind, feedback?: string) {
  const project = projects.get(task.projectId)!
  const bin = findClaudeBin()
  if (!bin) {
    updateTask(task.id, { status: 'failed', failReason: 'Không tìm thấy Claude Code CLI. Đặt biến môi trường CLAUDE_BIN.' })
    return
  }

  const cwd = task.worktreePath ?? project.repoPath
  // Claude sắp sửa code trong worktree: kết quả test đang chạy (nếu có) không còn ý nghĩa.
  void stopTests(task.id, 'Đã dừng vì Claude bắt đầu chạy lại trong worktree.')
  const resume = kind === 'resume' && task.sessionId
  const sessionId = resume ? task.sessionId! : randomUUID()
  const run = runs.create({ id: randomUUID(), taskId: task.id, kind, feedback, sessionId, startedAt: Date.now() })
  broadcast({ type: 'run', run })
  updateTask(task.id, {
    status: 'running',
    startedAt: run.startedAt,
    sessionId,
    failReason: null,
    reviewWarning: null,
  })

  // P3 (PLAN 3.2): file MCP config tạm cho permission prompt tool; tắt bằng TASKBOARD_PERMISSION_TOOL=off.
  let mcpConfig: string | undefined
  if (permissionToolEnabled()) {
    try {
      mcpConfig = writeMcpConfig(RUN_LOG_DIR, run.id, {
        taskId: task.id,
        port: PORT,
        token: INTERNAL_TOKEN,
        // Dài hơn hạn của backend (permissionTimeoutMin) để backend luôn là nơi quyết định timeout;
        // tối thiểu 24 giờ để việc tăng permissionTimeoutMin giữa chừng không bị MCP cắt sớm.
        timeoutMs: Math.max(settings.get().permissionTimeoutMin * 60_000 + 5 * 60_000, 24 * 60 * 60_000),
      })
    } catch (err) {
      finish(task.id, run.id, { exitCode: -1, error: `Không ghi được cấu hình MCP xin quyền: ${(err as Error).message}` })
      return
    }
  }
  // P3 (PLAN 3.6): file settings tạm khai báo hook Notification gọi về /api/hooks/notification.
  let hookSettings: string | undefined
  try {
    hookSettings = writeHookSettings(RUN_LOG_DIR, run.id, { taskId: task.id, port: PORT, token: INTERNAL_TOKEN })
  } catch (err) {
    removeTempFiles({ mcpConfig })
    finish(task.id, run.id, { exitCode: -1, error: `Không ghi được cấu hình hook: ${(err as Error).message}` })
    return
  }
  const tempFiles = { mcpConfig, hookSettings }
  const args = buildClaudeArgs({
    sessionId,
    resume: !!resume,
    permissionMode: task.permissionMode,
    allowedTools: project.allowedTools,
    mcpConfigPath: mcpConfig,
    settingsPath: hookSettings,
  })

  const prompt = kind === 'resume' ? feedback ?? '' : task.prompt
  let child: ChildProcess
  try {
    child = spawn(bin.path, args, { cwd, env: claudeEnv({ TASKBOARD_TASK_ID: String(task.id) }), windowsHide: true })
  } catch (err) {
    removeTempFiles(tempFiles)
    finish(task.id, run.id, { exitCode: -1, error: `Không chạy được Claude CLI: ${(err as Error).message}` })
    return
  }
  const proc: Proc = { child, runId: run.id, stopping: false }
  procs.set(task.id, proc)

  // Prompt qua stdin để tránh lỗi quote trên Windows (P0-SPIKE S4)
  child.stdin?.end(prompt)

  const raw = createWriteStream(join(RUN_LOG_DIR, `${run.id}.jsonl`))
  const parser = new StreamParser(cwd)
  let result: ResultInfo | undefined
  let stderr = ''

  readline.createInterface({ input: child.stdout! }).on('line', (line) => {
    raw.write(line + '\n')
    const parsed = parser.parseLine(line)
    for (const e of parsed.events) addEvent(run.id, e)
    if (parsed.result) result = parsed.result
  })
  child.stderr?.on('data', (d) => {
    stderr = (stderr + d).slice(-4000)
  })
  child.on('error', (err) => {
    stderr += `\n${err.message}`
  })
  child.on('close', (code) => {
    raw.end()
    // Dọn file tạm cả khi run bị dừng (close vẫn phát sau khi taskkill).
    removeTempFiles(tempFiles)
    // stopTask có thể đã xoá entry, và task có thể đã sang run mới: chỉ xoá nếu vẫn là run này.
    if (procs.get(task.id) === proc) procs.delete(task.id)
    if (proc.stopping) return // stopTask đã xử lý
    finish(task.id, run.id, { exitCode: code ?? -1, result, stderr })
  })
}

function finish(
  taskId: number,
  runId: string,
  o: { exitCode: number; result?: ResultInfo; stderr?: string; error?: string },
) {
  const { exitCode, result, stderr, error } = o
  const run = runs.finish(runId, {
    endedAt: Date.now(),
    exitCode,
    numTurns: result?.numTurns,
    costUsd: result?.costUsd,
    summary: result?.text ?? error,
  })
  broadcast({ type: 'run', run })

  const ok = exitCode === 0 && result && !result.isError
  if (ok) {
    // P1: chưa có worktree/diff nên task thành công chuyển thẳng sang Done. P2 sẽ chuyển sang Review.
    updateTask(taskId, { status: 'done' })
  } else {
    let reason = error ?? ''
    if (!reason && result?.apiErrorStatus === 429) reason = 'Vượt giới hạn sử dụng của gói Claude (429). Hãy chạy lại sau.'
    if (!reason && result?.isError) reason = `Claude kết thúc với lỗi: ${result.text}`
    if (!reason) {
      const tail = (stderr ?? '').trim().split('\n').slice(-3).join(' ').trim()
      reason = `Claude CLI thoát với mã ${exitCode}${tail ? `: ${tail}` : ''}`
    }
    if (!result) addEvent(runId, { type: 'result', isError: true, text: reason })
    updateTask(taskId, { status: 'failed', failReason: reason.slice(0, 1000) })
  }
  pump()
}

// ---------------------------------------------------------------- dừng & phục hồi

export async function stopTask(taskId: number) {
  const proc = procs.get(taskId)
  if (proc) {
    proc.stopping = true
    if (proc.child.pid) await killTree(proc.child.pid)
    procs.delete(taskId)
    addEvent(proc.runId, { type: 'result', isError: true, text: 'Đã dừng bởi người dùng.' })
    broadcast({ type: 'run', run: runs.finish(proc.runId, { endedAt: Date.now(), exitCode: 130 }) })
  }
  updateTask(taskId, { status: 'failed', failReason: 'Đã dừng bởi người dùng' })
  pump()
}

export const isRunning = (taskId: number) => procs.has(taskId)

/** Run đang chạy của task (dùng cho hooks/MCP gọi về theo TASKBOARD_TASK_ID). */
export function currentRunId(taskId: number): string | undefined {
  const proc = procs.get(taskId)
  if (proc) return proc.runId
  return runs
    .byTask(taskId)
    .filter((r) => r.endedAt == null)
    .at(-1)?.id
}

/** Hook Notification (PLAN 3.6): ghi event `system` vào log run hiện tại và báo web hiện toast. */
export function notifyFromClaude(taskId: number, n: { message: string; title?: string; notificationType?: string }) {
  const runId = currentRunId(taskId)
  if (!runId) return undefined
  addEvent(runId, { type: 'system', text: formatNotification(n) })
  broadcast({ type: 'notification', taskId, runId, message: n.message, title: n.title, notificationType: n.notificationType })
  return runId
}

/** NFR-05: task đang chạy khi server tắt sẽ chuyển sang Failed. */
export function recover() {
  // File cấu hình tạm của các run dở dang
  cleanupMcpConfigs(RUN_LOG_DIR)
  cleanupHookSettings(RUN_LOG_DIR)
  for (const r of runs.open()) {
    runs.finish(r.id, { endedAt: Date.now(), exitCode: -1 })
    events.add(r.id, { type: 'result', isError: true, text: 'Server đã khởi động lại trong khi task đang chạy.' })
  }
  for (const t of tasks.byStatus(...ACTIVE))
    tasks.patch(t.id, { status: 'failed', failReason: 'Server đã khởi động lại trong khi task đang chạy. Bấm Chạy lại để tiếp tục.' })
  testRuns.abortRunning('Server đã khởi động lại trong khi đang chạy test.')
}

/** Tắt server: chỉ dừng tiến trình; lần khởi động sau recover() sẽ đánh dấu Failed. */
export async function shutdown() {
  for (const proc of procs.values()) {
    proc.stopping = true
    if (proc.child.pid) await killTree(proc.child.pid)
  }
  await shutdownTests()
}
