// M2 (SPEC-MULTI-AGENT FR-91/92/93/95): chọn agent 3 tầng qua API thật, kiểm tra mức quyền theo năng lực agent,
// run ghi agent thực tế. "Codex" là agent giả (node.exe) chỉ hỗ trợ acceptEdits/plan.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'taskboard agents '))
process.env.TASKBOARD_DATA = root
process.env.TASKBOARD_DB = ':memory:'
const dir = join(root, 'proj b')
mkdirSync(dir)

const { projects, runs, settings, tasks } = await import('../db.ts')
const { removeAdapterForTest, setAdapterForTest } = await import('./index.ts')
const { resolveAgent, parseAgent, agentModeProblem } = await import('../../../web/src/lib/agent.ts')
const { routes } = await import('../routes.ts')
const { default: Fastify } = await import('fastify')
import type { AgentAdapter } from './types.ts'
import type { AgentInfo, Project, Settings, Task } from '../types.ts'

const app = Fastify()
await app.register(routes)
after(async () => {
  setAdapterForTest('codex')
  await app.close()
})

const fakeCodex: AgentAdapter = {
  id: 'codex',
  name: 'Codex',
  label: 'OpenAI Codex',
  capabilities: { interactivePermission: false, askUser: false, resume: true, costUsd: false, hardBudget: false, permissionModes: ['acceptEdits', 'plan'] },
  findBin: () => ({ path: process.execPath, source: 'test', version: '0.0.0-test' }),
  missingBinReason: 'không có',
  prepare: (o) => ({ ok: true, args: ['-e', `console.log('RESULT done')`], env: process.env, stdin: o.prompt, cleanup: () => {} }),
  createParser: () => ({
    parseLine: (line: string) =>
      line.startsWith('RESULT ') ? { events: [], result: { isError: false, text: line.slice(7), permissionDenials: [] } } : { events: [] },
  }),
  isMissingSession: () => false,
  detectRateLimit: () => undefined,
  onSuccess: () => {},
  onRateLimit: () => {},
  failureHint: () => undefined,
}

async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object) {
  const res = await app.inject({ method, url, payload })
  return { status: res.statusCode, body: res.json() as T & { error?: string } }
}

projects.upsert({
  id: 'pb',
  name: 'PB',
  repoPath: dir,
  mainBranch: 'main',
  permissionMode: 'manual',
  allowedTools: [],
  maxParallel: 2,
  budgetAction: 'warn' as const,
  deliveryMode: 'direct' as const,
})

const taskBody = (o: object = {}) => ({ projectId: 'pb', title: 'T', prompt: 'Làm việc gì đó đủ dài', ...o })

test('resolveAgent / parseAgent / agentModeProblem: thứ tự kế thừa, giá trị rỗng, giá trị lạ', () => {
  assert.equal(resolveAgent(undefined, undefined, undefined), 'claude')
  assert.equal(resolveAgent({}, { defaultAgent: 'codex' }, { defaultAgent: 'claude' }), 'codex')
  assert.equal(resolveAgent({ agent: 'cursor' }, { defaultAgent: 'codex' }, { defaultAgent: 'claude' }), 'cursor')
  assert.equal(resolveAgent({}, {}, { defaultAgent: 'antigravity' }), 'antigravity')
  assert.equal(parseAgent(''), undefined)
  assert.equal(parseAgent(null), undefined)
  assert.equal(parseAgent('codex'), 'codex')
  assert.equal(parseAgent('gpt'), null)
  assert.equal(agentModeProblem(undefined, 'manual'), undefined)
  assert.equal(agentModeProblem({ supported: false, permissionModes: [] }, 'plan'), 'unsupported')
  assert.equal(agentModeProblem({ supported: true, permissionModes: ['plan'] }, 'manual'), 'mode')
  assert.equal(agentModeProblem({ supported: true, permissionModes: ['plan'] }, 'plan'), undefined)
})

test('GET /api/agents: đủ 4 agent; Claude được hỗ trợ; agent chưa có adapter bị đánh dấu chưa hỗ trợ', async () => {
  const { status, body } = await api<AgentInfo[]>('GET', '/api/agents')
  assert.equal(status, 200)
  assert.deepEqual(body.map((a) => a.id), ['claude', 'codex', 'antigravity', 'cursor'])
  const claude = body.find((a) => a.id === 'claude')!
  assert.equal(claude.supported, true)
  assert.deepEqual([...claude.permissionModes].sort(), ['acceptEdits', 'auto', 'manual', 'plan'])
  assert.equal(body.find((a) => a.id === 'codex')!.supported, true, 'Codex đã có adapter (M3)')
  assert.equal(body.find((a) => a.id === 'antigravity')!.supported, true, 'Antigravity đã có adapter (M5)')
  for (const id of ['cursor']) {
    const a = body.find((x) => x.id === id)!
    assert.equal(a.supported, false, id)
    assert.equal(a.installed, false, id)
  }
  const state = await api<{ agents: AgentInfo[] }>('GET', '/api/state')
  assert.equal(state.body.agents.length, 4)
})

