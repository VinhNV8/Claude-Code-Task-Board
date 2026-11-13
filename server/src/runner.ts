// Hàng đợi và thực thi task bằng Claude Code CLI (headless, không dùng API key).
import { spawn, type ChildProcess } from 'node:child_process'
import { killTree } from './proc.ts'
import { shutdownTests, stopTests } from './testRunner.ts'
import { createWriteStream, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import readline from 'node:readline'
import { claudeEnv, findClaudeBin } from './claude.ts'
import { DATA_DIR, events, projects, runs, settings, taskDeps, tasks, testRuns } from './db.ts'
import { broadcast } from './bus.ts'
import { StreamParser, type ResultInfo } from './stream.ts'
import { INTERNAL_TOKEN, PORT } from './config.ts'
import { buildClaudeArgs, cleanupMcpConfigs, permissionToolEnabled, removeMcpConfig, writeMcpConfig } from './permissionTool.ts'
import { cleanupHookSettings, formatNotification, removeHookSettings, writeHookSettings } from './hookSettings.ts'
import { captureChanges, ensureWorktree, runNumber } from './capture.ts'
import { taskDiff } from './git.ts'
import { MAX_RATE_LIMIT_RETRIES, decideRateLimit, detectRateLimit, orderQueue, type RateLimitEvent } from './rateLimit.ts'
import { CONTINUE_NOTE, CONTINUE_PROMPT, STOP_REASON } from '../../web/src/lib/resume.ts'
import { autoModelNote, chooseRunModel, fallbackModelFor } from './model.ts'
import { applyEscalation, escalationPrompt, maxTierForProject } from './escalation.ts'
import { adjustByHistory } from './modelHistoryService.ts'
// Nạp budgetService cũng đăng ký nguồn budget cho maxTierForProject (B4) và blockedReason cho task gửi ra web.
import { budgetWakeAt, isProjectBlocked, refreshBudgets } from './budgetService.ts'
import { decideBlocked, pendingDeps } from './taskDeps.ts'
import { prepareRetry } from './retry.ts'
import { withLock } from './review.ts'
import { BLOCKED_BY_INSTRUCTION } from '../../web/src/lib/deps.ts'
import type { Project, Run, RunFailKind, RunKind, Task, TaskStatus } from './types.ts'

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
/** Task đang tạo worktree, chưa spawn Claude: taskId → runId. */
const preparing = new Map<number, string>()
const RUN_LOG_DIR = join(DATA_DIR, 'runs')
mkdirSync(RUN_LOG_DIR, { recursive: true })

// ---------------------------------------------------------------- helpers

export function updateTask(id: number, patch: Parameters<typeof tasks.patch>[1]) {
  const t = tasks.patch(id, patch)
  if (t) broadcast({ type: 'task', task: t })
  if (t && patch.status === 'review') void publishDiff(id)
  return t
}

/** Tính lại diff của task và broadcast cho web (PLAN 2.3). Lỗi git chỉ ghi log, không làm hỏng luồng chạy. */
export async function publishDiff(taskId: number) {
  const task = tasks.get(taskId)
  const project = task && projects.get(task.projectId)
  if (!task || !project) return
  try {
    broadcast({ type: 'diff', taskId, files: await taskDiff(project, taskId) })
  } catch (err) {
    console.error(`[diff] task #${taskId}: ${(err as Error).message}`)
  }
}

function addEvent(runId: string, e: Parameters<typeof events.add>[1]) {
  broadcast({ type: 'event', event: events.add(runId, e) })
}

const ACTIVE: TaskStatus[] = ['running', 'needs_input']

function activeCount(projectId?: string) {
  return tasks.byStatus(...ACTIVE).filter((t) => !projectId || t.projectId === projectId).length
}

/**
 * Còn slot để chạy thêm một task của project này không (giới hạn chung và giới hạn project, NFR-03).
 * Project đang tạm dừng vì vượt budget (P6 B3) coi như hết slot: Tiếp tục / Yêu cầu sửa sẽ vào hàng đợi chờ.
 */
export function hasSlot(project: Pick<Project, 'id' | 'maxParallel'>) {
  return activeCount() < settings.get().maxParallel && activeCount(project.id) < project.maxParallel && !isProjectBlocked(project.id)
}

// ---------------------------------------------------------------- hàng đợi

/** Loại run pump() tạo cho task Queued không có pendingFeedback/resumeNext: đã từng chạy → 'retry', chưa → 'initial'. */
export const runKindFor = (hasRuns: boolean): Exclude<RunKind, 'resume' | 'continue'> => (hasRuns ? 'retry' : 'initial')

/** Loại run khi lấy task Queued ra chạy: feedback chờ → 'resume', chờ Tiếp tục → 'continue', còn lại theo runKindFor. */
export function nextRunKind(t: Pick<Task, 'pendingFeedback' | 'resumeNext'>, hasRuns: boolean): RunKind {
  if (t.pendingFeedback) return 'resume'
  if (t.resumeNext) return 'continue'
  return runKindFor(hasRuns)
}

/**
 * Session cho run mới: 'resume'/'continue' (và task còn session id) dùng lại phiên cũ; 'initial'/'retry' luôn phiên mới.
 */
export function sessionFor(kind: RunKind, prevSessionId: string | undefined, newId: () => string = randomUUID) {
  const resume = (kind === 'resume' || kind === 'continue') && !!prevSessionId
  return { resume, sessionId: resume ? prevSessionId! : newId() }
}

let pumping = false
let pumpAgain = false
let wakeTimer: NodeJS.Timeout | undefined
/** setTimeout tối đa ~24,8 ngày; hẹn tối đa 1 giờ rồi tự tính lại. */
const MAX_TIMER_MS = 60 * 60_000

/** Hẹn giờ pump lại khi task chờ do giới hạn sử dụng tới giờ chạy (huỷ hẹn cũ). */
function scheduleWake(wakeAt: number | undefined) {
  if (wakeTimer) clearTimeout(wakeTimer)
  wakeTimer = undefined
  if (wakeAt === undefined) return
  const delay = Math.min(Math.max(wakeAt - Date.now(), 0) + 50, MAX_TIMER_MS)
  wakeTimer = setTimeout(() => {
    wakeTimer = undefined
    pump()
  }, delay)
  wakeTimer.unref?.()
}

/** Lấy task Queued đã tới giờ (notBefore) theo ưu tiên, chạy cho tới khi hết slot (NFR-03). */
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
      const { ready } = orderQueue(tasks.byStatus('queued'))
      for (const t of ready) {
        if (activeCount() >= max) break
        const p = projects.get(t.projectId)
        if (!p) {
          updateTask(t.id, { status: 'failed', failReason: 'Project không còn tồn tại' })
          continue
        }
        if (activeCount(p.id) >= p.maxParallel) continue
        // P6 B3: project pause + vượt budget → task giữ ở Queued (blockedReason tính lúc gửi ra web).
        if (isProjectBlocked(p.id)) continue
        // FR-08 (R3): còn chờ task chưa Done → để lại hàng đợi; task được chờ Done thì pump() chạy lại.
        if (pendingDeps(t).length) continue
        launcher(t)
      }
    } while (pumpAgain)
    // Task đang chờ giờ reset của gói, hoặc project bị tạm dừng vì budget (chạy lại đầu tháng sau):
    // hẹn pump lại đúng lúc (task khác xong cũng gọi pump nên không bị trễ).
    const wakes = [orderQueue(tasks.byStatus('queued')).wakeAt, budgetWakeAt()].filter((w): w is number => w !== undefined)
    scheduleWake(wakes.length ? Math.min(...wakes) : undefined)
  } finally {
    pumping = false
  }
}

