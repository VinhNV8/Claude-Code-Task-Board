// SQLite (node:sqlite có sẵn trong Node 24), schema theo SPEC Mục 5.2.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  LogEvent,
  LogEventInput,
  Project,
  PromptTemplate,
  ReviewAction,
  ReviewComment,
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
import { decryptSecret, encryptSecret, loadOrCreateKey } from './secretBox.ts'
import { defaultAuthMode, effectiveApiKey, publicAuth } from './claudeAuth.ts'

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

// PLAN 2.5: feedback "Yêu cầu sửa" chờ chạy khi hết slot. Lưu trên task (cột riêng) cho đơn giản:
// pump() thấy cột này thì chạy resume với feedback rồi xoá cột; không cần tạo run "treo" chưa chạy.
const taskCols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
if (!taskCols.some((c) => c.name === 'pending_feedback')) db.exec('ALTER TABLE tasks ADD COLUMN pending_feedback TEXT')
// Rate limit (PLAN > Rủi ro chung): task tự đưa lại hàng đợi chỉ chạy từ not_before; đếm số lần đã tự thử lại.
if (!taskCols.some((c) => c.name === 'not_before')) db.exec('ALTER TABLE tasks ADD COLUMN not_before INTEGER')
if (!taskCols.some((c) => c.name === 'rate_limit_retries'))
  db.exec('ALTER TABLE tasks ADD COLUMN rate_limit_retries INTEGER NOT NULL DEFAULT 0')
// Resume: task Queued chờ chạy tiếp phiên cũ (Tiếp tục khi hết slot, hoặc tự đưa lại hàng đợi do giới hạn sử dụng).
// Mode direct: snapshot thư mục project trước run đầu tiên (git tree hash trong kho snapshot riêng).
if (!taskCols.some((c) => c.name === 'base_ref')) db.exec('ALTER TABLE tasks ADD COLUMN base_ref TEXT')
if (!taskCols.some((c) => c.name === 'head_ref')) db.exec('ALTER TABLE tasks ADD COLUMN head_ref TEXT')
if (!taskCols.some((c) => c.name === 'resume_next')) db.exec('ALTER TABLE tasks ADD COLUMN resume_next INTEGER NOT NULL DEFAULT 0')

// G3: nhận xét theo file/dòng gửi kèm "Request changes" (JSON ReviewComment[]).
const reviewCols = db.prepare('PRAGMA table_info(reviews)').all() as { name: string }[]
if (!reviewCols.some((c) => c.name === 'comments')) db.exec('ALTER TABLE reviews ADD COLUMN comments TEXT')

// FR-34: lệnh test của project (DB cũ chưa có cột) và lần chạy test gần nhất của mỗi task.
const projectCols = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]
// Cách giao output. Project cũ giữ worktree (task đang dở có worktree); project mới mặc định direct.
if (!projectCols.some((c) => c.name === 'delivery_mode'))
  db.exec("ALTER TABLE projects ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'worktree'")
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

// P5-01: model thực tế và chi phí theo model của từng run (D8). model_source/model_reason dùng từ P5-03/P5-04.
const runCols = db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]
for (const [col, type] of [
  ['model', 'TEXT'],
  ['model_usage', 'TEXT'],
  ['model_source', 'TEXT'],
  ['model_reason', 'TEXT'],
  ['context_tokens', 'INTEGER'],
  // P5-03: giá trị đã truyền vào `--model` (alias/ID); run resume/continue dùng lại (D3).
  ['requested_model', 'TEXT'],
  // P5-06: 'claude' | 'stopped' | 'rate_limit' | 'infra' — Retry chỉ tự nâng model khi run trước lỗi do Claude (D6).
  ['fail_kind', 'TEXT'],
] as const)
  if (!runCols.some((c) => c.name === col)) db.exec(`ALTER TABLE runs ADD COLUMN ${col} ${type}`)
