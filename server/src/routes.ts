import type { FastifyInstance } from 'fastify'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { bus, broadcast, type ServerMessage } from './bus.ts'
import { events, projects, runs, scheduleRuns, schedules, settings, tasks, telegramToken, templates, testRuns } from './db.ts'
import { ScheduleError, checkCron, validateSchedule, type ScheduleInput } from './schedules.ts'
import { nextRuns } from './cron.ts'
import { TelegramError, mergeTelegram, sendTelegram, validateAppUrl, validateChatId, validateToken } from './telegram.ts'
import { TemplateError, validateTemplate, type TemplateInput } from './templates.ts'
import { TagError, validateTags } from './tags.ts'
import { StatsError, computeStats, parseStatsQuery, type StatsOptions, type StatsQuery } from './stats.ts'
import { isRunning, notifyFromClaude, pump, stopTask, updateTask } from './runner.ts'
import { TestCommandError, parseCommand } from './testCommand.ts'
import { isTesting, startTests, stopTests, testState } from './testRunner.ts'
import { findClaudeBin } from './claude.ts'
import { INTERNAL_TOKEN } from './config.ts'
import { decidePermission, initPermissions, listPermissions, requestPermission, type Decision } from './permissions.ts'
import type { PermissionMode, Priority, Project, PromptTemplate, Schedule, Settings, TelegramSettingsInput } from './types.ts'

const PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low']
// Không cho phép bypassPermissions (SPEC Mục 9)
const MODES: PermissionMode[] = ['acceptEdits', 'manual', 'plan']

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

function gitToplevel(path: string) {
  return new Promise<string | null>((res) =>
    execFile('git', ['-C', path, 'rev-parse', '--show-toplevel'], { windowsHide: true }, (err, out) =>
      res(err ? null : out.trim()),
    ),
  )
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

  app.get('/api/state', async () => ({
    projects: projects.all(),
    tasks: tasks.all(),
    runs: runs.all(),
    settings: settings.get(),
    templates: templates.all(),
    schedules: schedules.all(),
    testRuns: testRuns.all(),
    permissions: listPermissions(),
    reviews: [],
    diffs: {},
  }))

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
    return computeStats({ tasks: tasks.all(), runs: runList, projects: projects.all() }, opts, now)
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
    pump()
    return p
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
      status: req.body.run ? 'queued' : 'backlog',
    })
    broadcast({ type: 'task', task: t })
    pump()
    return t
  })

  app.patch<{ Params: { id: string }; Body: TaskBody }>('/api/tasks/:id', async (req) => {
    const t = getTask(req.params.id)
    if (t.status !== 'backlog' && t.status !== 'queued') throw new HttpError(409, 'Chỉ sửa được task ở Backlog hoặc Queued')
    return updateTask(t.id, { ...validateTask(req.body, true) })
  })

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (req) => {
    const t = getTask(req.params.id)
    if (isRunning(t.id)) throw new HttpError(409, 'Task đang chạy, hãy dừng trước khi xoá')
    await stopTests(t.id, 'Task đã bị xoá.')
    tasks.remove(t.id)
    broadcast({ type: 'task_deleted', id: t.id })
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/tasks/:id/queue', async (req) => {
    const t = getTask(req.params.id)
    if (t.status !== 'backlog') throw new HttpError(409, 'Chỉ đưa vào hàng đợi task ở Backlog')
    updateTask(t.id, { status: 'queued' })
    pump()
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/tasks/:id/unqueue', async (req) => {
    const t = getTask(req.params.id)
    if (t.status !== 'queued') throw new HttpError(409, 'Task không ở trong hàng đợi')
    updateTask(t.id, { status: 'backlog' })
    return { ok: true }
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
    updateTask(t.id, { status: 'queued', failReason: null })
    pump()
    return { ok: true }
  })

  // ------------------------------------------------------------ chạy test trên trang Review (PLAN 4.3, FR-34)

  app.get<{ Params: { id: string } }>('/api/tasks/:id/test', async (req) => testState(getTask(req.params.id).id))

  app.post<{ Params: { id: string } }>('/api/tasks/:id/test', async (req) => startTests(getTask(req.params.id).id))

  app.post<{ Params: { id: string } }>('/api/tasks/:id/test/stop', async (req) => {
    const t = getTask(req.params.id)
    if (!(await stopTests(t.id))) throw new HttpError(409, 'Không có lần chạy test nào đang diễn ra')
    return { ok: true }
  })

  // P2/P3: chưa hỗ trợ ở P1
  app.post('/api/tasks/:id/review', async () => {
    throw new HttpError(501, 'Review sẽ có ở giai đoạn P2')
  })

  // ------------------------------------------------------------ duyệt quyền (PLAN 3.3–3.5)

  initPermissions()
  const DECISIONS: Decision[] = ['allow', 'deny', 'always', 'timeout']

  app.post<{ Params: { id: string }; Body: { decision?: Decision } }>('/api/permissions/:id', async (req) => {
    const d = req.body?.decision
    if (!d || !DECISIONS.includes(d)) throw new HttpError(400, 'Quyết định không hợp lệ')
    return decidePermission(req.params.id, d)
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
      telegram: { ...tg.telegram, hasToken: cur.telegram.hasToken },
    }
    if (tg.token !== undefined) telegramToken.set(tg.token)
    const saved = settings.set(next) // hasToken lấy lại từ DB, token không bao giờ nằm trong kết quả
    broadcast({ type: 'settings', settings: saved })
    pump()
    return saved
  })

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
