import type { FastifyInstance } from 'fastify'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { bus, broadcast, type ServerMessage } from './bus.ts'
import { approveTask, rejectTask, requestChanges } from './review.ts'
import { retryTask } from './retry.ts'
import { resumeTask } from './resume.ts'
import { events, projects, reviews, runs, scheduleRuns, schedules, settings, tasks, telegramToken, templates, testRuns } from './db.ts'
import { ScheduleError, checkCron, validateSchedule, type ScheduleInput } from './schedules.ts'
import { nextRuns } from './cron.ts'
import { TelegramError, mergeTelegram, sendTelegram, validateAppUrl, validateChatId, validateToken } from './telegram.ts'
import { TemplateError, validateTemplate, type TemplateInput } from './templates.ts'
import { TagError, validateTags } from './tags.ts'
import { StatsError, computeStats, parseStatsQuery, type StatsOptions, type StatsQuery } from './stats.ts'
import { hasSlot, isRunning, notifyFromClaude, pump, runNow, startRun, stopTask, updateTask } from './runner.ts'
import { TestCommandError, parseCommand } from './testCommand.ts'
import { isTesting, startTests, stopTests, testState } from './testRunner.ts'
import { findClaudeBin } from './claude.ts'
import { HttpError } from './httpError.ts'
import { modelSuggestFor, normalizeModel } from './model.ts'
import { adjustByHistory } from './modelHistoryService.ts'
import { taskDiff } from './git.ts'
import { INTERNAL_TOKEN } from './config.ts'
import { decidePermission, decidePermissionsBatch, initPermissions, listPermissions, requestPermission, type Decision } from './permissions.ts'
import { BudgetError, parseBudgetAction, parseUsd } from './budget.ts'
import { PERMISSION_PRESETS } from './permissionPresets.ts'
import { dismissRule, ruleSuggestionsFor, watchRuleSuggestions } from './ruleSuggestions.ts'
import { getBudgets, isProjectBlocked, refreshBudgets, withBlockedReason } from './budgetService.ts'
import type { FileDiff, PermissionMode, Priority, Project, PromptTemplate, Schedule, Settings, TelegramSettingsInput } from './types.ts'

const PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low']
// Không cho phép bypassPermissions (SPEC Mục 9)
const MODES: PermissionMode[] = ['acceptEdits', 'manual', 'plan']


function gitToplevel(path: string) {
  return new Promise<string | null>((res) =>
    execFile('git', ['-C', path, 'rev-parse', '--show-toplevel'], { windowsHide: true }, (err, out) =>
      res(err ? null : out.trim()),
    ),
  )
}

/** Diff của task; lỗi git (repo bị xoá, nhánh chính đổi tên...) thì coi như không có diff. */
async function safeDiff(projectId: string, taskId: number): Promise<FileDiff[]> {
  const project = projects.get(projectId)
  if (!project) return []
  try {
    return await taskDiff(project, taskId)
  } catch {
    return []
  }
}

function getTask(id: string) {
  const t = tasks.get(Number(id))
  if (!t) throw new HttpError(404, `Không tìm thấy task #${id}`)
  return t
}