// P5-03: cấu hình model 3 tầng (D2). NULL/'' = kế thừa tầng dưới.
if (!taskCols.some((c) => c.name === 'model')) db.exec('ALTER TABLE tasks ADD COLUMN model TEXT')
if (!projectCols.some((c) => c.name === 'default_model')) db.exec('ALTER TABLE projects ADD COLUMN default_model TEXT')
// P6 (B1): budget tháng theo project (NULL = không giới hạn) và hành động khi vượt.
if (!projectCols.some((c) => c.name === 'monthly_budget_usd')) db.exec('ALTER TABLE projects ADD COLUMN monthly_budget_usd REAL')
if (!projectCols.some((c) => c.name === 'budget_action'))
  db.exec("ALTER TABLE projects ADD COLUMN budget_action TEXT NOT NULL DEFAULT 'warn'")
// Giới hạn chi phí mỗi lần chạy (`--max-budget-usd`).
if (!taskCols.some((c) => c.name === 'max_cost_usd')) db.exec('ALTER TABLE tasks ADD COLUMN max_cost_usd REAL')
// P7-05 (FR-46): lý do người dùng nhập khi Từ chối, gửi kèm message deny cho Claude.
const permCols = db.prepare('PRAGMA table_info(permission_requests)').all() as { name: string }[]
if (!permCols.some((c) => c.name === 'deny_reason')) db.exec('ALTER TABLE permission_requests ADD COLUMN deny_reason TEXT')
// C-02 (FR-08): phụ thuộc giữa task. Xoá task nào thì liên kết của nó tự mất.
db.exec(`
CREATE TABLE IF NOT EXISTS task_deps (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_task_deps_on ON task_deps(depends_on_id);
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
  defaultModel: (r.default_model as string | null) || undefined,
  monthlyBudgetUsd: (r.monthly_budget_usd as number | null) ?? undefined,
  budgetAction: r.budget_action === 'pause' ? 'pause' : 'warn',
  deliveryMode: r.delivery_mode === 'direct' ? 'direct' : 'worktree',
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
  baseRef: opt(r.base_ref),
  headRef: opt(r.head_ref),
  sessionId: opt(r.session_id),
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
  startedAt: opt(r.started_at),
  failReason: opt(r.fail_reason),
  reviewWarning: opt(r.review_warning),
  pendingFeedback: opt(r.pending_feedback),
  notBefore: opt(r.not_before),
  rateLimitRetries: (r.rate_limit_retries as number | null) || undefined,
  resumeNext: r.resume_next ? true : undefined,
  model: (r.model as string | null) || undefined,
  maxCostUsd: (r.max_cost_usd as number | null) ?? undefined,
  dependsOn: optList(depsOf(r.id as number)),
})

const optList = (l: number[]) => (l.length ? l : undefined)

/** Danh sách task mà task này chờ (FR-08), tăng dần theo id. */
function depsOf(taskId: number): number[] {
  return (db.prepare('SELECT depends_on_id FROM task_deps WHERE task_id = ? ORDER BY depends_on_id').all(taskId) as { depends_on_id: number }[]).map(
    (r) => r.depends_on_id,
  )
}

export const taskDeps = {
  of: depsOf,
  /** Các task đang chờ task này. */
  dependents: (taskId: number) =>
    (db.prepare('SELECT task_id FROM task_deps WHERE depends_on_id = ? ORDER BY task_id').all(taskId) as { task_id: number }[]).map((r) => r.task_id),
  /** Thay toàn bộ danh sách chờ của task (đã kiểm tra hợp lệ ở tầng trên). */
  set: (taskId: number, deps: number[]) => {
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM task_deps WHERE task_id = ?').run(taskId)
      const ins = db.prepare('INSERT OR IGNORE INTO task_deps (task_id, depends_on_id) VALUES (?, ?)')
      for (const d of deps) ins.run(taskId, d)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
}

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
  model: opt(r.model),
  modelUsage: parseModelUsage(r.model_usage),
  modelSource: opt(r.model_source),
  modelReason: opt(r.model_reason),
  requestedModel: opt(r.requested_model),
  contextTokens: opt(r.context_tokens),
  failKind: opt(r.fail_kind),
})

function parseModelUsage(v: unknown): Run['modelUsage'] {
  if (typeof v !== 'string' || !v) return undefined
  try {
    return JSON.parse(v)
  } catch {
    return undefined
  }
}

const usageJson = (u: Run['modelUsage']) => (u ? JSON.stringify(u) : null)

// ---------------------------------------------------------------- projects

export const projects = {
  all: () => (db.prepare('SELECT * FROM projects ORDER BY name').all() as Row[]).map(toProject),
  get: (id: string) => {
    const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
    return r && toProject(r)
  },
  upsert: (p: Project) => {
    db.prepare(
      `INSERT INTO projects (id, name, repo_path, main_branch, permission_mode, allowed_tools, max_parallel, test_command, default_model,
         monthly_budget_usd, budget_action, delivery_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, repo_path=excluded.repo_path, main_branch=excluded.main_branch,
         permission_mode=excluded.permission_mode, allowed_tools=excluded.allowed_tools, max_parallel=excluded.max_parallel,
         test_command=excluded.test_command, default_model=excluded.default_model,
         monthly_budget_usd=excluded.monthly_budget_usd, budget_action=excluded.budget_action,
         delivery_mode=excluded.delivery_mode`,
    ).run(
      p.id,
      p.name,
      p.repoPath,
      p.mainBranch,
      p.permissionMode,
      JSON.stringify(p.allowedTools),
      p.maxParallel,
      p.testCommand || null,
      p.defaultModel || null,
      p.monthlyBudgetUsd ?? null,
      p.budgetAction === 'pause' ? 'pause' : 'warn',
      p.deliveryMode === 'direct' ? 'direct' : 'worktree',
    )
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
  baseRef: 'base_ref',
  headRef: 'head_ref',
  sessionId: 'session_id',
  startedAt: 'started_at',
  failReason: 'fail_reason',
  reviewWarning: 'review_warning',
  pendingFeedback: 'pending_feedback',
  notBefore: 'not_before',
  rateLimitRetries: 'rate_limit_retries',
  resumeNext: 'resume_next',
  model: 'model',
  maxCostUsd: 'max_cost_usd',
}

/** Cột NOT NULL kiểu cờ: `null`/`false` lưu thành 0. */
const FLAG_COLS = new Set(['resumeNext'])

export const tasks = {
  all: () => (db.prepare('SELECT * FROM tasks').all() as Row[]).map(toTask),
  get: (id: number) => {
    const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined
    return r && toTask(r)
  },
  byStatus: (...st: TaskStatus[]) =>
    (db.prepare(`SELECT * FROM tasks WHERE status IN (${st.map(() => '?').join(',')})`).all(...st) as Row[]).map(toTask),
  create: (
    t: Pick<Task, 'projectId' | 'title' | 'prompt' | 'status' | 'priority' | 'permissionMode' | 'tags'> & Pick<Partial<Task>, 'model' | 'maxCostUsd'>,
  ) => {
    const now = Date.now()
    const r = db
      .prepare(
        `INSERT INTO tasks (project_id, title, prompt, status, priority, permission_mode, tags, model, max_cost_usd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.projectId,
        t.title,
        t.prompt,
        t.status,
        t.priority,
        t.permissionMode,
        JSON.stringify(t.tags),
        t.model || null,
        t.maxCostUsd ?? null,
        now,
        now,
      )
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
      if (FLAG_COLS.has(k)) vals.push(v ? 1 : 0)
      else vals.push(k === 'tags' ? JSON.stringify(v) : v === undefined ? null : (v as string | number | null))
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
  create: (
    r: Pick<Run, 'id' | 'taskId' | 'kind' | 'feedback' | 'sessionId' | 'startedAt'> &
      Partial<Pick<Run, 'requestedModel' | 'modelSource' | 'modelReason'>>,
  ) => {
    db.prepare(
      `INSERT INTO runs (id, task_id, kind, feedback, session_id, started_at, requested_model, model_source, model_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.id,
      r.taskId,
      r.kind,
      r.feedback ?? null,
      r.sessionId ?? null,
      r.startedAt,
      r.requestedModel ?? null,
      r.modelSource ?? null,
      r.modelReason ?? null,
    )
    return runs.get(r.id)!
  },
  finish: (
    id: string,
    f: Pick<Run, 'endedAt' | 'exitCode'> & Partial<Pick<Run, 'numTurns' | 'costUsd' | 'summary' | 'modelUsage' | 'contextTokens'>>,
  ) => {
    db.prepare(
      `UPDATE runs SET ended_at = ?, exit_code = ?, num_turns = COALESCE(?, num_turns), cost_usd = COALESCE(?, cost_usd),
       summary = COALESCE(?, summary), model_usage = COALESCE(?, model_usage), context_tokens = COALESCE(?, context_tokens)
       WHERE id = ?`,
    ).run(
      f.endedAt ?? null,
      f.exitCode ?? null,
      f.numTurns ?? null,
      f.costUsd ?? null,
      f.summary ?? null,
      usageJson(f.modelUsage),
      f.contextTokens ?? null,
      id,
    )
    return runs.get(id)!
  },
  setResult: (id: string, r: Partial<Pick<Run, 'numTurns' | 'costUsd' | 'summary' | 'modelUsage' | 'contextTokens'>>) => {
    db.prepare(
      `UPDATE runs SET num_turns = ?, cost_usd = ?, summary = ?, model_usage = COALESCE(?, model_usage),
       context_tokens = COALESCE(?, context_tokens) WHERE id = ?`,
    ).run(r.numTurns ?? null, r.costUsd ?? null, r.summary ?? null, usageJson(r.modelUsage), r.contextTokens ?? null, id)
  },
  /** Ghi model thực tế ngay khi nhận event `init` để UI thấy trong lúc task đang chạy. */
  setModel: (id: string, model: string) => {
    db.prepare('UPDATE runs SET model = ? WHERE id = ?').run(model, id)
    return runs.get(id)
  },
  /** P5-06: loại thất bại của run (Stop, giới hạn sử dụng, hạ tầng hay lỗi do Claude). */
  setFailKind: (id: string, failKind: NonNullable<Run['failKind']>) => {
    db.prepare('UPDATE runs SET fail_kind = ? WHERE id = ?').run(failKind, id)
    return runs.get(id)
  },
  /** Số lần "Yêu cầu sửa" của task (D6: từ lần thứ 2 thì tự nâng model). */
  requestChangesCount: (taskId: number) =>
    (db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE task_id = ? AND action = 'request_changes'").get(taskId) as Row).n as number,
  /** Nguồn và lý do chọn model (P5-03/P5-04). */
  setModelChoice: (id: string, c: Pick<Run, 'modelSource' | 'modelReason'>) => {
    db.prepare('UPDATE runs SET model_source = ?, model_reason = ? WHERE id = ?').run(c.modelSource ?? null, c.modelReason ?? null, id)
    return runs.get(id)
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

// ---------------------------------------------------------------- reviews (PLAN 2.8)

const toReview = (r: Row): ReviewAction => ({
  id: r.id as string,
  taskId: r.task_id as number,
  action: r.action as ReviewAction['action'],
  feedback: opt(r.feedback),
  comments: r.comments ? (JSON.parse(r.comments as string) as ReviewComment[]) : undefined,
  createdAt: r.created_at as number,
})

export const reviews = {
  all: () => (db.prepare('SELECT * FROM reviews ORDER BY created_at, rowid').all() as Row[]).map(toReview),
  byTask: (taskId: number) =>
    (db.prepare('SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at, rowid').all(taskId) as Row[]).map(toReview),
  add: (r: Pick<ReviewAction, 'taskId' | 'action' | 'feedback' | 'comments'> & { id?: string; createdAt?: number }): ReviewAction => {
    const review: ReviewAction = {
      id: r.id ?? randomUUID(),
      taskId: r.taskId,
      action: r.action,
      feedback: r.feedback || undefined,
      comments: r.comments?.length ? r.comments : undefined,
      createdAt: r.createdAt ?? Date.now(),
    }
    db.prepare('INSERT INTO reviews (id, task_id, action, feedback, comments, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      review.id,
      review.taskId,
      review.action,
      review.feedback ?? null,
      review.comments ? JSON.stringify(review.comments) : null,
      review.createdAt,
    )
    return review
  },
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
  // D2: 'auto' = bộ chọn model (P5-04); '' = không truyền --model. DB cũ chưa lưu key này cũng nhận 'auto'.
  defaultModel: 'auto',
  autoEscalate: true,
  telegram: DEFAULT_TELEGRAM,
  auth: { mode: defaultAuthMode(), hasApiKey: false, envApiKey: false },
}

const getKey = (key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined)?.value as string | undefined
const setKey = (key: string, value: string) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)

/** Khoá/giá trị tự do trong bảng settings (ví dụ `budgetAlert:<projectId>:<YYYY-MM>`, P6 B2). */
export const kv = {
  get: getKey,
  set: (key: string, value: string) => void setKey(key, value),
}

/** Bot token Telegram lưu ở khoá riêng, không nằm trong Settings trả ra API (FR-51). */
export const telegramToken = {
  get: (): string | undefined => getKey('telegram_token') || undefined,
  set: (token: string | null) =>
    token ? setKey('telegram_token', token) : db.prepare("DELETE FROM settings WHERE key = 'telegram_token'").run(),
}

/**
 * API key Claude (chế độ apiKey) lưu ở khoá riêng, mã hoá AES-256-GCM (secretBox.ts), không nằm trong Settings trả ra API.
 * Khoá mã hoá chỉ được tạo/đọc khi thật sự lưu hoặc dùng key.
 */
let secretKey: Buffer | undefined
const boxKey = () => (secretKey ??= loadOrCreateKey(DATA_DIR))

export const claudeApiKey = {
  /** Key đã lưu (đã giải mã). Không giải mã được (đổi khoá mã hoá) thì coi như chưa có. */
  get: (): string | undefined => {
    const box = getKey('claude_api_key')
    if (!box) return undefined
    try {
      return decryptSecret(box, boxKey())
    } catch (e) {
      console.error(`[auth] ${(e as Error).message}`)
      return undefined
    }
  },
  set: (key: string | null) =>
    key ? setKey('claude_api_key', encryptSecret(key, boxKey())) : db.prepare("DELETE FROM settings WHERE key = 'claude_api_key'").run(),
  /** Key dùng cho lần chạy: biến môi trường TASKBOARD_ANTHROPIC_API_KEY ưu tiên hơn key đã lưu. */
  effective: (): string | undefined => effectiveApiKey(claudeApiKey.get()),
}

export const settings = {
  get: (): Settings => {
    const raw = getKey('app')
    const s: Partial<Settings> = raw ? JSON.parse(raw) : {}
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      telegram: { ...DEFAULT_TELEGRAM, ...s.telegram, hasToken: !!telegramToken.get() },
      auth: publicAuth(s.auth?.mode ?? DEFAULT_SETTINGS.auth.mode, claudeApiKey.get()),
    }
  },
  set: (s: Settings) => {
    const telegram: Partial<Settings['telegram']> = { ...s.telegram }
    delete telegram.hasToken // chỉ là cờ suy ra từ telegram_token
    // auth chỉ lưu chế độ; các cờ về key suy ra lúc đọc
    setKey('app', JSON.stringify({ ...s, telegram, auth: { mode: s.auth.mode } }))
    return settings.get()
  },
}
