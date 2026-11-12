import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// DB riêng trong bộ nhớ cho test (phải đặt trước khi import db.ts)
process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard-rulesug-'))
process.env.TASKBOARD_DB = ':memory:'
const { db, projects, tasks } = await import('./db.ts')
const { bus, broadcast } = await import('./bus.ts')
const { suggestRules, dismissRule, dismissedRules, ruleSuggestionsFor, watchRuleSuggestions, MAX_SUGGESTIONS } = await import('./ruleSuggestions.ts')
type HistoryItem = import('./ruleSuggestions.ts').HistoryItem

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const bash = (command: string, status: HistoryItem['status'] = 'allowed', createdAt = NOW): HistoryItem => ({
  tool: 'Bash',
  input: { command },
  status,
  createdAt,
})
const times = (n: number, command: string, status: HistoryItem['status'] = 'allowed') =>
  Array.from({ length: n }, (_, i) => bash(command, status, NOW + i))

test('3 lần cho phép → gợi ý, kèm số lần, thời điểm và ví dụ gần nhất', () => {
  const r = suggestRules([bash('npm install', 'allowed', NOW), bash('npm install lodash', 'allowed', NOW + 5), bash('npm install -D x', 'allowed', NOW + 1)], [], [])
  assert.deepEqual(r, [{ rule: 'Bash(npm install:*)', count: 3, lastAt: NOW + 5, example: 'npm install lodash' }])
})

test('2 lần cho phép → chưa gợi ý', () => {
  assert.deepEqual(suggestRules(times(2, 'npm install'), [], []), [])
})

test('có 1 lần từ chối → không gợi ý', () => {
  assert.deepEqual(suggestRules([...times(5, 'npm install'), bash('npm install evil', 'denied')], [], []), [])
})

test('đã có trong allowlist → không gợi ý', () => {
  assert.deepEqual(suggestRules(times(3, 'npm install'), ['Read', 'Bash(npm install:*)'], []), [])
})

test('đã bị bỏ qua → không gợi ý', () => {
  assert.deepEqual(suggestRules(times(3, 'npm install'), [], ['Bash(npm install:*)']), [])
})

test('lệnh có $(...) (rủi ro) → không tính, không gợi ý', () => {
  assert.deepEqual(suggestRules(times(3, 'echo $(whoami)'), [], []), [])
  // Lệnh rủi ro không được tính bù vào số lần của lệnh an toàn cùng rule
  assert.deepEqual(suggestRules([...times(2, 'echo hi'), bash('echo $(whoami)')], [], []), [])
})

test('lệnh bị P7-04 đánh dấu rủi ro cao (git push) → không gợi ý', () => {
  assert.deepEqual(suggestRules(times(5, 'git push origin main'), [], []), [])
})

test('lệnh ghép `npm test && npm run lint` tạo hai rule riêng', () => {
  const r = suggestRules(times(3, 'npm test && npm run lint'), [], [])
  assert.deepEqual(r.map((s) => s.rule).sort(), ['Bash(npm run:*)', 'Bash(npm test:*)'])
  assert.ok(r.every((s) => s.count === 3 && s.example === 'npm test && npm run lint'))
  // Một rule đã có trong allowlist thì chỉ còn gợi ý rule kia
  assert.deepEqual(suggestRules(times(3, 'npm test && npm run lint'), ['Bash(npm test:*)'], []).map((s) => s.rule), ['Bash(npm run:*)'])
})

test('từ chối lệnh ghép chặn mọi rule nó sinh ra', () => {
  const r = suggestRules([...times(3, 'npm test'), ...times(3, 'npm run lint'), bash('npm test; npm run build', 'denied')], [], [])
  assert.deepEqual(r, [])
})

test('bỏ qua timeout và pending; tool không phải Bash cũng được gợi ý', () => {
  const web = (status: HistoryItem['status']): HistoryItem => ({ tool: 'WebFetch', input: { url: 'https://x.dev' }, status, createdAt: NOW })
  assert.deepEqual(suggestRules([web('allowed'), web('allowed'), web('timeout'), web('pending')], [], []), [])
  assert.deepEqual(suggestRules([web('allowed'), web('allowed'), web('allowed'), web('timeout')], [], []).map((s) => s.rule), ['WebFetch'])
})