// ---------------------------------------------------------------- chạy

/** Chạy task Queued/Backlog với đúng loại run (dùng chung cho pump() và "chạy ngay"). */
function launch(t: Task) {
  // PLAN 2.5: "Yêu cầu sửa" lúc hết slot → chạy tiếp phiên cũ với feedback đã lưu, không phải retry.
  // Tiếp tục (resumeTask hết slot, hoặc tự đưa lại hàng đợi do giới hạn sử dụng) → 'continue' trên phiên cũ.
  // Task Queued đã từng chạy còn lại = được Retry (retryTask đã đưa worktree về mainBranch và xoá sessionId)
  // → run kind 'retry', startRun tạo session mới.
  const kind = nextRunKind(t, runs.byTask(t.id).length > 0)
  startRun(t, kind, kind === 'resume' ? t.pendingFeedback : undefined)
}

/** Hàm pump() dùng để chạy task; test thay bằng hàm giả để không spawn Claude thật. */
let launcher: (t: Task) => void = launch

/** Chỉ dùng trong test. Không truyền: khôi phục hàm thật. */
export function setLauncherForTest(fn?: (t: Task) => void) {
  launcher = fn ?? launch
}

/**
 * Kéo task từ Backlog/Queued sang Running: chạy ngay nếu còn slot (bỏ qua thứ tự hàng đợi và giờ chờ do
 * giới hạn sử dụng). Hết slot thì đưa vào hàng đợi để chạy khi tới lượt. Trả về true nếu đã bắt đầu chạy.
 */
