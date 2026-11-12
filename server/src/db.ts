// SQLite (node:sqlite có sẵn trong Node 24), schema theo SPEC Mục 5.2.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  LogEvent,
  LogEventInput,
  Project,
  PromptTemplate,
  Run,
  Schedule,
  ScheduleRun,
  Settings,
  Task,
  TaskStatus,
  TestOutput,
  TestRun,
  TestStatus,
} from './types.ts'
import { DEFAULT_TEMPLATES } from './templates.ts'
import { DEFAULT_TELEGRAM } from './telegram.ts'

export const DATA_DIR = process.env.TASKBOARD_DATA ?? join(import.meta.dirname, '..', '..', 'data')
mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(process.env.TASKBOARD_DB ?? join(DATA_DIR, 'taskboard.db'))
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  main_branch TEXT NOT NULL DEFAULT 'main',
  permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  max_parallel INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
  tags TEXT NOT NULL DEFAULT '[]',
  branch TEXT,
  worktree_path TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  fail_reason TEXT,
  review_warning TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  feedback TEXT,
  session_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  exit_code INTEGER,
  num_turns INTEGER,
  cost_usd REAL,
  summary TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  feedback TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_task ON reviews(task_id);
CREATE TABLE IF NOT EXISTS permission_requests (
  id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  timeout_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_permission_requests_status ON permission_requests(status);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`)

// Bảng templates: tạo lần đầu thì nạp sẵn template mặc định (xoá rồi sẽ không tự thêm lại).
const hasTemplatesTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'templates'").get()
db.exec(`
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
`)

// FR-34: lệnh test của project (DB cũ chưa có cột) và lần chạy test gần nhất của mỗi task.
const projectCols = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]
if (!projectCols.some((c) => c.name === 'test_command')) db.exec('ALTER TABLE projects ADD COLUMN test_command TEXT')
db.exec(`
CREATE TABLE IF NOT EXISTS test_runs (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  exit_code INTEGER,
  error TEXT,
  output TEXT NOT NULL DEFAULT '',
  output_end INTEGER NOT NULL DEFAULT 0
);
`)

// PLAN 4.6: lịch tạo task theo cron và lịch sử task đã tạo (task bị xoá thì giữ lịch sử, task_id = NULL).
db.exec(`
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  cron TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  scheduled_for INTEGER NOT NULL,
  fired_at INTEGER NOT NULL,
  catch_up INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(schedule_id);
`)

// ---------------------------------------------------------------- mapping

type Row = Record<string, unknown>

const toProject = (r: Row): Project => ({
  id: r.id as string,
  name: r.name as string,
  repoPath: r.repo_path as string,
  mainBranch: r.main_branch as string,
  permissionMode: r.permission_mode as Project['permissionMode'],
  allowedTools: JSON.parse(r.allowed_tools as string),
  maxParallel: r.max_parallel as number,
  testCommand: (r.test_command as string | null) || undefined,
})

const opt = <T>(v: unknown) => (v === null ? undefined : (v as T))

const toTask = (r: Row): Task => ({
  id: r.id as number,
  projectId: r.project_id as string,
  title: r.title as string,
  prompt: r.prompt as string,
  status: r.status as TaskStatus,
  priority: r.priority as Task['priority'],
  permissionMode: r.permission_mode as Task['permissionMode'],
  tags: JSON.parse(r.tags as string),
  branch: opt(r.branch),
  worktreePath: opt(r.worktree_path),
  sessionId: opt(r.session_id),
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
  startedAt: opt(r.started_at),
  failReason: opt(r.fail_reason),
  reviewWarning: opt(r.review_warning),
})

const toRun = (r: Row): Run => ({
  id: r.id as string,
  taskId: r.task_id as number,
  kind: r.kind as Run['kind'],
  feedback: opt(r.feedback),
  sessionId: opt(r.session_id),
  startedAt: r.started_at as number,
  endedAt: opt(r.ended_at),
  exitCode: opt(r.exit_code),
  numTurns: opt(r.num_turns),
  costUsd: opt(r.cost_usd),
  summary: opt(r.summary),
})

// ---------------------------------------------------------------- projects

export const projects = {
  all: () => (db.prepare('SELECT * FROM projects ORDER BY name').all() as Row[]).map(toProject),
  get: (id: string) => {
    const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
    return r && toProject(r)
  },
  upsert: (p: Project) => {
    db.prepare(
      `INSERT INTO projects (id, name, repo_path, main_branch, permission_mode, allowed_tools, max_parallel, test_command)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, repo_path=excluded.repo_path, main_branch=excluded.main_branch,
         permission_mode=excluded.permission_mode, allowed_tools=excluded.allowed_tools, max_parallel=excluded.max_parallel,
         test_command=excluded.test_command`,
    ).run(p.id, p.name, p.repoPath, p.mainBranch, p.permissionMode, JSON.stringify(p.allowedTools), p.maxParallel, p.testCommand || null)
    return projects.get(p.id)!
  },
  remove: (id: string) => db.prepare('DELETE FROM projects WHERE id = ?').run(id),
}

// ---------------------------------------------------------------- tasks

const TASK_COLS: Record<string, string> = {
  projectId: 'project_id',
  title: 'title',
  prompt: 'prompt',
  status: 'status',
  priority: 'priority',
  permissionMode: 'permission_mode',
  tags: 'tags',
  branch: 'branch',
  worktreePath: 'worktree_path',
  sessionId: 'session_id',
  startedAt: 'started_at',
  failReason: 'fail_reason',
  reviewWarning: 'review_warning',
}

export const tasks = {
  all: () => (db.prepare('SELECT * FROM tasks').all() as Row[]).map(toTask),
  get: (id: number) => {
    const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined
    return r && toTask(r)
  },
  byStatus: (...st: TaskStatus[]) =>
    (db.prepare(`SELECT * FROM tasks WHERE status IN (${st.map(() => '?').join(',')})`).all(...st) as Row[]).map(toTask),
  create: (t: Pick<Task, 'projectId' | 'title' | 'prompt' | 'status' | 'priority' | 'permissionMode' | 'tags'>) => {
    const now = Date.now()
    const r = db
      .prepare(
        `INSERT INTO tasks (project_id, title, prompt, status, priority, permission_mode, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.projectId, t.title, t.prompt, t.status, t.priority, t.permissionMode, JSON.stringify(t.tags), now, now)
    return tasks.get(Number(r.lastInsertRowid))!
  },
  /** Cập nhật một phần. Giá trị `null` sẽ xoá cột. */
  patch: (id: number, patch: Partial<Record<keyof typeof TASK_COLS, unknown>>) => {
    const sets: string[] = []
    const vals: (string | number | null)[] = []
    for (const [k, v] of Object.entries(patch)) {
      const col = TASK_COLS[k]
      if (!col) continue
      sets.push(`${col} = ?`)
      vals.push(k === 'tags' ? JSON.stringify(v) : v === undefined ? null : (v as string | number | null))
    }
    sets.push('updated_at = ?')
    vals.push(Date.now())
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
    return tasks.get(id)
  },
  remove: (id: number) => db.prepare('DELETE FROM tasks WHERE id = ?').run(id),
}

