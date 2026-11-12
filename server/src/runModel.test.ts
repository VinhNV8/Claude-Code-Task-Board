// P5-01: migration cột model của bảng runs trên DB cũ và đọc/ghi model, model_usage, context_tokens.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// DB "cũ": schema runs trước P5, đã có dữ liệu (phải tạo trước khi import db.ts).
const dir = mkdtempSync(join(tmpdir(), 'taskboard runmodel '))
const file = join(dir, 'old.db')
const old = new DatabaseSync(file)
old.exec(`
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, main_branch TEXT NOT NULL DEFAULT 'main',
  permission_mode TEXT NOT NULL DEFAULT 'acceptEdits', allowed_tools TEXT NOT NULL DEFAULT '[]', max_parallel INTEGER NOT NULL DEFAULT 1);
CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal',
  permission_mode TEXT NOT NULL DEFAULT 'acceptEdits', tags TEXT NOT NULL DEFAULT '[]', branch TEXT, worktree_path TEXT,
  session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, fail_reason TEXT, review_warning TEXT);
CREATE TABLE runs (id TEXT PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  feedback TEXT, session_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, exit_code INTEGER, num_turns INTEGER,
  cost_usd REAL, summary TEXT);
INSERT INTO projects (id, name, repo_path) VALUES ('p', 'P', 'C:\\repo');
INSERT INTO tasks (project_id, title, prompt, status, created_at, updated_at) VALUES ('p', 't', 'x', 'done', 1, 1);
INSERT INTO runs (id, task_id, kind, started_at, ended_at, exit_code, cost_usd) VALUES ('old-run', 1, 'initial', 1, 2, 0, 0.5);
`)
old.close()

process.env.TASKBOARD_DATA = dir
process.env.TASKBOARD_DB = file
const { db, runs } = await import('./db.ts')

test('DB cũ: tự thêm cột mới, run cũ có model = undefined', () => {
  const cols = (db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name)
  for (const c of ['model', 'model_usage', 'model_source', 'model_reason', 'context_tokens']) assert.ok(cols.includes(c), c)
  const r = runs.get('old-run')!
  assert.equal(r.costUsd, 0.5)
  assert.equal(r.model, undefined)
  assert.equal(r.modelUsage, undefined)
  assert.equal(r.contextTokens, undefined)
})

test('setModel, finish ghi modelUsage/contextTokens và giữ giá trị cũ khi thiếu (COALESCE)', () => {
  runs.create({ id: 'r1', taskId: 1, kind: 'initial', startedAt: 10 })
  assert.equal(runs.setModel('r1', 'claude-opus-5-5')?.model, 'claude-opus-5-5')

  const usage = {
    'claude-opus-5-5': { inputTokens: 4, outputTokens: 120, cacheReadInputTokens: 70227, cacheCreationInputTokens: 11952, costUsd: 0.1120774 },
    'claude-haiku-5-5': { inputTokens: 1228, outputTokens: 173, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0.0002093 },
  }
  const r = runs.finish('r1', { endedAt: 20, exitCode: 0, costUsd: 0.1122867, modelUsage: usage, contextTokens: 41229 })
  assert.equal(r.model, 'claude-opus-5-5')
  assert.deepEqual(r.modelUsage, usage)
  assert.equal(r.contextTokens, 41229)

  // Kết thúc lại không kèm dữ liệu (ví dụ dọn run lúc khởi động) thì không xoá
  const again = runs.finish('r1', { endedAt: 30, exitCode: -1 })
  assert.deepEqual(again.modelUsage, usage)
  assert.equal(again.contextTokens, 41229)

  const c = runs.setModelChoice('r1', { modelSource: 'auto', modelReason: 'điểm 0 → sonnet' })
  assert.equal(c?.modelSource, 'auto')
  assert.equal(c?.modelReason, 'điểm 0 → sonnet')
})