export function runNow(taskId: number): boolean {
  const t = tasks.get(taskId)
  if (!t || (t.status !== 'backlog' && t.status !== 'queued')) return false
  const p = projects.get(t.projectId)
  if (p && hasSlot(p)) {
    launcher(t) // = launch, trừ khi test thay bằng hàm giả
    return true
  }
  updateTask(t.id, { status: 'queued', notBefore: null, rateLimitRetries: 0 })
  pump()
  return false
}

export function startRun(task: Task, kind: RunKind, feedback?: string) {
  const project = projects.get(task.projectId)!
  const bin = findClaudeBin()
  if (!bin) {
    updateTask(task.id, { status: 'failed', failReason: 'Không tìm thấy Claude Code CLI. Đặt biến môi trường CLAUDE_BIN.' })
    return
  }

  // Claude sắp sửa code trong worktree: kết quả test đang chạy (nếu có) không còn ý nghĩa.
  void stopTests(task.id, 'Đã dừng vì Claude bắt đầu chạy lại trong worktree.')
  const prevRun = runs.byTask(task.id).at(-1)
  const cfg = settings.get()
  // P5-03 (D2/D3): chọn model lúc run bắt đầu; resume/continue giữ model của run trước.
  // P5-07 (D5): khi 'auto', Lớp 2 hiệu chỉnh gợi ý theo lịch sử project (tối đa một bậc).
  const base = chooseRunModel(kind, prevRun, task, project, cfg, (s) => adjustByHistory(s, task))
  // P5-06 (D6): Retry sau run lỗi / Request changes lần 2+ → lên một bậc.
  const plan = applyEscalation(base, {
    kind,
    prevRun,
    requestChangesCount: kind === 'resume' ? runs.requestChangesCount(task.id) : 0,
    autoEscalate: cfg.autoEscalate,
    maxTier: maxTierForProject(project.id),
  })
  const choice = plan.choice
  // Ngữ cảnh lớn: phiên mới (không --resume) kèm tóm tắt, vì đổi model thì cache phiên cũ không dùng được.
  const { resume, sessionId } = plan.freshSession ? sessionFor('retry', undefined) : sessionFor(kind, task.sessionId)
  const prompt = plan.freshSession
    ? escalationPrompt({
        taskPrompt: task.prompt,
        lastSummary: prevRun?.summary,
        prevModel: prevRun?.requestedModel ?? prevRun?.model,
        feedback,
        branch: task.branch,
        mainBranch: project.mainBranch,
      })
    : undefined
  const run = runs.create({
    id: randomUUID(),
    taskId: task.id,
    kind,
    feedback,
    sessionId,
    startedAt: Date.now(),
    requestedModel: choice.requestedModel,
    modelSource: choice.modelSource,
    modelReason: choice.modelReason,
  })
  broadcast({ type: 'run', run })
  // P5-04: ghi lý do tự chọn model vào log của run.
  if (!plan.escalated && base.suggestion) addEvent(run.id, { type: 'system', text: autoModelNote(base.suggestion) })
  for (const text of plan.notes) addEvent(run.id, { type: 'system', text })
  // Chuyển Running ngay (đồng bộ) để pump() tính đúng slot trong lúc đang tạo worktree.
  updateTask(task.id, {
    status: 'running',
    startedAt: run.startedAt,
    sessionId,
    failReason: null,
    reviewWarning: null,
    pendingFeedback: null, // feedback (nếu có) đã nằm trên run vừa tạo
    resumeNext: null,
    notBefore: null,
  })
  preparing.set(task.id, run.id)

  // PLAN 2.1: Claude luôn làm việc trong worktree riêng (nhánh claude/task-<id>), không đụng repo chính.
  ensureWorktree(task, project).then(
    (wt) => {
      if (preparing.get(task.id) !== run.id) return // đã bị dừng trong lúc tạo worktree
      preparing.delete(task.id)
      if (wt.created) updateTask(task.id, { branch: wt.branch, worktreePath: wt.path })
      spawnClaude({
        task,
        project,
        bin: bin.path,
        runId: run.id,
        kind,
        feedback,
        sessionId,
        resume: !!resume,
        cwd: wt.path,
        model: choice.requestedModel,
        prompt,
      })
    },
    (err) => {
      if (preparing.get(task.id) !== run.id) return
      preparing.delete(task.id)
      finish(task.id, run.id, { exitCode: -1, error: `Không tạo được worktree cho task: ${(err as Error).message}` })
    },
  )
}