test('agent chưa có adapter: không tạo được task, không đặt làm mặc định của project / hệ thống', async () => {
  const t = await api('POST', '/api/tasks', taskBody({ agent: 'cursor' }))
  assert.equal(t.status, 400)
  assert.match(t.body.error!, /chưa hỗ trợ chạy task bằng Cursor/)
  const bad = await api('POST', '/api/tasks', taskBody({ agent: 'gpt' }))
  assert.equal(bad.status, 400)
  assert.match(bad.body.error!, /Agent không hợp lệ/)
  const p = await api('POST', '/api/projects', { ...projects.get('pb'), defaultAgent: 'cursor' })
  assert.equal(p.status, 400)
  const s = await api('PUT', '/api/settings', { defaultAgent: 'cursor' })
  assert.equal(s.status, 400)
  assert.equal(settings.get().defaultAgent, 'claude')
})

test('agent có adapter nhưng không hỗ trợ mức quyền: báo lỗi; đúng mức quyền thì tạo được và lưu agent', async () => {
  setAdapterForTest('codex', fakeCodex)
  // project mặc định manual → task kế thừa manual, Codex giả không hỗ trợ
  const manual = await api('POST', '/api/tasks', taskBody({ agent: 'codex' }))
  assert.equal(manual.status, 400)
  assert.match(manual.body.error!, /Codex không hỗ trợ mức quyền "manual"/)
  const ok = await api<Task>('POST', '/api/tasks', taskBody({ agent: 'codex', permissionMode: 'acceptEdits' }))
  assert.equal(ok.status, 200, ok.body.error)
  assert.equal(ok.body.agent, 'codex')
  assert.equal(tasks.get(ok.body.id)!.agent, 'codex')
  // Không chọn agent: kế thừa (Claude), lưu rỗng
  const inherit = await api<Task>('POST', '/api/tasks', taskBody())
  assert.equal(inherit.status, 200)
  assert.equal(inherit.body.agent, undefined)
})

test('PATCH: đổi agent kiểm tra mức quyền, gửi rỗng = về kế thừa', async () => {
  setAdapterForTest('codex', fakeCodex)
  // Mức quyền `plan` cũ được tách thành planMode 'only' + mức quyền theo project (SPEC-PLAN-HANDOFF A5): chọn rõ acceptEdits.
  const t = (await api<Task>('POST', '/api/tasks', taskBody({ permissionMode: 'acceptEdits', planMode: 'only' }))).body
  assert.equal(t.planMode, 'only')
  const toCodex = await api<Task>('PATCH', `/api/tasks/${t.id}`, { agent: 'codex' })
  assert.equal(toCodex.status, 200, toCodex.body.error)
  assert.equal(toCodex.body.agent, 'codex')
  const badMode = await api('PATCH', `/api/tasks/${t.id}`, { permissionMode: 'auto' })
  assert.equal(badMode.status, 400)
  assert.match(badMode.body.error!, /không hỗ trợ mức quyền "auto"/)
  const back = await api<Task>('PATCH', `/api/tasks/${t.id}`, { agent: '' })
  assert.equal(back.status, 200)
  assert.equal(back.body.agent, undefined)
  assert.equal(tasks.get(t.id)!.agent, undefined)
})

test('project và hệ thống: agent mặc định lưu được, kiểm tra theo mức quyền mặc định của project', async () => {
  setAdapterForTest('codex', fakeCodex)
  const pManual = await api('POST', '/api/projects', { ...projects.get('pb'), defaultAgent: 'codex' })
  assert.equal(pManual.status, 400, 'project mặc định manual mà Codex giả không hỗ trợ')
  const p = await api<Project>('POST', '/api/projects', { ...projects.get('pb'), id: 'pc', name: 'PC', permissionMode: 'acceptEdits', defaultAgent: 'codex' })
  assert.equal(p.status, 200, p.body.error)
  assert.equal(projects.get('pc')!.defaultAgent, 'codex')
  const s = await api<Settings>('PUT', '/api/settings', { defaultAgent: 'codex' })
  assert.equal(s.status, 200, s.body.error)
  assert.equal(settings.get().defaultAgent, 'codex')
  const s2 = await api<Settings>('PUT', '/api/settings', { defaultAgent: 'claude' })
  assert.equal(s2.body.defaultAgent, 'claude')
})

test('run ghi agent thực tế theo kế thừa project; agent bị gỡ giữa chừng thì task Failed với lý do rõ', async () => {
  setAdapterForTest('codex', fakeCodex)
  const { startRun } = await import('../runner.ts')
  const t = tasks.create({ projectId: 'pc', title: 'run', prompt: 'x', status: 'queued', priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
  startRun(t, 'initial')
  const end = Date.now() + 15_000
  while (Date.now() < end && !(tasks.get(t.id)!.status === 'review' && runs.byTask(t.id).at(-1)?.endedAt)) await new Promise((r) => setTimeout(r, 50))
  assert.equal(tasks.get(t.id)!.status, 'review', tasks.get(t.id)!.failReason)
  assert.equal(runs.byTask(t.id).at(-1)!.agent, 'codex')

  removeAdapterForTest('codex') // mô phỏng Codex không còn adapter
  const t2 = tasks.create({ projectId: 'pc', title: 'run2', prompt: 'x', status: 'queued', priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
  startRun(t2, 'initial')
  assert.equal(tasks.get(t2.id)!.status, 'failed')
  assert.match(tasks.get(t2.id)!.failReason!, /chưa hỗ trợ chạy task bằng Codex/)
  assert.equal(runs.byTask(t2.id).length, 0)
})