// ---------------------------------------------------------------- runs & events

export const runs = {
  all: () => (db.prepare('SELECT * FROM runs ORDER BY started_at').all() as Row[]).map(toRun),
  get: (id: string) => {
    const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined
    return r && toRun(r)
  },
  byTask: (taskId: number) => (db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at').all(taskId) as Row[]).map(toRun),
  open: () => (db.prepare('SELECT * FROM runs WHERE ended_at IS NULL').all() as Row[]).map(toRun),
  /** Các lần chạy bắt đầu từ mốc `from` (epoch ms), dùng cho thống kê. */
  since: (from: number) => (db.prepare('SELECT * FROM runs WHERE started_at >= ? ORDER BY started_at').all(from) as Row[]).map(toRun),
  create: (r: Pick<Run, 'id' | 'taskId' | 'kind' | 'feedback' | 'sessionId' | 'startedAt'>) => {
    db.prepare('INSERT INTO runs (id, task_id, kind, feedback, session_id, started_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      r.id,
      r.taskId,
      r.kind,
      r.feedback ?? null,
      r.sessionId ?? null,
      r.startedAt,
    )
    return runs.get(r.id)!
  },
  finish: (id: string, f: Pick<Run, 'endedAt' | 'exitCode'> & Partial<Pick<Run, 'numTurns' | 'costUsd' | 'summary'>>) => {
    db.prepare(
      `UPDATE runs SET ended_at = ?, exit_code = ?, num_turns = COALESCE(?, num_turns), cost_usd = COALESCE(?, cost_usd),
       summary = COALESCE(?, summary) WHERE id = ?`,
    ).run(f.endedAt ?? null, f.exitCode ?? null, f.numTurns ?? null, f.costUsd ?? null, f.summary ?? null, id)
    return runs.get(id)!
  },
  setResult: (id: string, r: Partial<Pick<Run, 'numTurns' | 'costUsd' | 'summary'>>) => {
    db.prepare('UPDATE runs SET num_turns = ?, cost_usd = ?, summary = ? WHERE id = ?').run(
      r.numTurns ?? null,
      r.costUsd ?? null,
      r.summary ?? null,
      id,
    )
  },
}

export const events = {
  add: (runId: string, e: LogEventInput, ts = Date.now()): LogEvent => {
    const r = db.prepare('INSERT INTO events (run_id, ts, payload) VALUES (?, ?, ?)').run(runId, ts, JSON.stringify(e))
    return { ...e, id: String(r.lastInsertRowid), runId, ts } as LogEvent
  },
  byRun: (runId: string): LogEvent[] =>
    (db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY id').all(runId) as Row[]).map(
      (r) => ({ ...JSON.parse(r.payload as string), id: String(r.id), runId, ts: r.ts as number }) as LogEvent,
    ),
}

// ---------------------------------------------------------------- templates

const toTemplate = (r: Row): PromptTemplate => ({
  id: r.id as string,
  name: r.name as string,
  title: r.title as string,
  prompt: r.prompt as string,
  tags: JSON.parse(r.tags as string),
  projectId: opt(r.project_id),
})

export const templates = {
  all: () => (db.prepare('SELECT * FROM templates ORDER BY created_at, name').all() as Row[]).map(toTemplate),
  get: (id: string) => {
    const r = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as Row | undefined
    return r && toTemplate(r)
  },
  byProject: (projectId: string) =>
    (db.prepare('SELECT * FROM templates WHERE project_id = ?').all(projectId) as Row[]).map(toTemplate),
  /** Thêm mới hoặc cập nhật (giữ nguyên thứ tự created_at khi cập nhật). */
  upsert: (t: PromptTemplate, createdAt = Date.now()) => {
    db.prepare(
      `INSERT INTO templates (id, name, title, prompt, tags, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, title=excluded.title, prompt=excluded.prompt,
         tags=excluded.tags, project_id=excluded.project_id`,
    ).run(t.id, t.name, t.title, t.prompt, JSON.stringify(t.tags), t.projectId ?? null, createdAt)
    return templates.get(t.id)!
  },
  remove: (id: string) => db.prepare('DELETE FROM templates WHERE id = ?').run(id),
}

if (!hasTemplatesTable) {
  const now = Date.now()
  DEFAULT_TEMPLATES.forEach((t, i) => templates.upsert(t, now + i))
}

// ---------------------------------------------------------------- schedules (PLAN 4.6)

const toSchedule = (r: Row): Schedule => ({
  id: r.id as string,
  cron: r.cron as string,
  projectId: r.project_id as string,
  title: r.title as string,
  prompt: r.prompt as string,
  priority: r.priority as Schedule['priority'],
  enabled: !!r.enabled,
  nextRunAt: opt(r.next_run_at),
  lastRunAt: opt(r.last_run_at),
  createdAt: r.created_at as number,
})

const toScheduleRun = (r: Row): ScheduleRun => ({
  id: r.id as number,
  scheduleId: r.schedule_id as string,
  taskId: opt(r.task_id),
  title: r.title as string,
  scheduledFor: r.scheduled_for as number,
  firedAt: r.fired_at as number,
  catchUp: !!r.catch_up,
})

/** Số dòng lịch sử giữ lại cho mỗi lịch. */
export const SCHEDULE_HISTORY_LIMIT = 100

export const schedules = {
  all: () => (db.prepare('SELECT * FROM schedules ORDER BY created_at, id').all() as Row[]).map(toSchedule),
  get: (id: string) => {
    const r = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Row | undefined
    return r && toSchedule(r)
  },
  byProject: (projectId: string) =>
    (db.prepare('SELECT * FROM schedules WHERE project_id = ?').all(projectId) as Row[]).map(toSchedule),
  /** Lịch đang bật đã tới giờ (next_run_at <= now). */
  due: (now: number) =>
    (db.prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at').all(now) as Row[]).map(
      toSchedule,
    ),
  upsert: (s: Schedule) => {
    db.prepare(
      `INSERT INTO schedules (id, cron, project_id, title, prompt, priority, enabled, next_run_at, last_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET cron=excluded.cron, project_id=excluded.project_id, title=excluded.title,
         prompt=excluded.prompt, priority=excluded.priority, enabled=excluded.enabled, next_run_at=excluded.next_run_at,
         last_run_at=excluded.last_run_at`,
    ).run(s.id, s.cron, s.projectId, s.title, s.prompt, s.priority, s.enabled ? 1 : 0, s.nextRunAt ?? null, s.lastRunAt ?? null, s.createdAt)
    return schedules.get(s.id)!
  },
  setTimes: (id: string, t: { nextRunAt: number | null; lastRunAt?: number }) => {
    db.prepare('UPDATE schedules SET next_run_at = ?, last_run_at = COALESCE(?, last_run_at) WHERE id = ?').run(t.nextRunAt, t.lastRunAt ?? null, id)
    return schedules.get(id)
  },
  remove: (id: string) => db.prepare('DELETE FROM schedules WHERE id = ?').run(id),
}

export const scheduleRuns = {
  /** Lịch sử mới nhất trước. */
  bySchedule: (scheduleId: string, limit = SCHEDULE_HISTORY_LIMIT) =>
    (db.prepare('SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT ?').all(scheduleId, limit) as Row[]).map(toScheduleRun),
  add: (r: Omit<ScheduleRun, 'id'>) => {
    const res = db
      .prepare('INSERT INTO schedule_runs (schedule_id, task_id, title, scheduled_for, fired_at, catch_up) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.scheduleId, r.taskId ?? null, r.title, r.scheduledFor, r.firedAt, r.catchUp ? 1 : 0)
    // Chỉ giữ SCHEDULE_HISTORY_LIMIT dòng gần nhất
    db.prepare(
      `DELETE FROM schedule_runs WHERE schedule_id = ? AND id NOT IN
         (SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT ?)`,
    ).run(r.scheduleId, r.scheduleId, SCHEDULE_HISTORY_LIMIT)
    return { ...r, id: Number(res.lastInsertRowid) }
  },
}

// ---------------------------------------------------------------- test runs (FR-34)

const toTestRun = (r: Row): TestRun => ({
  taskId: r.task_id as number,
  command: r.command as string,
  status: r.status as TestStatus,
  startedAt: r.started_at as number,
  endedAt: opt(r.ended_at),
  exitCode: opt(r.exit_code),
  error: opt(r.error),
})

/** Mỗi task chỉ giữ lần chạy test gần nhất (task_id là khoá chính). */
export const testRuns = {
  all: () => (db.prepare('SELECT * FROM test_runs').all() as Row[]).map(toTestRun),
  get: (taskId: number) => {
    const r = db.prepare('SELECT * FROM test_runs WHERE task_id = ?').get(taskId) as Row | undefined
    return r && toTestRun(r)
  },
  output: (taskId: number): TestOutput => {
    const r = db.prepare('SELECT output, output_end FROM test_runs WHERE task_id = ?').get(taskId) as Row | undefined
    return r ? { text: r.output as string, end: r.output_end as number } : { text: '', end: 0 }
  },
  /** Bắt đầu lần chạy mới: ghi đè lần trước. */
  start: (t: Pick<TestRun, 'taskId' | 'command' | 'startedAt'>) => {
    db.prepare(
      `INSERT INTO test_runs (task_id, command, status, started_at) VALUES (?, ?, 'running', ?)
       ON CONFLICT(task_id) DO UPDATE SET command=excluded.command, status='running', started_at=excluded.started_at,
         ended_at=NULL, exit_code=NULL, error=NULL, output='', output_end=0`,
    ).run(t.taskId, t.command, t.startedAt)
    return testRuns.get(t.taskId)!
  },
  finish: (taskId: number, f: Pick<TestRun, 'status' | 'endedAt' | 'exitCode' | 'error'>, out: TestOutput) => {
    db.prepare('UPDATE test_runs SET status = ?, ended_at = ?, exit_code = ?, error = ?, output = ?, output_end = ? WHERE task_id = ?').run(
      f.status,
      f.endedAt ?? null,
      f.exitCode ?? null,
      f.error ?? null,
      out.text,
      out.end,
      taskId,
    )
    return testRuns.get(taskId) // undefined nếu task đã bị xoá trong lúc chạy
  },
  /** Lúc khởi động: lần chạy còn dở (server tắt giữa chừng) chuyển sang error. */
  abortRunning: (reason: string) =>
    db.prepare("UPDATE test_runs SET status = 'error', ended_at = ?, error = ? WHERE status = 'running'").run(Date.now(), reason),
}

// ---------------------------------------------------------------- settings

export const DEFAULT_SETTINGS: Settings = {
  maxParallel: 2,
  browserNotifications: false,
  notifyOn: { review: true, needsInput: true, failed: true },
  permissionTimeoutMin: 30,
  telegram: DEFAULT_TELEGRAM,
}

const getKey = (key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined)?.value as string | undefined
const setKey = (key: string, value: string) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)

/** Bot token Telegram lưu ở khoá riêng, không nằm trong Settings trả ra API (FR-51). */
export const telegramToken = {
  get: (): string | undefined => getKey('telegram_token') || undefined,
  set: (token: string | null) =>
    token ? setKey('telegram_token', token) : db.prepare("DELETE FROM settings WHERE key = 'telegram_token'").run(),
}

export const settings = {
  get: (): Settings => {
    const raw = getKey('app')
    const s: Partial<Settings> = raw ? JSON.parse(raw) : {}
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      telegram: { ...DEFAULT_TELEGRAM, ...s.telegram, hasToken: !!telegramToken.get() },
    }
  },
  set: (s: Settings) => {
    const telegram: Partial<Settings['telegram']> = { ...s.telegram }
    delete telegram.hasToken // chỉ là cờ suy ra từ telegram_token
    setKey('app', JSON.stringify({ ...s, telegram }))
    return settings.get()
  },
}