/**
 * Prompt gửi cho Claude. Resume đúng phiên: chỉ gửi feedback / lời nhắc tiếp tục (Claude đã nhớ ngữ cảnh).
 * Run 'resume'/'continue' nhưng task mất session id (không resume được): phiên mới nên gửi kèm prompt gốc.
 */
export function resumePrompt(o: { kind: RunKind; resume: boolean; feedback?: string; taskPrompt: string }) {
  if (o.kind === 'continue') return o.resume ? CONTINUE_PROMPT : `${o.taskPrompt}\n\n${CONTINUE_NOTE}`
  if (o.kind !== 'resume') return o.taskPrompt
  if (o.resume) return o.feedback ?? ''
  return o.feedback ? `${o.taskPrompt}\n\nYêu cầu sửa sau khi review:\n${o.feedback}` : o.taskPrompt
}

function spawnClaude(o: {
  task: Task
  project: Project
  bin: string
  runId: string
  kind: RunKind
  feedback?: string
  sessionId: string
  resume: boolean
  cwd: string
  model?: string
  /** P5-06: prompt dựng sẵn (phiên mới khi nâng model), thay cho resumePrompt. */
  prompt?: string
}) {
  const { task, project, kind, feedback, sessionId, resume, cwd } = o
  const run = { id: o.runId }

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
    resume,
    permissionMode: task.permissionMode,
    allowedTools: project.allowedTools,
    mcpConfigPath: mcpConfig,
    settingsPath: hookSettings,
    model: o.model,
    fallbackModel: fallbackModelFor(o.model),
    maxBudgetUsd: task.maxCostUsd,
    appendSystemPrompt: BLOCKED_BY_INSTRUCTION,
  })

  const prompt = o.prompt ?? resumePrompt({ kind, resume, feedback, taskPrompt: task.prompt })
  let child: ChildProcess
  try {
    child = spawn(o.bin, args, { cwd, env: claudeEnv({ TASKBOARD_TASK_ID: String(task.id) }), windowsHide: true })
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
  let rateLimitEvent: RateLimitEvent | undefined
  let stderr = ''

  readline.createInterface({ input: child.stdout! }).on('line', (line) => {
    raw.write(line + '\n')
    const parsed = parser.parseLine(line)
    for (const e of parsed.events) addEvent(run.id, e)
    if (parsed.result) result = parsed.result
    if (parsed.rateLimit) rateLimitEvent = parsed.rateLimit
    // P5-01: lưu model ngay khi CLI báo (event init) để giao diện thấy trong lúc task đang chạy.
    if (parsed.model) {
      const updated = runs.setModel(run.id, parsed.model)
      if (updated) broadcast({ type: 'run', run: updated })
    }
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
    finish(task.id, run.id, { exitCode: code ?? -1, result, stderr, rateLimitEvent, resumed: resume })
  })
}

