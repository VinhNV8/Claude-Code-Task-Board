// Hàng đợi và thực thi task bằng agent CLI (headless). Phần riêng của từng agent nằm trong agents/ (SPEC-MULTI-AGENT).
import { spawn, type ChildProcess } from 'node:child_process'
import { killTree } from './proc.ts'
import { shutdownTests, stopTests } from './testRunner.ts'
import { createWriteStream, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import readline from 'node:readline'
import { revokeKeyToken } from './apiKeyBroker.ts'
import { DATA_DIR, events, projects, runs, settings, taskDeps, tasks, testRuns } from './db.ts'
import { broadcast } from './bus.ts'
import type { Parsed, ResultInfo } from './stream.ts'
import { awaitPermission, awaitQuestion } from './permissionBroker.ts'
import { cleanupMcpConfigs } from './permissionTool.ts'
import { cleanupHookSettings, formatNotification } from './hookSettings.ts'
import { captureChanges, ensureWorktree, runNumber } from './capture.ts'
import { taskDiff } from './git.ts'
import { MAX_RATE_LIMIT_RETRIES, decideRateLimit, orderQueue, type RateLimitEvent, type RateLimitHit } from './rateLimit.ts'
import { CONTINUE_NOTE, CONTINUE_PROMPT, STOP_REASON } from '../../web/src/lib/resume.ts'
import { autoModelNote, chooseRunModel } from './model.ts'
import { applyEscalation, escalationPrompt, maxTierForProject } from './escalation.ts'
import { adjustByHistory } from './modelHistoryService.ts'
// Nạp budgetService cũng đăng ký nguồn budget cho maxTierForProject (B4) và blockedReason cho task gửi ra web.
import { budgetWakeAt, isProjectBlocked, refreshBudgets } from './budgetService.ts'
import { decideBlocked, pendingDeps } from './taskDeps.ts'
import { prepareRetry } from './retry.ts'
import { withLock } from './review.ts'
import { agentProblem, chooseFallback, getAdapter, type AgentAdapter } from './agents/index.ts'
import { agentLimitedUntil } from './agents/limits.ts'
import { AGENT_NAMES, agentForRun, resolveAgent } from '../../web/src/lib/agent.ts'
import type { Project, Run, RunFailKind, RunKind, Task, TaskStatus } from './types.ts'
import { withScope } from '../../web/src/lib/writeScope.ts'
import { executePrompt, phaseForRun, phasePrompt, runPermissionMode } from '../../web/src/lib/planMode.ts'

export { isMissingSession } from './agents/claude.ts'

interface Proc {
  child: ChildProcess
  runId: string
  stopping: boolean
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
/** Mode direct: mọi task cùng sửa một thư mục nên mỗi lúc chỉ chạy một task để output không giẫm lên nhau. */
export const projectParallel = (project: Pick<Project, 'maxParallel'> & { deliveryMode?: Project['deliveryMode'] }) =>
  project.deliveryMode === 'direct' ? 1 : project.maxParallel

export function hasSlot(project: Pick<Project, 'id' | 'maxParallel'> & { deliveryMode?: Project['deliveryMode'] }) {
  return activeCount() < settings.get().maxParallel && activeCount(project.id) < projectParallel(project) && !isProjectBlocked(project.id)
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
        if (activeCount(p.id) >= projectParallel(p)) continue
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
  // FR-91: agent theo 3 tầng Task → Project → Settings. Kiểm tra lại lúc chạy vì project/settings có thể đã đổi
  // sau khi tạo task (ví dụ đổi agent mặc định sang agent không hỗ trợ mức quyền của task).
  // FR-99 (QA7): Request changes / Tiếp tục giữ agent dự phòng đang dùng; lần chạy mới / Retry quay về agent gốc.
  const configured = resolveAgent(task, project, settings.get())
  let agentId = agentForRun(task, project, settings.get(), kind)
  const failoverNotes: string[] = []
  // Ngắt mạch: agent đang hết hạn mức → đi thẳng sang agent dự phòng (nếu project bật failover và có agent phù hợp).
  const limitedUntil = agentLimitedUntil(agentId)
  if (limitedUntil !== undefined) {
    const fb = chooseFallback({ current: agentId, task, project })
    if (fb) {
      failoverNotes.push(`${AGENT_NAMES[agentId]} đang hết hạn mức đến ${hhmm(limitedUntil)}: chạy bằng ${AGENT_NAMES[fb]} (agent dự phòng).`)
      broadcast({ type: 'agent_failover', taskId: task.id, from: agentId, to: fb, until: limitedUntil })
      agentId = fb
    }
  }
  // SPEC-PLAN-HANDOFF FR-101: lượt Kế hoạch luôn chạy mode plan, bất kể mức quyền của task. Task gửi cho agent
  // (và broker duyệt quyền) mang mức quyền thực tế của lượt chạy này.
  const phase = phaseForRun(task, kind)
  const runTask: Task = { ...task, permissionMode: runPermissionMode(task.permissionMode, phase) }
  const problem = agentProblem(agentId, runTask.permissionMode)
  const adapter = getAdapter(agentId)
  if (problem || !adapter) {
    updateTask(task.id, { status: 'failed', failReason: problem ?? `Task Board chưa hỗ trợ agent "${agentId}".` })
    return
  }
  const bin = adapter.findBin()
  if (!bin) {
    updateTask(task.id, { status: 'failed', failReason: adapter.missingBinReason })
    return
  }

  // Claude sắp sửa code trong worktree: kết quả test đang chạy (nếu có) không còn ý nghĩa.
  void stopTests(task.id, 'Đã dừng vì Claude bắt đầu chạy lại trong worktree.')
  const prevRun = runs.byTask(task.id).at(-1)
  const cfg = settings.get()
  // P5-03 (D2/D3): chọn model lúc run bắt đầu; resume/continue giữ model của run trước.
  // P5-07 (D5): khi 'auto', Lớp 2 hiệu chỉnh gợi ý theo lịch sử project (tối đa một bậc).
  // Bộ chọn / nâng bậc model (Haiku → Sonnet → Opus) chỉ dành cho Claude. Agent khác: model mặc định của agent
  // (adapter chọn từ danh sách model của tài khoản); resume/continue giữ model của run trước.
  const isClaude = adapter.id === 'claude'
  const base = isClaude
    ? chooseRunModel(kind, prevRun, task, project, cfg, (s) => adjustByHistory(s, task))
    : {
        requestedModel: (kind === 'resume' || kind === 'continue') && prevRun?.agent === agentId ? prevRun.requestedModel || undefined : undefined,
        modelSource: 'default' as const,
        modelReason: `Model mặc định của ${adapter.name}`,
        suggestion: undefined,
      }
  // P5-06 (D6): Retry sau run lỗi / Request changes lần 2+ → lên một bậc.
  const plan = isClaude
    ? applyEscalation(base, {
        kind,
        prevRun,
        requestChangesCount: kind === 'resume' ? runs.requestChangesCount(task.id) : 0,
        autoEscalate: cfg.autoEscalate,
        maxTier: maxTierForProject(project.id),
      })
    : { choice: base, escalated: false, freshSession: false, notes: [] as string[] }
  const choice = plan.choice
  // Ngữ cảnh lớn: phiên mới (không --resume) kèm tóm tắt, vì đổi model thì cache phiên cũ không dùng được.
  // FR-97: run trước chạy bằng agent khác → không resume chéo, mở phiên mới (prompt gốc + feedback / lời nhắc tiếp tục).
  const switchedAgent = !!prevRun && (prevRun.agent ?? 'claude') !== agentId
  if (switchedAgent) plan.notes.push(`Lần chạy trước dùng ${prevRun!.agent ?? 'claude'}, lần này dùng ${agentId}: mở phiên mới, không chạy tiếp phiên cũ.`)
  const { resume, sessionId } = plan.freshSession || switchedAgent ? sessionFor('retry', undefined) : sessionFor(kind, task.sessionId)
  // SPEC-PLAN-HANDOFF: prompt theo giai đoạn của task có lập kế hoạch.
  // - Lượt Thực hiện đầu tiên (ngay sau khi duyệt): gửi kế hoạch đã duyệt (resume: chỉ kế hoạch; phiên mới: kèm prompt gốc).
  // - initial / retry: kèm chỉ dẫn lập kế hoạch, hoặc kèm kế hoạch đã duyệt (Chạy lại lượt Thực hiện).
  // - resume / continue trên phiên MỚI (đổi agent, mất phiên): prompt gốc theo giai đoạn để không mất chỉ dẫn / kế hoạch (AC-47).
  const scoped = withScope(task.prompt, task.writeScope)
  const phaseBase = phasePrompt(phase, scoped, task.approvedPlan)
  const phased =
    phase === 'execute' && prevRun?.phase === 'plan' && task.approvedPlan
      ? executePrompt({ approvedPlan: task.approvedPlan, resume: !!resume, taskPrompt: scoped })
      : !phaseBase
        ? undefined
        : kind === 'initial' || kind === 'retry'
          ? phaseBase
          : !resume
            ? resumePrompt({ kind, resume: false, feedback, taskPrompt: phaseBase })
            : undefined
  const prompt = plan.freshSession
    ? escalationPrompt({
        taskPrompt: phased ?? scoped,
        lastSummary: prevRun?.summary,
        prevModel: prevRun?.requestedModel ?? prevRun?.model,
        feedback,
        branch: task.branch,
        mainBranch: project.mainBranch,
      })
    : phased
  const run = runs.create({
    id: randomUUID(),
    taskId: task.id,
    kind,
    feedback,
    sessionId,
    startedAt: Date.now(),
    agent: agentId,
    requestedModel: choice.requestedModel,
    modelSource: choice.modelSource,
    modelReason: choice.modelReason,
    phase,
  })
  broadcast({ type: 'run', run })
  if (phase === 'plan') addEvent(run.id, { type: 'system', text: 'Giai đoạn Kế hoạch: agent chỉ đọc và phân tích (mode plan), kết quả là kế hoạch chờ bạn duyệt.' })
  if (phase === 'execute' && kind !== 'resume' && kind !== 'continue')
    addEvent(run.id, { type: 'system', text: 'Giai đoạn Thực hiện: chạy theo kế hoạch đã duyệt.' })
  // P5-04: ghi lý do tự chọn model vào log của run.
  if (!plan.escalated && base.suggestion) addEvent(run.id, { type: 'system', text: autoModelNote(base.suggestion) })
  for (const text of [...failoverNotes, ...plan.notes]) addEvent(run.id, { type: 'system', text })
  // Chuyển Running ngay (đồng bộ) để pump() tính đúng slot trong lúc đang tạo worktree.
  updateTask(task.id, {
    status: 'running',
    startedAt: run.startedAt,
    sessionId,
    // FR-99: đang chạy bằng agent khác agent cấu hình = agent dự phòng; chạy đúng agent cấu hình thì bỏ.
    activeAgent: agentId !== configured ? agentId : null,
    failReason: null,
    reviewWarning: null,
    pendingFeedback: null, // feedback (nếu có) đã nằm trên run vừa tạo
    resumeNext: null,
    notBefore: null,
    planPhase: phase ?? null,
  })
  preparing.set(task.id, run.id)

  // Mode worktree (PLAN 2.1): Claude làm trong worktree riêng (nhánh claude/task-<id>), không đụng repo chính.
  // Mode direct: Claude làm thẳng trong thư mục project, output nằm ngay chỗ người dùng cấu hình.
  ensureWorktree(task, project).then(
    (wt) => {
      if (preparing.get(task.id) !== run.id) return // đã bị dừng trong lúc tạo worktree
      preparing.delete(task.id)
      if (wt.created) updateTask(task.id, { branch: wt.branch, worktreePath: wt.path, baseRef: wt.baseRef ?? null })
      spawnAgent(adapter, {
        task: runTask,
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
      finish(adapter, task.id, run.id, { exitCode: -1, error: `Không chuẩn bị được thư mục làm việc cho task: ${(err as Error).message}` })
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

function spawnAgent(
  adapter: AgentAdapter,
  o: {
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
  },
) {
  const { task, kind, feedback, resume, cwd } = o
  const run = { id: o.runId }

  // FR-49: phạm vi ghi gắn vào prompt gốc; resume đúng phiên thì agent đã có ràng buộc trong ngữ cảnh.
  const prompt = o.prompt ?? resumePrompt({ kind, resume, feedback, taskPrompt: withScope(task.prompt, task.writeScope) })
  // Adapter dựng tham số, môi trường, file cấu hình tạm (xác thực, budget, MCP xin quyền, hooks…).
  const prepared = adapter.prepare({ ...o, prompt, runLogDir: RUN_LOG_DIR })
  if (!prepared.ok) {
    finish(adapter, task.id, run.id, { exitCode: -1, error: prepared.error })
    return
  }
  let child: ChildProcess
  try {
    child = spawn(o.bin, prepared.args, { cwd, env: prepared.env, windowsHide: true })
  } catch (err) {
    prepared.cleanup()
    finish(adapter, task.id, run.id, { exitCode: -1, error: `Không chạy được ${agentName(adapter)} CLI: ${(err as Error).message}` })
    return
  }
  const proc: Proc = { child, runId: run.id, stopping: false }
  procs.set(task.id, proc)

  const raw = createWriteStream(join(RUN_LOG_DIR, `${run.id}.jsonl`))
  let result: ResultInfo | undefined
  let rateLimitEvent: RateLimitEvent | undefined
  let stderr = ''
  /** Driver báo lượt chạy đã xong: mã thoát dùng thay mã thật (tiến trình bị dừng chủ động). */
  let driverExit: number | undefined

  const handle = (parsed: Parsed) => {
    for (const e of parsed.events) addEvent(run.id, e)
    if (parsed.result) result = parsed.result
    if (parsed.rateLimit) rateLimitEvent = parsed.rateLimit
    // P5-01: lưu model ngay khi CLI báo (event init) để giao diện thấy trong lúc task đang chạy.
    if (parsed.model) {
      const updated = runs.setModel(run.id, parsed.model)
      if (updated) broadcast({ type: 'run', run: updated })
    }
    // Agent tự sinh id phiên (Codex thread id): lưu để lần sau resume đúng phiên.
    if (adapter.createDriver && parsed.sessionId && parsed.sessionId !== o.sessionId) {
      const updated = runs.setSessionId(run.id, parsed.sessionId)
      if (updated) broadcast({ type: 'run', run: updated })
      if (procs.get(task.id) === proc) updateTask(task.id, { sessionId: parsed.sessionId })
    }
  }

  let onLine: (line: string) => void
  if (adapter.createDriver) {
    // Giao tiếp hai chiều: driver tự ghi stdin; xong lượt thì đóng stdin và dừng tiến trình.
    const driver = adapter.createDriver({
      input: { ...o, prompt, runLogDir: RUN_LOG_DIR },
      send: (msg) => {
        const line = JSON.stringify(msg)
        raw.write(`${line}\n`)
        if (child.stdin?.writable) child.stdin.write(`${line}\n`)
      },
      emit: handle,
      requestPermission: (r) => awaitPermission({ ...r, taskId: task.id }, { mode: task.permissionMode, cwd, writeScope: task.writeScope }),
      askUser: (questions) => awaitQuestion(task.id, questions),
      done: ({ exitCode }) => {
        if (driverExit !== undefined) return
        driverExit = exitCode
        child.stdin?.end()
        // Cho tiến trình tự thoát sau khi đóng stdin; còn treo thì dừng hẳn.
        const t = setTimeout(() => {
          if (child.exitCode === null && child.pid) void killTree(child.pid)
        }, 3000)
        t.unref?.()
      },
    })
    onLine = (line) => driver.onLine(line)
    driver.start()
  } else {
    if (prepared.stdin !== undefined) child.stdin?.end(prepared.stdin)
    else child.stdin?.end()
    const parser = adapter.createParser(cwd)
    onLine = (line) => handle(parser.parseLine(line))
  }

  readline.createInterface({ input: child.stdout! }).on('line', (line) => {
    raw.write(line + '\n')
    onLine(line)
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
    prepared.cleanup()
    // stopTask có thể đã xoá entry, và task có thể đã sang run mới: chỉ xoá nếu vẫn là run này.
    if (procs.get(task.id) === proc) procs.delete(task.id)
    if (proc.stopping) return // stopTask đã xử lý
    finish(adapter, task.id, run.id, { exitCode: driverExit ?? code ?? -1, result, stderr, rateLimitEvent, resumed: resume })
  })
}

function finish(
  adapter: AgentAdapter,
  taskId: number,
  runId: string,
  o: { exitCode: number; result?: ResultInfo; stderr?: string; error?: string; rateLimitEvent?: RateLimitEvent; resumed?: boolean },
) {
  const { exitCode, result, stderr, error, rateLimitEvent, resumed } = o
  revokeKeyToken(taskId) // run đã kết thúc: token lấy API key hết hiệu lực
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
    // Agent đã chạy được: gói có lượt lại, bỏ banner hết lượt.
    adapter.onSuccess()
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
  const outcome = { result, stderr, rateLimitEvent }
  const name = agentName(adapter)
  if (!error && resumed && adapter.isMissingSession(outcome)) {
    const task = tasks.get(taskId)
    const prev = runs.get(runId)
    if (task?.status === 'running' && prev) {
      setFailKind(runId, 'infra') // không phải lỗi của model: run kế tiếp không tự nâng (D6)
      addEvent(runId, { type: 'system', text: `Không tìm thấy phiên ${name} cũ để chạy tiếp. Chạy tiếp trên phiên mới kèm yêu cầu gốc.` })
      startRun({ ...task, sessionId: undefined }, prev.kind, prev.feedback)
      return
    }
  }
  // Rủi ro chung (PLAN): lỗi giới hạn sử dụng → tự đưa lại hàng đợi, chạy tiếp sau giờ reset (tối đa N lần).
  const limitHit = error ? undefined : adapter.detectRateLimit(outcome)
  // Banner "gói hết lượt" trên mọi trang của web
  if (limitHit) adapter.onRateLimit(limitHit, outcome)
  // FR-99: project bật failover và có agent dự phòng phù hợp → chuyển agent, chạy tiếp ngay thay vì chờ giờ reset.
  if (limitHit && failover(adapter, taskId, runId, limitHit, !result)) {
    setFailKind(runId, 'rate_limit')
    pump()
    return
  }
  if (limitHit && handleRateLimit(taskId, runId, limitHit, !result, name)) {
    setFailKind(runId, 'rate_limit')
    pump()
    return
  }
  // P5-06: lỗi trước khi agent chạy (worktree, MCP config, hook, spawn) là lỗi hạ tầng; còn lại là agent làm hỏng.
  setFailKind(runId, failKindOf({ error }))
  let reason = error ?? ''
  if (!reason && result?.isError) reason = `${name} kết thúc với lỗi: ${result.text}`
  if (!reason) {
    const tail = (stderr ?? '').trim().split('\n').slice(-3).join(' ').trim()
    reason = `${name} CLI thoát với mã ${exitCode}${tail ? `: ${tail}` : ''}`
  }
  // Ví dụ chế độ API key: thêm gợi ý cho lỗi key sai / hết credit.
  const hint = error ? undefined : adapter.failureHint(outcome)
  if (hint) reason = `${hint} (${reason})`
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

/** Tên agent trong thông báo cho người dùng ("Claude", "Codex"...). */
const agentName = (a: Pick<AgentAdapter, 'name'>) => a.name

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
function handleRateLimit(taskId: number, runId: string, hit: RateLimitHit | undefined, noResult: boolean, name: string) {
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
    `Gặp giới hạn sử dụng của gói ${name}. Task tự quay lại hàng đợi, chạy tiếp lúc ${hhmm(decision.notBefore)}` +
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
 * FR-99 (SPEC-MULTI-AGENT 3.6a): agent hết hạn mức → chuyển sang agent dự phòng. Trả về true nếu đã chuyển
 * (task về Queued, chạy ngay khi có slot). Lần sau là phiên mới của agent dự phòng (không resume chéo), chạy tiếp trên
 * thay đổi dở trong cùng thư mục; Request changes giữ feedback. Không có agent phù hợp → false (chờ giờ reset như cũ).
 */
function failover(adapter: AgentAdapter, taskId: number, runId: string, hit: RateLimitHit, noResult: boolean): boolean {
  const task = tasks.get(taskId)
  const project = task && projects.get(task.projectId)
  if (!task || !project || task.status !== 'running') return false
  const fb = chooseFallback({ current: adapter.id, task, project })
  if (!fb) return false
  const when = hit.resetAt ? ` đến ${hhmm(hit.resetAt)}` : ''
  const text = `Chuyển từ ${adapter.name} sang ${AGENT_NAMES[fb]}: ${adapter.name} hết hạn mức${when}. Task chạy tiếp bằng ${AGENT_NAMES[fb]} trên thay đổi đang dở.`
  addEvent(runId, noResult ? { type: 'result', isError: true, text } : { type: 'system', text })
  updateTask(taskId, {
    status: 'queued',
    activeAgent: fb,
    notBefore: null,
    failReason: null,
    ...requeueIntent(runs.get(runId)),
  })
  broadcast({ type: 'agent_failover', taskId, from: adapter.id, to: fb, until: hit.resetAt })
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
 * dù có thay đổi code hay không (G3). Mode direct: không commit, chỉ chụp snapshot "sau" (headRef).
 * Approve → Done (chấp nhận output, không merge), Request changes → Claude chạy tiếp.
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
  let headRef: string | undefined
  try {
    const n = runNumber(runs.byTask(taskId), runId)
    ;({ headRef } = await captureChanges({ id: task.id, title: task.title, baseRef: task.baseRef, worktreePath: task.worktreePath }, project, n))
  } catch (err) {
    failReason = `Không ghi nhận được thay đổi của Claude: ${(err as Error).message}`
  }
  // Người dùng có thể đã dừng/xoá task trong lúc đang commit: không ghi đè trạng thái.
  if (tasks.get(taskId)?.status !== 'running') return
  if (failReason) {
    setFailKind(runId, 'infra') // Claude đã chạy xong, chỉ lỗi commit
    addEvent(runId, { type: 'result', isError: true, text: failReason })
    updateTask(taskId, { status: 'failed', failReason: failReason.slice(0, 1000) })
  } else updateTask(taskId, headRef ? { status: 'review', headRef } : { status: 'review' })
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

/** Còn tiến trình Claude đang chạy hoặc đang chuẩn bị (dùng cho tự tắt khi rảnh). */
export const hasActiveRuns = () => procs.size > 0 || preparing.size > 0

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
