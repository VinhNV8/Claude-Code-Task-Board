// SQLite (node:sqlite có sẵn trong Node 24), schema theo SPEC Mục 5.2.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { LogEvent, LogEventInput, Project, Run, Settings, Task, TaskStatus } from './types.ts'

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
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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
      `INSERT INTO projects (id, name, repo_path, main_branch, permission_mode, allowed_tools, max_parallel)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, repo_path=excluded.repo_path, main_branch=excluded.main_branch,
         permission_mode=excluded.permission_mode, allowed_tools=excluded.allowed_tools, max_parallel=excluded.max_parallel`,
    ).run(p.id, p.name, p.repoPath, p.mainBranch, p.permissionMode, JSON.stringify(p.allowedTools), p.maxParallel)
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

// ---------------------------------------------------------------- settings

export const DEFAULT_SETTINGS: Settings = {
  maxParallel: 2,
  browserNotifications: false,
  notifyOn: { review: true, needsInput: true, failed: true },
  permissionTimeoutMin: 30,
}

export const settings = {
  get: (): Settings => {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as Row | undefined
    return r ? { ...DEFAULT_SETTINGS, ...JSON.parse(r.value as string) } : DEFAULT_SETTINGS
  },
  set: (s: Settings) => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      JSON.stringify(s),
    )
    return s
  },
}