function finish(
  taskId: number,
  runId: string,
  o: { exitCode: number; result?: ResultInfo; stderr?: string; error?: string; rateLimitEvent?: RateLimitEvent; resumed?: boolean },
) {
  const { exitCode, result, stderr, error, rateLimitEvent, resumed } = o
  const run = runs.finish(runId, {
    endedAt: Date.now(),
    exitCode,
    numTurns: result?.numTurns,
    costUsd: result?.costUsd,
    summary: result?.text ?? error,
    modelUsage: result?.modelUsage,
    contextTokens: result?.contextTokens,
  })
  broadcast({ type: 'run', run })
  // P6: chi phí run vừa cộng vào budget tháng → tính lại, cảnh báo (B2), chặn hàng đợi nếu cần (B3, pump() bên dưới).
  refreshBudgets()

  const ok = exitCode === 0 && result && !result.isError
  if (ok) {
    // Chạy được trọn vẹn: bộ đếm tự thử lại do giới hạn sử dụng về 0 (broadcast cùng lần đổi trạng thái sau).
    if (tasks.get(taskId)?.rateLimitRetries) tasks.patch(taskId, { rateLimitRetries: 0 })
    // FR-08 nguồn ④ (R6): Claude báo bị chặn bởi task khác → thêm phụ thuộc, đưa về hàng đợi thay vì Review.
    const current = tasks.get(taskId)
    const blocked = current && decideBlocked(current, result?.text)
    if (blocked) {
      void handleBlocked(taskId, runId, blocked).finally(pump)
      return
    }
    // PLAN 2.2: task vẫn Running (giữ slot) trong lúc commit; xong mới chuyển Review/Done rồi pump().
    void completeRun(taskId, runId).finally(pump)
    return
  }
  // Resume/Tiếp tục nhưng CLI không còn phiên cũ (ví dụ run trước gặp giới hạn sử dụng trước khi phiên kịp lưu):
  // chạy lại cùng loại run trên phiên mới kèm prompt gốc. Run mới không resume nên không lặp vô hạn.
  if (!error && resumed && isMissingSession({ result, stderr })) {
    const task = tasks.get(taskId)
    const prev = runs.get(runId)
    if (task?.status === 'running' && prev) {
      setFailKind(runId, 'infra') // không phải lỗi của model: run kế tiếp không tự nâng (D6)
      addEvent(runId, { type: 'system', text: 'Không tìm thấy phiên Claude cũ để chạy tiếp. Chạy tiếp trên phiên mới kèm yêu cầu gốc.' })
      startRun({ ...task, sessionId: undefined }, prev.kind, prev.feedback)
      return
    }
  }
  // Rủi ro chung (PLAN): lỗi giới hạn sử dụng → tự đưa lại hàng đợi, chạy tiếp sau giờ reset (tối đa N lần).
  if (!error && handleRateLimit(taskId, runId, detectRateLimit({ result, stderr, rateLimitEvent }), !result)) {
    setFailKind(runId, 'rate_limit')
    pump()
    return
  }
  // P5-06: lỗi trước khi Claude chạy (worktree, MCP config, hook, spawn) là lỗi hạ tầng; còn lại là Claude làm hỏng.
  setFailKind(runId, failKindOf({ error }))
  let reason = error ?? ''
  if (!reason && result?.isError) reason = `Claude kết thúc với lỗi: ${result.text}`
  if (!reason) {
    const tail = (stderr ?? '').trim().split('\n').slice(-3).join(' ').trim()
    reason = `Claude CLI thoát với mã ${exitCode}${tail ? `: ${tail}` : ''}`
  }
  if (!result) addEvent(runId, { type: 'result', isError: true, text: reason })
  updateTask(taskId, { status: 'failed', failReason: reason.slice(0, 1000) })
  pump()
}

/** Loại thất bại của run lỗi không do Stop / giới hạn sử dụng: có `error` (lỗi dựng môi trường trước khi Claude chạy) → 'infra'. */
export const failKindOf = (o: { error?: string }): RunFailKind => (o.error ? 'infra' : 'claude')

function setFailKind(runId: string, kind: RunFailKind) {
  const r = runs.setFailKind(runId, kind)
  if (r) broadcast({ type: 'run', run: r })
}

