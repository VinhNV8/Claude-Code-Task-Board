import type { FastifyInstance } from 'fastify'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { bus, broadcast, type ServerMessage } from './bus.ts'
import { events, projects, runs, settings, tasks } from './db.ts'
import { isRunning, pump, stopTask, updateTask } from './runner.ts'
import { findClaudeBin } from './claude.ts'
import type { PermissionMode, Priority, Project, Settings } from './types.ts'

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
    permissions: [],
    reviews: [],
    diffs: {},
  }))

  app.get<{ Params: { id: string } }>('/api/runs/:id/events', async (req) => events.byRun(req.params.id))

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
    }
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
    for (const t of tasks.all().filter((t) => t.projectId === req.params.id)) broadcast({ type: 'task_deleted', id: t.id })
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
    if (b.tags !== undefined) out.tags = b.tags.map((t) => t.trim()).filter(Boolean)
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

  // P2/P3: chưa hỗ trợ ở P1
  app.post('/api/tasks/:id/review', async () => {
    throw new HttpError(501, 'Review sẽ có ở giai đoạn P2')
  })
  app.post('/api/permissions/:id', async () => {
    throw new HttpError(501, 'Duyệt quyền trên web sẽ có ở giai đoạn P3')
  })

  // ------------------------------------------------------------ settings

  app.put<{ Body: Partial<Settings> }>('/api/settings', async (req) => {
    const cur = settings.get()
    const b = req.body
    const next: Settings = {
      maxParallel: b.maxParallel !== undefined ? Math.min(5, Math.max(1, Number(b.maxParallel) || 1)) : cur.maxParallel,
      browserNotifications: b.browserNotifications ?? cur.browserNotifications,
      notifyOn: { ...cur.notifyOn, ...b.notifyOn },
      permissionTimeoutMin: b.permissionTimeoutMin !== undefined ? Math.max(1, Number(b.permissionTimeoutMin) || 1) : cur.permissionTimeoutMin,
    }
    settings.set(next)
    broadcast({ type: 'settings', settings: next })
    pump()
    return next
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