test('sắp theo số lần giảm dần, tối đa 10', () => {
  const hist = Array.from({ length: 12 }, (_, i) => times(3 + i, `tool${i} run`)).flat()
  const r = suggestRules(hist, [], [])
  assert.equal(r.length, MAX_SUGGESTIONS)
  assert.equal(r[0].rule, 'Bash(tool11:*)')
  assert.equal(r[0].count, 14)
  assert.ok(r.every((s, i) => i === 0 || r[i - 1].count >= s.count))
})

// ---------------------------------------------------------------- đọc DB

projects.upsert({
  id: 'p1',
  name: 'P1',
  repoPath: process.env.TASKBOARD_DATA!,
  mainBranch: 'main',
  permissionMode: 'acceptEdits',
  allowedTools: ['Read'],
  maxParallel: 1,
  budgetAction: 'warn',
})
projects.upsert({ ...projects.get('p1')!, id: 'p2', name: 'P2' })

let seq = 0
function addRequest(projectId: string, command: string, status: string, createdAt: number) {
  const t = tasks.create({ projectId, title: 't', prompt: 'x', status: 'done', priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
  db.prepare(
    `INSERT INTO permission_requests (id, task_id, tool, input_json, status, created_at, timeout_at) VALUES (?, ?, 'Bash', ?, ?, ?, ?)`,
  ).run(`perm-${++seq}`, t.id, JSON.stringify({ command }), status, createdAt, createdAt + 60_000)
  return t
}

test('DB: chỉ lấy request của đúng project trong 30 ngày gần nhất', () => {
  const now = Date.now()
  addRequest('p1', 'pytest', 'allowed', now - DAY)
  addRequest('p1', 'pytest -x', 'allowed', now - 2 * DAY)
  addRequest('p1', 'pytest', 'allowed', now - 31 * DAY) // quá 30 ngày
  addRequest('p2', 'pytest', 'allowed', now - DAY) // project khác
  assert.deepEqual(ruleSuggestionsFor(projects.get('p1')!), [])

  addRequest('p1', 'pytest tests/a.py', 'allowed', now - 3 * DAY)
  const r = ruleSuggestionsFor(projects.get('p1')!)
  assert.deepEqual(r.map((s) => [s.rule, s.count, s.example]), [['Bash(pytest:*)', 3, 'pytest']])
})

test('DB: bỏ qua lưu vào settings theo project, không trùng lặp', () => {
  dismissRule('p1', 'Bash(pytest:*)')
  dismissRule('p1', 'Bash(pytest:*)')
  assert.deepEqual(dismissedRules('p1'), ['Bash(pytest:*)'])
  assert.deepEqual(dismissedRules('p2'), [])
  assert.deepEqual(ruleSuggestionsFor(projects.get('p1')!), [])
})

test('watch: quyết định quyền hoặc sửa project → broadcast gợi ý mới của project đó', () => {
  watchRuleSuggestions()
  const got: unknown[] = []
  const on = (m: { type: string }) => m.type === 'rule_suggestions' && got.push(m)
  bus.on('message', on)
  try {
    const now = Date.now()
    addRequest('p2', 'make all', 'allowed', now - 1)
    addRequest('p2', 'make test', 'allowed', now - 2)
    const t = addRequest('p2', 'make', 'allowed', now - 3)
    broadcast({
      type: 'permission',
      permission: { id: 'perm-x', taskId: t.id, tool: 'Bash', input: 'make', createdAt: now, timeoutAt: now, status: 'allowed' },
    })
    assert.deepEqual(got.at(-1), {
      type: 'rule_suggestions',
      projectId: 'p2',
      suggestions: [{ rule: 'Bash(make:*)', count: 3, lastAt: now - 1, example: 'make all' }],
    })
    const saved = projects.upsert({ ...projects.get('p2')!, allowedTools: ['Bash(make:*)'] })
    broadcast({ type: 'project', project: saved })
    assert.deepEqual(got.at(-1), { type: 'rule_suggestions', projectId: 'p2', suggestions: [] })
  } finally {
    bus.off('message', on)
  }
})