/** CLI báo không tìm thấy phiên khi chạy `--resume <sessionId>` (file phiên đã mất hoặc chưa từng được lưu). */
export function isMissingSession(o: { result?: Pick<ResultInfo, 'text' | 'isError'>; stderr?: string }) {
  const re = /no conversation found/i
  return re.test(o.stderr ?? '') || (!!o.result?.isError && re.test(o.result.text ?? ''))
}

/**
 * Trạng thái task khi tự đưa lại hàng đợi do giới hạn sử dụng: run 'resume' (Yêu cầu sửa) giữ feedback để resume
 * tiếp; các run khác chạy tiếp phiên cũ ('continue') trên worktree đang dở thay vì làm lại từ đầu.
 */
export function requeueIntent(run: Pick<Run, 'kind' | 'feedback'> | undefined) {
  const feedback = run?.kind === 'resume' && run.feedback ? run.feedback : null
  return { pendingFeedback: feedback, resumeNext: !feedback }
}

const hhmm = (ts: number) => new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })

/**
 * Xử lý run thất bại do giới hạn sử dụng. Trả về true nếu đã xử lý (task về Queued hoặc Failed).
 * Run 'resume' (Yêu cầu sửa) được giữ nguyên ý định: feedback quay lại pendingFeedback để lần sau resume tiếp phiên.
 */
function handleRateLimit(taskId: number, runId: string, hit: ReturnType<typeof detectRateLimit>, noResult: boolean) {
  const task = tasks.get(taskId)
  if (!hit || !task) return false
  const decision = decideRateLimit(hit, task.rateLimitRetries ?? 0)
  if (decision.action === 'fail') {
    addEvent(runId, { type: 'system', text: decision.failReason })
    updateTask(taskId, { status: 'failed', failReason: decision.failReason, notBefore: null, rateLimitRetries: 0 })
    return true
  }
  const run = runs.get(runId)
  const text =
    `Gặp giới hạn sử dụng của gói Claude. Task tự quay lại hàng đợi, chạy tiếp lúc ${hhmm(decision.notBefore)}` +
    ` (lần ${decision.attempt}/${MAX_RATE_LIMIT_RETRIES}). Bấm "Tiếp tục ngay" để không chờ.`
  if (noResult) addEvent(runId, { type: 'result', isError: true, text })
  else addEvent(runId, { type: 'system', text })
  updateTask(taskId, {
    status: 'queued',
    notBefore: decision.notBefore,
    rateLimitRetries: decision.attempt,
    failReason: null,
    ...requeueIntent(run),
  })
  return true
}

/**
 * Run kết thúc bằng BLOCKED_BY (R6). Task vẫn Running (giữ slot) trong lúc dọn worktree:
 * - requeue: đưa worktree về nhánh chính như Retry (bỏ thay đổi dở), lưu phụ thuộc, task về Queued với session mới.
 *   Lần chạy sau là 'retry' trên code đã có phần việc của task được chờ.
 * - fail: task Failed kèm lý do, giữ worktree để người dùng xem / Chạy lại.
 */
export async function handleBlocked(taskId: number, runId: string, d: NonNullable<ReturnType<typeof decideBlocked>>) {
  const task = tasks.get(taskId)
  const project = task && projects.get(task.projectId)
  if (!task || !project || task.status !== 'running') return
  if (d.action === 'fail') {
    addEvent(runId, { type: 'system', text: d.reason })
    updateTask(taskId, { status: 'failed', failReason: d.reason.slice(0, 1000) })
    return
  }
  try {
    await withLock(project.id, async () => {
      const patch = await prepareRetry(task, project)
      if (tasks.get(taskId)?.status !== 'running') return // người dùng đã dừng/xoá trong lúc dọn
      taskDeps.set(taskId, d.deps)
      addEvent(runId, { type: 'system', text: d.note })
      updateTask(taskId, {
        ...patch,
        status: 'queued',
        failReason: null,
        reviewWarning: null,
        pendingFeedback: null,
        resumeNext: null,
        notBefore: null,
        rateLimitRetries: 0,
      })
    })
  } catch (err) {
    const reason = `Claude báo bị chặn bởi task khác nhưng không đưa được worktree về nhánh "${project.mainBranch}": ${(err as Error).message}`
    setFailKind(runId, 'infra')
    addEvent(runId, { type: 'result', isError: true, text: reason })
    updateTask(taskId, { status: 'failed', failReason: reason.slice(0, 1000) })
  }
}