export async function routes(app: FastifyInstance) {
  app.setErrorHandler((err: Error & { status?: number; statusCode?: number }, _req, reply) => {
    const status = err instanceof HttpError ? err.status : err.statusCode ?? 500
    if (status >= 500) app.log.error(err)
    reply.code(status).send({ error: err.message })
  })

  // ------------------------------------------------------------ trạng thái & sức khoẻ

  app.get('/api/health', async () => {
    const bin = findClaudeBin()
    return {
      ok: true,
      claude: bin ? { found: true, path: bin.path, source: bin.source, version: bin.version } : { found: false },
      time: new Date().toISOString(),
    }
  })

  app.get('/api/state', async () => {
    const inReview = tasks.all().filter((t) => t.status === 'review')
    const diffs: Record<number, FileDiff[]> = {}
    await Promise.all(inReview.map(async (t) => (diffs[t.id] = await safeDiff(t.projectId, t.id))))
    return {
      projects: projects.all(),
      tasks: tasks.all().map(withBlockedReason),
      runs: runs.all(),
      budgets: getBudgets(),
      settings: settings.get(),
      templates: templates.all(),
      schedules: schedules.all(),
      testRuns: testRuns.all(),
      permissions: listPermissions(),
      reviews: reviews.all(),
      diffs,
    }
  })

  app.get<{ Params: { id: string } }>('/api/tasks/:id/diff', async (req) => {
    const t = getTask(req.params.id)
    const project = projects.get(t.projectId)
    if (!project) throw new HttpError(404, `Không tìm thấy project của task #${t.id}`)
    try {
      return await taskDiff(project, t.id)
    } catch (e) {
      throw new HttpError(500, `Không lấy được diff của task #${t.id}: ${(e as Error).message}`)
    }
  })

  app.get<{ Params: { id: string } }>('/api/runs/:id/events', async (req) => events.byRun(req.params.id))

  // ------------------------------------------------------------ thống kê (PLAN 4.4)

  app.get<{ Querystring: StatsQuery }>('/api/stats', async (req) => {
    let opts: StatsOptions
    try {
      opts = parseStatsQuery(req.query ?? {}, (id) => !!projects.get(id))
    } catch (e) {
      if (e instanceof StatsError) throw new HttpError(400, e.message)
      throw e
    }
    const now = Date.now()
    // Lấy dư một ngày để chắc chắn đủ dữ liệu khi lệch múi giờ; computeStats tự lọc đúng khoảng.
    const runList = runs.since(now - (opts.days + 1) * 86_400_000)
    // P5-07: bảng tag × model cần mọi run của task (run đầu tiên có thể cũ hơn khoảng thời gian đang xem).
    return computeStats(
      { tasks: tasks.all(), runs: runList, projects: projects.all(), reviews: reviews.all(), historyRuns: runs.all() },
      opts,
      now,
    )
  })

  // ------------------------------------------------------------ projects

  async function validateProject(body: Partial<Project>): Promise<Project> {
    const name = body.name?.trim()
    const repoPath = body.repoPath?.trim()
    if (!name) throw new HttpError(400, 'Nhập tên project')
    if (!repoPath || !isAbsolute(repoPath)) throw new HttpError(400, 'Đường dẫn repo phải là đường dẫn tuyệt đối')
    if (!existsSync(repoPath)) throw new HttpError(400, 'Thư mục không tồn tại')
    if (!(await gitToplevel(repoPath))) throw new HttpError(400, 'Thư mục này không phải git repo (không tìm thấy .git)')
    const mode = (body.permissionMode ?? 'acceptEdits') as PermissionMode
    if (!MODES.includes(mode)) throw new HttpError(400, `Mức quyền không hợp lệ: ${mode}`)
    return {
      id: body.id || `p-${randomUUID().slice(0, 8)}`,
      name,
      repoPath,
      mainBranch: body.mainBranch?.trim() || 'main',
      permissionMode: mode,
      allowedTools: (body.allowedTools ?? []).map((t) => t.trim()).filter(Boolean),
      maxParallel: Math.min(5, Math.max(1, Number(body.maxParallel) || 1)),
      testCommand: validateTestCommand(body.testCommand),
      defaultModel: normalizeModel(body.defaultModel) || undefined,
      ...validateBudget(body),
    }
  }

  /**
   * P6 (B1): budget tháng và hành động khi vượt. Trường không gửi lên (form cũ) thì giữ giá trị đang có của project;
   * gửi null/'' thì xoá budget (không giới hạn).
   */
  function validateBudget(body: Partial<Project>): Pick<Project, 'monthlyBudgetUsd' | 'budgetAction'> {
    const cur = body.id ? projects.get(body.id) : undefined
    try {
      return {
        monthlyBudgetUsd: 'monthlyBudgetUsd' in body ? parseUsd(body.monthlyBudgetUsd, 'Budget tháng') : cur?.monthlyBudgetUsd,
        budgetAction: 'budgetAction' in body ? parseBudgetAction(body.budgetAction) : (cur?.budgetAction ?? 'warn'),
      }
    } catch (e) {
      if (e instanceof BudgetError) throw new HttpError(400, e.message)
      throw e
    }
  }

  /** FR-34: lệnh test tuỳ chọn; kiểm tra cú pháp ngay khi lưu để báo lỗi sớm. */
  function validateTestCommand(raw: unknown): string | undefined {
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== 'string') throw new HttpError(400, 'Lệnh test không hợp lệ')
    const cmd = raw.trim()
    if (!cmd) return undefined
    if (cmd.length > 500) throw new HttpError(400, 'Lệnh test quá dài (tối đa 500 ký tự)')
    try {
      parseCommand(cmd)
    } catch (e) {
      if (e instanceof TestCommandError) throw new HttpError(400, e.message)
      throw e
    }
    return cmd
  }

  app.post<{ Body: Partial<Project> }>('/api/projects', async (req) => {
    const p = projects.upsert(await validateProject(req.body))
    broadcast({ type: 'project', project: p })
    refreshBudgets() // đổi budget/hành động: tính lại mức, cảnh báo và trạng thái chặn
    pump()
    return p
  })

  // FR-44: gợi ý thêm rule vào allowlist từ lịch sử duyệt. "Thêm" dùng POST /api/projects như form project.
  app.get<{ Params: { id: string } }>('/api/projects/:id/rule-suggestions', async (req) => {
    const p = projects.get(req.params.id)
    if (!p) throw new HttpError(404, `Không tìm thấy project ${req.params.id}`)
    return ruleSuggestionsFor(p)
  })

  app.post<{ Params: { id: string }; Body: { rule?: unknown } }>('/api/projects/:id/rule-suggestions/dismiss', async (req) => {
    const p = projects.get(req.params.id)
    if (!p) throw new HttpError(404, `Không tìm thấy project ${req.params.id}`)
    const rule = typeof req.body?.rule === 'string' ? req.body.rule.trim() : ''
    if (!rule) throw new HttpError(400, 'Thiếu rule cần bỏ qua')
    if (rule.length > 4000) throw new HttpError(400, 'Rule quá dài')
    dismissRule(p.id, rule)
    const suggestions = ruleSuggestionsFor(p)
    broadcast({ type: 'rule_suggestions', projectId: p.id, suggestions })
    return suggestions
  })

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    const busy = tasks.all().some((t) => t.projectId === req.params.id && isRunning(t.id))
    if (busy) throw new HttpError(409, 'Project đang có task chạy, hãy dừng trước khi xoá')
    for (const t of tasks.all().filter((t) => t.projectId === req.params.id)) {
      if (isTesting(t.id)) await stopTests(t.id, 'Project đã bị xoá.')
      broadcast({ type: 'task_deleted', id: t.id })
    }
    // Template riêng của project bị xoá theo (ON DELETE CASCADE)
    for (const t of templates.byProject(req.params.id)) broadcast({ type: 'template_deleted', id: t.id })
    for (const s of schedules.byProject(req.params.id)) broadcast({ type: 'schedule_deleted', id: s.id })
    projects.remove(req.params.id)
    broadcast({ type: 'project_deleted', id: req.params.id })
    refreshBudgets()
    return { ok: true }
  })

  // ------------------------------------------------------------ tasks

  interface TaskBody {
    title?: string
    prompt?: string
    projectId?: string
    priority?: Priority
    permissionMode?: PermissionMode
    tags?: string[]
    /** '' hoặc null: kế thừa project → Settings (P5, D2). */
    model?: string | null
    /** Giới hạn chi phí mỗi lần chạy (USD, `--max-budget-usd`). null/'': không giới hạn. */
    maxCostUsd?: number | string | null
    run?: boolean
  }

  function validateTask(b: TaskBody, partial = false) {
    const out: TaskBody = {}
    if (!partial || b.title !== undefined) {
      if (!b.title?.trim()) throw new HttpError(400, 'Vui lòng nhập tiêu đề')
      out.title = b.title.trim()
    }
    if (!partial || b.prompt !== undefined) {
      if (!b.prompt || b.prompt.trim().length < 10) throw new HttpError(400, 'Mô tả cần ít nhất 10 ký tự')
      out.prompt = b.prompt
    }
    if (!partial || b.projectId !== undefined) {
      if (!b.projectId || !projects.get(b.projectId)) throw new HttpError(400, 'Project không hợp lệ')
      out.projectId = b.projectId
    }
    if (b.priority !== undefined) {
      if (!PRIORITIES.includes(b.priority)) throw new HttpError(400, 'Độ ưu tiên không hợp lệ')
      out.priority = b.priority
    }
    if (b.permissionMode !== undefined) {
      if (!MODES.includes(b.permissionMode)) throw new HttpError(400, 'Mức quyền không hợp lệ')
      out.permissionMode = b.permissionMode
    }
    if (b.tags !== undefined) {
      try {
        out.tags = validateTags(b.tags)
      } catch (e) {
        if (e instanceof TagError) throw new HttpError(400, e.message)
        throw e
      }
    }
    if (b.model !== undefined) out.model = normalizeModel(b.model)
    if (b.maxCostUsd !== undefined) {
      try {
        const n = parseUsd(b.maxCostUsd, 'Giới hạn chi phí mỗi lần chạy')
        if (n === 0) throw new BudgetError('Giới hạn chi phí mỗi lần chạy phải lớn hơn 0 (để trống nếu không giới hạn)')
        out.maxCostUsd = n ?? null
      } catch (e) {
        if (e instanceof BudgetError) throw new HttpError(400, e.message)
        throw e
      }
    }
    return out
  }

  app.post<{ Body: TaskBody }>('/api/tasks', async (req) => {
    const v = validateTask(req.body)
    const project = projects.get(v.projectId!)!
    const t = tasks.create({
      projectId: v.projectId!,
      title: v.title!,
      prompt: v.prompt!,
      priority: v.priority ?? 'normal',
      permissionMode: v.permissionMode ?? project.permissionMode,
      tags: v.tags ?? [],
      model: v.model || undefined,
      maxCostUsd: (v.maxCostUsd as number | null | undefined) ?? undefined,
      status: req.body.run ? 'queued' : 'backlog',
    })
    broadcast({ type: 'task', task: t })
    pump()
    return t
  })

  app.patch<{ Params: { id: string }; Body: TaskBody }>('/api/tasks/:id', async (req) => {
    const t = getTask(req.params.id)
    if (t.status !== 'backlog' && t.status !== 'queued') throw new HttpError(409, 'Chỉ sửa được task ở Backlog hoặc Queued')
    const v = validateTask(req.body, true)
    // Model rỗng lưu NULL (kế thừa)
    return updateTask(t.id, { ...v, ...(v.model !== undefined ? { model: v.model || null } : {}) })
  })

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (req) => {
    const t = getTask(req.params.id)
    if (isRunning(t.id)) throw new HttpError(409, 'Task đang chạy, hãy dừng trước khi xoá')
    await stopTests(t.id, 'Task đã bị xoá.')
    const hadCost = runs.byTask(t.id).some((r) => r.costUsd)
    tasks.remove(t.id)
    broadcast({ type: 'task_deleted', id: t.id })
    // Run của task bị xoá theo (ON DELETE CASCADE) nên chi tiêu tháng có thể giảm.
    if (hadCost) refreshBudgets()
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/tasks/:id/queue', async (req) => {
    const t = getTask(req.params.id)
    if (t.status !== 'backlog') throw new HttpError(409, 'Chỉ đưa vào hàng đợi task ở Backlog')
    // Người dùng chủ động đưa vào hàng đợi: chạy ngay khi có slot, bộ đếm tự thử lại do giới hạn sử dụng về 0.
    updateTask(t.id, { status: 'queued', notBefore: null, rateLimitRetries: 0 })
    pump()
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/tasks/:id/unqueue', async (req) => {
    const t = getTask(req.params.id)
    if (t.status !== 'queued') throw new HttpError(409, 'Task không ở trong hàng đợi')
    updateTask(t.id, { status: 'backlog', notBefore: null, rateLimitRetries: 0 })
    return { ok: true }
  })

  // Kéo thả task sang cột Running: chạy ngay nếu còn slot, hết slot thì vào hàng đợi.
  app.post<{ Params: { id: string } }>('/api/tasks/:id/run', async (req) => {
    const t = getTask(req.params.id)
    if (t.status !== 'backlog' && t.status !== 'queued') throw new HttpError(409, 'Chỉ chạy ngay được task ở Backlog hoặc Queued')
    // P6 B3: project đặt "tạm dừng khi vượt budget" và đã vượt → không cho chạy tay.
    if (isProjectBlocked(t.projectId))
      throw new HttpError(
        409,
        'Project đã vượt budget tháng (ước tính) và đang đặt chế độ tạm dừng. Tăng budget, đổi sang chỉ cảnh báo, hoặc chờ sang tháng mới để chạy.',
      )
    return { ok: true, started: runNow(t.id) }
  })

  app.post<{ Params: { id: string } }>('/api/tasks/:id/stop', async (req) => {
    const t = getTask(req.params.id)
    if (t.status !== 'running' && t.status !== 'needs_input') throw new HttpError(409, 'Task không đang chạy')
    await stopTask(t.id)
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/tasks/:id/retry', async (req) => {
    const t = getTask(req.params.id)
    if (t.status !== 'failed') throw new HttpError(409, 'Chỉ chạy lại task ở Failed')
    // PLAN 2.7: reset worktree về mainBranch (hoặc xoá branch/worktreePath nếu đã bị Reject), xoá session cũ, rồi Queued.
    await retryTask(t.id, { pump })
    return { ok: true }
  })

  // Tiếp tục task bị tạm dừng / lỗi / hết giới hạn sử dụng: giữ worktree, chạy tiếp phiên Claude cũ.
  app.post<{ Params: { id: string } }>('/api/tasks/:id/resume', async (req) => {
    const t = getTask(req.params.id)
    const r = await resumeTask(t.id, { hasSlot, startRun, pump })
    return { ok: true, started: r.started }
  })

  // ------------------------------------------------------------ chạy test trên trang Review (PLAN 4.3, FR-34)

  app.get<{ Params: { id: string } }>('/api/tasks/:id/test', async (req) => testState(getTask(req.params.id).id))

  app.post<{ Params: { id: string } }>('/api/tasks/:id/test', async (req) => startTests(getTask(req.params.id).id))

  app.post<{ Params: { id: string } }>('/api/tasks/:id/test/stop', async (req) => {
    const t = getTask(req.params.id)
    if (!(await stopTests(t.id))) throw new HttpError(409, 'Không có lần chạy test nào đang diễn ra')
    return { ok: true }
  })

  // ------------------------------------------------------------ review (PLAN 2.4–2.8)

  app.post<{ Params: { id: string }; Body: { action?: string; feedback?: string } }>('/api/tasks/:id/review', async (req) => {
    const t = getTask(req.params.id)
    const action = req.body?.action
    if (action === 'approve') return approveTask(t.id)
    if (action === 'request_changes') return requestChanges(t.id, req.body?.feedback, { hasSlot, startRun })
    if (action === 'reject') return rejectTask(t.id, req.body?.feedback)
    throw new HttpError(400, 'Thao tác review không hợp lệ (chỉ chấp nhận approve, request_changes, reject)')
  })

  // ------------------------------------------------------------ duyệt quyền (PLAN 3.3–3.5)

  initPermissions()
  watchRuleSuggestions()
  const DECISIONS: Decision[] = ['allow', 'deny', 'always', 'timeout']

  // FR-46: duyệt hàng loạt các yêu cầu giống hệt nhau. Đăng ký trước `/:id` cho dễ đọc (Fastify ưu tiên route tĩnh).
  app.post<{ Body: { ids?: unknown; decision?: unknown; reason?: unknown } }>('/api/permissions/batch', async (req) => {
    const b = req.body ?? {}
    return decidePermissionsBatch(b.ids, b.decision, b.reason)
  })

  app.post<{ Params: { id: string }; Body: { decision?: Decision; reason?: string } }>('/api/permissions/:id', async (req) => {
    const d = req.body?.decision
    if (!d || !DECISIONS.includes(d)) throw new HttpError(400, 'Quyết định không hợp lệ')
    return decidePermission(req.params.id, d, d === 'deny' ? req.body?.reason : undefined)
  })

  interface PermissionBody {
    taskId?: string | number
    toolName?: string
    input?: Record<string, unknown>
    requestId?: string
  }

  // MCP server `taskboard.approve` gọi long-poll (server/src/mcp/permission.ts)
  app.post<{ Body: PermissionBody }>('/api/internal/permissions', async (req) => {
    if (req.headers['x-taskboard-token'] !== INTERNAL_TOKEN) throw new HttpError(401, 'Token nội bộ không hợp lệ')
    const b = req.body ?? {}
    const t = getTask(String(b.taskId ?? ''))
    if (typeof b.toolName !== 'string' || !b.toolName) throw new HttpError(400, 'Thiếu toolName')
    const input = b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input : {}
    return requestPermission({ taskId: t.id, toolName: b.toolName, input, requestId: b.requestId || undefined })
  })

  // ------------------------------------------------------------ templates (FR-06)

  function saveTemplate(body: TemplateInput) {
    let t: PromptTemplate
    try {
      t = validateTemplate(body, (id) => !!projects.get(id), () => `tpl-${randomUUID().slice(0, 8)}`)
    } catch (e) {
      if (e instanceof TemplateError) throw new HttpError(400, e.message)
      throw e
    }
    const saved = templates.upsert(t)
    broadcast({ type: 'template', template: saved })
    return saved
  }

  app.get('/api/templates', async () => templates.all())

  // Bộ rule allowlist có sẵn (P7-01); chỉ đọc, web tự gộp vào form project rồi lưu qua PUT /api/projects.
  app.get('/api/permission-presets', async () => PERMISSION_PRESETS)

  app.post<{ Body: TemplateInput }>('/api/templates', async (req) => saveTemplate({ ...req.body, id: undefined }))

  app.put<{ Params: { id: string }; Body: TemplateInput }>('/api/templates/:id', async (req) => {
    if (!templates.get(req.params.id)) throw new HttpError(404, 'Không tìm thấy template')
    return saveTemplate({ ...req.body, id: req.params.id })
  })

  app.delete<{ Params: { id: string } }>('/api/templates/:id', async (req) => {
    if (!templates.get(req.params.id)) throw new HttpError(404, 'Không tìm thấy template')
    templates.remove(req.params.id)
    broadcast({ type: 'template_deleted', id: req.params.id })
    return { ok: true }
  })

  // ------------------------------------------------------------ lên lịch theo cron (PLAN 4.6)

  function getSchedule(id: string) {
    const s = schedules.get(id)
    if (!s) throw new HttpError(404, 'Không tìm thấy lịch')
    return s
  }

  function saveSchedule(body: ScheduleInput, prev?: Schedule) {
    let s: Schedule
    try {
      s = validateSchedule(body ?? {}, {
        prev,
        projectExists: (id) => !!projects.get(id),
        newId: () => `sch-${randomUUID().slice(0, 8)}`,
        now: Date.now(),
      })
    } catch (e) {
      if (e instanceof ScheduleError) throw new HttpError(400, e.message)
      throw e
    }
    const saved = schedules.upsert(s)
    broadcast({ type: 'schedule', schedule: saved })
    return saved
  }

  app.get('/api/schedules', async () => schedules.all())

  // Xem trước các lần chạy kế tiếp của một biểu thức cron (form tạo/sửa lịch)
  app.get<{ Querystring: { cron?: string; count?: string } }>('/api/schedules/preview', async (req) => {
    const cron = (req.query?.cron ?? '').trim()
    const count = Math.min(10, Math.max(1, Number(req.query?.count) || 3))
    try {
      checkCron(cron, Date.now())
      return { next: nextRuns(cron, Date.now(), count) }
    } catch (e) {
      if (e instanceof ScheduleError) throw new HttpError(400, e.message)
      throw e
    }
  })

  app.post<{ Body: ScheduleInput }>('/api/schedules', async (req) => saveSchedule(req.body))

  app.put<{ Params: { id: string }; Body: ScheduleInput }>('/api/schedules/:id', async (req) =>
    saveSchedule(req.body, getSchedule(req.params.id)),
  )

  app.delete<{ Params: { id: string } }>('/api/schedules/:id', async (req) => {
    getSchedule(req.params.id)
    schedules.remove(req.params.id) // lịch sử bị xoá theo; task đã tạo vẫn giữ nguyên
    broadcast({ type: 'schedule_deleted', id: req.params.id })
    return { ok: true }
  })

  app.get<{ Params: { id: string } }>('/api/schedules/:id/runs', async (req) => scheduleRuns.bySchedule(getSchedule(req.params.id).id))

  // ------------------------------------------------------------ hooks của Claude Code (PLAN 3.6)

  interface NotificationBody {
    taskId?: string | number
    message?: string
    title?: string
    notificationType?: string
  }

  app.post<{ Body: NotificationBody }>('/api/hooks/notification', async (req) => {
    if (req.headers['x-taskboard-token'] !== INTERNAL_TOKEN) throw new HttpError(401, 'Token nội bộ không hợp lệ')
    const b = req.body ?? {}
    const t = getTask(String(b.taskId ?? ''))
    const message = typeof b.message === 'string' ? b.message.trim().slice(0, 2000) : ''
    if (!message) throw new HttpError(400, 'Thiếu nội dung thông báo')
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined)
    const runId = notifyFromClaude(t.id, { message, title: str(b.title), notificationType: str(b.notificationType) })
    if (!runId) throw new HttpError(409, `Task #${t.id} không có lần chạy nào đang diễn ra`)
    return { ok: true, runId }
  })

  // ------------------------------------------------------------ settings

  type SettingsBody = Partial<Omit<Settings, 'telegram'>> & { telegram?: TelegramSettingsInput }

  app.put<{ Body: SettingsBody }>('/api/settings', async (req) => {
    const cur = settings.get()
    const b = req.body ?? {}
    let tg: ReturnType<typeof mergeTelegram>
    try {
      tg = mergeTelegram(cur.telegram, b.telegram)
    } catch (e) {
      if (e instanceof TelegramError) throw new HttpError(400, e.message)
      throw e
    }
    const next: Settings = {
      maxParallel: b.maxParallel !== undefined ? Math.min(5, Math.max(1, Number(b.maxParallel) || 1)) : cur.maxParallel,
      browserNotifications: b.browserNotifications ?? cur.browserNotifications,
      notifyOn: { ...cur.notifyOn, ...b.notifyOn },
      permissionTimeoutMin: b.permissionTimeoutMin !== undefined ? Math.max(1, Number(b.permissionTimeoutMin) || 1) : cur.permissionTimeoutMin,
      defaultModel: b.defaultModel !== undefined ? normalizeModel(b.defaultModel) : cur.defaultModel,
      autoEscalate: b.autoEscalate !== undefined ? !!b.autoEscalate : cur.autoEscalate,
      telegram: { ...tg.telegram, hasToken: cur.telegram.hasToken },
    }
    if (tg.token !== undefined) telegramToken.set(tg.token)
    const saved = settings.set(next) // hasToken lấy lại từ DB, token không bao giờ nằm trong kết quả
    broadcast({ type: 'settings', settings: saved })
    pump()
    return saved
  })

  // P5-04: gợi ý model theo quy tắc (Lớp 1). Không gọi Claude, chỉ tính toán nên trả về ngay.
  app.post<{ Body: { title?: unknown; prompt?: unknown; tags?: unknown; permissionMode?: unknown; projectId?: unknown } }>(
    '/api/model-suggest',
    async (req) => {
      const b = req.body ?? {}
      const str = (v: unknown, name: string) => {
        if (v === undefined || v === null) return ''
        if (typeof v !== 'string') throw new HttpError(400, `${name} phải là chuỗi`)
        return v.slice(0, 100_000) // giới hạn để luôn tính nhanh
      }
      const title = str(b.title, 'Tiêu đề')
      const prompt = str(b.prompt, 'Prompt')
      if (b.tags !== undefined && b.tags !== null && (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== 'string')))
        throw new HttpError(400, 'Tag phải là danh sách chuỗi')
      const tags = ((b.tags as string[] | null | undefined) ?? []).slice(0, 100)
      let project: Project | undefined
      if (b.projectId !== undefined && b.projectId !== null && b.projectId !== '') {
        project = projects.get(String(b.projectId))
        if (!project) throw new HttpError(404, `Không tìm thấy project ${String(b.projectId)}`)
      }
      const mode = (b.permissionMode ?? project?.permissionMode ?? 'acceptEdits') as PermissionMode
      if (!MODES.includes(mode)) throw new HttpError(400, `Mức quyền không hợp lệ: ${String(mode)}`)
      // P5-07: có project thì Lớp 2 hiệu chỉnh theo lịch sử của project đó.
      return modelSuggestFor({ title, prompt, tags, permissionMode: mode }, project ?? {}, settings.get(), (s) =>
        project ? adjustByHistory(s, { projectId: project.id, tags }) : s,
      )
    },
  )

  // Gửi thử Telegram: dùng giá trị đang nhập (nếu có) hoặc cấu hình đã lưu.
  app.post<{ Body: { botToken?: string; chatId?: string; appUrl?: string } }>('/api/settings/telegram/test', async (req) => {
    const b = req.body ?? {}
    const cur = settings.get().telegram
    try {
      const token = typeof b.botToken === 'string' && b.botToken.trim() ? validateToken(b.botToken) : telegramToken.get()
      const chatId = b.chatId !== undefined ? validateChatId(b.chatId) : cur.chatId
      const appUrl = b.appUrl !== undefined ? validateAppUrl(b.appUrl) : cur.appUrl
      if (!token) throw new TelegramError('Chưa nhập bot token')
      if (!chatId) throw new TelegramError('Chưa nhập chat ID')
      const link = appUrl ? `\nMở giao diện: ${appUrl}` : ''
      await sendTelegram({ token, chatId }, `🔔 Tin nhắn thử từ Claude Task Board.\nThông báo Telegram đã hoạt động.${link}`)
    } catch (e) {
      if (e instanceof TelegramError) throw new HttpError(400, e.message)
      throw e
    }
    return { ok: true }
  })

  // ------------------------------------------------------------ websocket

  app.get('/ws', { websocket: true }, (socket) => {
    const send = (m: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m))
    }
    bus.on('message', send)
    socket.on('close', () => bus.off('message', send))
  })
}