/**
 * Run thành công: commit thay đổi trong worktree rồi chuyển task sang Review để người dùng duyệt output,
 * dù có thay đổi code hay không (G3). Approve → Done (có commit thì merge), Request changes → Claude chạy tiếp.
 */
async function completeRun(taskId: number, runId: string) {
  const task = tasks.get(taskId)
  const project = task && projects.get(task.projectId)
  if (!task || !project) return
  if (!task.worktreePath) {
    updateTask(taskId, { status: 'failed', failReason: 'Task không có worktree để ghi nhận thay đổi' })
    return
  }
  let failReason: string | undefined
  try {
    const n = runNumber(runs.byTask(taskId), runId)
    await captureChanges({ id: task.id, title: task.title, worktreePath: task.worktreePath }, project, n)
  } catch (err) {
    failReason = `Không ghi nhận được thay đổi của Claude: ${(err as Error).message}`
  }
  // Người dùng có thể đã dừng/xoá task trong lúc đang commit: không ghi đè trạng thái.
  if (tasks.get(taskId)?.status !== 'running') return
  if (failReason) {
    setFailKind(runId, 'infra') // Claude đã chạy xong, chỉ lỗi commit
    addEvent(runId, { type: 'result', isError: true, text: failReason })
    updateTask(taskId, { status: 'failed', failReason: failReason.slice(0, 1000) })
  } else updateTask(taskId, { status: 'review' })
}

// ---------------------------------------------------------------- dừng & phục hồi

export async function stopTask(taskId: number) {
  const proc = procs.get(taskId)
  if (proc) {
    proc.stopping = true
    if (proc.child.pid) await killTree(proc.child.pid)
    procs.delete(taskId)
    addEvent(proc.runId, { type: 'result', isError: true, text: 'Đã dừng bởi người dùng.' })
    runs.finish(proc.runId, { endedAt: Date.now(), exitCode: 130 })
    setFailKind(proc.runId, 'stopped')
  }
  const prepRun = preparing.get(taskId)
  if (prepRun) {
    // Dừng khi đang tạo worktree: startRun sẽ không spawn Claude nữa.
    preparing.delete(taskId)
    addEvent(prepRun, { type: 'result', isError: true, text: 'Đã dừng bởi người dùng.' })
    runs.finish(prepRun, { endedAt: Date.now(), exitCode: 130 })
    setFailKind(prepRun, 'stopped')
  }
  // Tạm dừng: giữ worktree + session để có thể Tiếp tục (resumeTask) hoặc Chạy lại từ đầu (retryTask).
  updateTask(taskId, { status: 'failed', failReason: STOP_REASON })
  pump()
}

export const isRunning = (taskId: number) => procs.has(taskId) || preparing.has(taskId)

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

/**
 * NFR-05: task đang chạy khi server tắt sẽ chuyển sang Failed.
 * Cố ý KHÔNG xoá worktree/nhánh của task: giữ lại để người dùng xem hoặc bấm Retry (route /retry tự reset worktree).
 */
export function recover() {
  // File cấu hình tạm của các run dở dang
  cleanupMcpConfigs(RUN_LOG_DIR)
  cleanupHookSettings(RUN_LOG_DIR)
  for (const r of runs.open()) {
    runs.finish(r.id, { endedAt: Date.now(), exitCode: -1 })
    runs.setFailKind(r.id, 'infra') // server tắt giữa chừng, không phải lỗi của model
    events.add(r.id, { type: 'result', isError: true, text: 'Server đã khởi động lại trong khi task đang chạy.' })
  }
  for (const t of tasks.byStatus(...ACTIVE))
    tasks.patch(t.id, {
      status: 'failed',
      failReason: 'Server đã khởi động lại trong khi task đang chạy. Bấm Tiếp tục để chạy tiếp phiên cũ hoặc Chạy lại để làm lại từ đầu.',
    })
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
