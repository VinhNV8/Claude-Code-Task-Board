// M4 (SPEC-MULTI-AGENT FR-99, mục 3.6a, AC-37..41): tự chuyển agent khi hết hạn mức.
// "Claude giả" luôn gặp giới hạn sử dụng (đi qua detectRateLimit + banner thật của Claude), "Codex giả" chạy thành công.
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'taskboard failover '))
process.env.TASKBOARD_DATA = root
process.env.TASKBOARD_DB = ':memory:'
const dir = join(root, 'proj f')
mkdirSync(dir)

const { events, projects, runs, settings, tasks } = await import('../db.ts')
const { startRun, pump } = await import('../runner.ts')
const { setAdapterForTest } = await import('./index.ts')
const { claudeAdapter } = await import('./claude.ts')
const { clearClaudeLimit } = await import('../claudeLimit.ts')
const { clearAgentLimit } = await import('./limits.ts')
const { agentForRun, failoverChain, parseChain, pickFallback } = await import('../../../web/src/lib/agent.ts')
const { routes } = await import('../routes.ts')
const { default: Fastify } = await import('fastify')
import type { AgentAdapter } from './types.ts'
import type { PermissionMode, Project } from '../types.ts'

const app = Fastify()
await app.register(routes)

/** Agent giả chạy `node -e`, in một dòng; parser biến dòng đó thành kết quả. */
function fake(base: Pick<AgentAdapter, 'id' | 'name' | 'label'>, o: { line: string; modes?: PermissionMode[]; result: (line: string) => any; real?: Partial<AgentAdapter> }): AgentAdapter {
  return {
    ...base,
    capabilities: { interactivePermission: true, askUser: false, resume: true, costUsd: false, hardBudget: base.id === 'claude', permissionModes: o.modes ?? ['manual', 'acceptEdits', 'auto', 'plan'] },
    findBin: () => ({ path: process.execPath, source: 'test' }),
    missingBinReason: 'không có',
    prepare: (input) => ({ ok: true, args: ['-e', `console.log(${JSON.stringify(o.line)})`], env: process.env, stdin: input.prompt, cleanup: () => {} }),
    createParser: () => ({ parseLine: (line: string) => (line === o.line ? { events: [], result: o.result(line) } : { events: [] }) }),
    isMissingSession: () => false,
    detectRateLimit: () => undefined,
    onSuccess: () => {},
    onRateLimit: () => {},
    failureHint: () => undefined,
    ...o.real,
  }
}

// Claude giả: luôn hết lượt. Dùng detectRateLimit + onRateLimit + onSuccess thật (banner claudeLimit, ngắt mạch).
const limitedClaude = fake(claudeAdapter, {
  line: 'LIMIT',
  result: () => ({ isError: true, text: "You've hit your usage limit", apiErrorStatus: 429, permissionDenials: [] }),
  real: { detectRateLimit: claudeAdapter.detectRateLimit, onRateLimit: claudeAdapter.onRateLimit, onSuccess: claudeAdapter.onSuccess },
})
const okClaude = fake(claudeAdapter, { line: 'OK', result: () => ({ isError: false, text: 'claude ok', permissionDenials: [] }), real: { onSuccess: claudeAdapter.onSuccess } })
let codexModes: PermissionMode[] = ['manual', 'acceptEdits', 'auto', 'plan']
const codex = () => fake({ id: 'codex', name: 'Codex', label: 'OpenAI Codex' }, { line: 'OK', modes: codexModes, result: () => ({ isError: false, text: 'codex ok', permissionDenials: [] }) })

after(async () => {
  setAdapterForTest('claude')
  setAdapterForTest('codex')
  await app.close()
})
beforeEach(() => {
  clearClaudeLimit()
  clearAgentLimit('codex')
  codexModes = ['manual', 'acceptEdits', 'auto', 'plan']
  setAdapterForTest('codex', codex())
  settings.set({ ...settings.get(), maxParallel: 5, failover: { enabled: true, chain: ['claude', 'codex'] } })
})

function project(id: string, extra: Partial<Project> = {}) {
  projects.upsert({ id, name: id, repoPath: dir, mainBranch: 'main', permissionMode: 'acceptEdits', allowedTools: [], maxParallel: 5, budgetAction: 'warn', deliveryMode: 'direct', ...extra })
}
project('pf')
project('poff', { failoverMode: 'off' })
project('pcustom', { failoverMode: 'custom', failoverChain: ['claude', 'cursor'] })

const newTask = (projectId = 'pf', mode: PermissionMode = 'acceptEdits') =>
  tasks.create({ projectId, title: 'f', prompt: 'Làm việc gì đó', status: 'queued', priority: 'normal', permissionMode: mode, tags: [] })
async function until<T>(fn: () => T | undefined, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Hết giờ chờ: ${what}`)
}
const reviewed = (id: number, nRuns: number) =>
  until(() => (tasks.get(id)!.status === 'review' && runs.byTask(id).length === nRuns && runs.byTask(id).at(-1)!.endedAt ? tasks.get(id) : undefined), `#${id} Review sau ${nRuns} run`)
const waiting = (id: number) => until(() => (tasks.get(id)!.status === 'queued' && tasks.get(id)!.notBefore ? tasks.get(id) : undefined), `#${id} chờ giờ reset`)
const log = (runId: string) => events.byRun(runId).map((e) => (e as { text?: string }).text ?? '').join('\n')

test('hàm thuần: failoverChain theo QA6, pickFallback theo 3.6a, agentForRun theo QA7, parseChain', () => {
  const s = { failover: { enabled: true, chain: ['claude', 'codex'] as const } as any }
  assert.deepEqual(failoverChain(undefined, s), ['claude', 'codex'])
  assert.equal(failoverChain({ failoverMode: 'off' }, s), undefined)
  assert.deepEqual(failoverChain({ failoverMode: 'custom', failoverChain: ['codex', 'claude'] }, s), ['codex', 'claude'])
  assert.equal(failoverChain(undefined, { failover: { enabled: false, chain: ['claude', 'codex'] } }), undefined)

  const c = (id: any, x: object = {}) => ({ id, supported: true, installed: true, permissionModes: ['manual', 'acceptEdits', 'auto', 'plan'] as const, hardBudget: false, ...x })
  const base = { current: 'claude' as const, chain: ['claude', 'codex', 'antigravity'] as const, mode: 'manual' as const, needHardBudget: false, now: 1000 }
  assert.equal(pickFallback({ ...base, candidates: [c('codex'), c('antigravity')] }), 'codex')
  assert.equal(pickFallback({ ...base, candidates: [c('codex', { limitedUntil: 2000 }), c('antigravity')] }), 'antigravity', 'bỏ agent đang hết lượt')
  assert.equal(pickFallback({ ...base, candidates: [c('codex', { limitedUntil: 500 }), c('antigravity')] }), 'codex', 'hết lượt đã qua giờ reset')
  assert.equal(pickFallback({ ...base, candidates: [c('codex', { installed: false }), c('antigravity', { supported: false })] }), undefined)
  assert.equal(pickFallback({ ...base, candidates: [c('codex', { permissionModes: ['acceptEdits'] })] }), undefined, 'không hạ mức quyền')
  assert.equal(pickFallback({ ...base, needHardBudget: true, candidates: [c('codex')] }), undefined, 'budget cứng cần hardBudget')

  assert.equal(agentForRun({ activeAgent: 'codex' }, undefined, undefined, 'resume'), 'codex')
  assert.equal(agentForRun({ activeAgent: 'codex' }, undefined, undefined, 'continue'), 'codex')
  assert.equal(agentForRun({ activeAgent: 'codex' }, undefined, undefined, 'retry'), 'claude')
  assert.equal(agentForRun({ activeAgent: 'codex' }, undefined, undefined, 'initial'), 'claude')
  assert.deepEqual(parseChain(['codex', 'codex', 'claude']), ['codex', 'claude'])
  assert.equal(parseChain(['gpt']), null)
  assert.equal(parseChain('claude'), null)
})

test('AC-37: Claude hết hạn mức → task chuyển sang Codex và chạy tiếp ngay; task sau đi thẳng Codex; hết hạn mức xong thì task mới về Claude', async () => {
  setAdapterForTest('claude', limitedClaude)
  const t = newTask()
  startRun(t, 'initial')
  const done = await reviewed(t.id, 2)
  const [r1, r2] = runs.byTask(t.id)
  assert.equal(r1.agent, 'claude')
  assert.equal(r1.failKind, 'rate_limit')
  assert.match(log(r1.id), /Chuyển từ Claude sang Codex: Claude hết hạn mức/)
  assert.equal(r2.agent, 'codex')
  assert.equal(r2.kind, 'continue', 'chạy tiếp trên thay đổi dở')
  assert.match(log(r2.id), /mở phiên mới, không chạy tiếp phiên cũ/)
  assert.equal(r2.summary, 'codex ok')
  assert.equal(done!.activeAgent, 'codex')

  // Ngắt mạch: Claude vẫn đang hết lượt → task mới đi thẳng sang Codex, không thất bại trước
  const t2 = newTask()
  startRun(t2, 'initial')
  await reviewed(t2.id, 1)
  assert.equal(runs.byTask(t2.id)[0].agent, 'codex')
  assert.match(log(runs.byTask(t2.id)[0].id), /Claude đang hết hạn mức đến .*: chạy bằng Codex/)

  // Claude có lượt lại → task mới về Claude
  clearClaudeLimit()
  setAdapterForTest('claude', okClaude)
  const t3 = newTask()
  startRun(t3, 'initial')
  await reviewed(t3.id, 1)
  assert.equal(runs.byTask(t3.id)[0].agent, 'claude')
  assert.equal(tasks.get(t3.id)!.activeAgent, undefined)
})

test('QA7: Request changes giữ agent dự phòng; Retry quay về agent gốc và bỏ activeAgent; đổi agent bằng tay cũng bỏ', async () => {
  setAdapterForTest('claude', okClaude)
  const t = newTask()
  tasks.patch(t.id, { activeAgent: 'codex' })
  startRun(tasks.get(t.id)!, 'resume', 'Sửa tên biến')
  await reviewed(t.id, 1)
  assert.equal(runs.byTask(t.id)[0].agent, 'codex')
  assert.equal(tasks.get(t.id)!.activeAgent, 'codex')

  startRun(tasks.get(t.id)!, 'retry')
  await reviewed(t.id, 2)
  assert.equal(runs.byTask(t.id)[1].agent, 'claude')
  assert.equal(tasks.get(t.id)!.activeAgent, undefined)

  tasks.patch(t.id, { activeAgent: 'codex', status: 'backlog' })
  const res = await app.inject({ method: 'PATCH', url: `/api/tasks/${t.id}`, payload: { agent: 'claude' } })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(tasks.get(t.id)!.activeAgent, undefined)
})

test('AC-41: project tắt failover / chuỗi riêng không có agent dùng được → chờ giờ reset như cũ, không chuyển', async () => {
  setAdapterForTest('claude', limitedClaude)
  const off = newTask('poff')
  startRun(off, 'initial')
  const w = await waiting(off.id)
  assert.equal(w!.activeAgent, undefined)
  assert.equal(runs.byTask(off.id).length, 1)

  clearClaudeLimit()
  const custom = newTask('pcustom') // chuỗi claude → cursor, Cursor chưa có adapter
  startRun(custom, 'initial')
  await waiting(custom.id)
  assert.equal(runs.byTask(custom.id).every((r) => r.agent === 'claude'), true)
})

test('AC-38: agent dự phòng không hỗ trợ mức quyền của task → không chuyển (không hạ mức quyền)', async () => {
  setAdapterForTest('claude', limitedClaude)
  codexModes = ['acceptEdits', 'plan']
  setAdapterForTest('codex', codex())
  const t = newTask('pf', 'manual')
  startRun(t, 'initial')
  await waiting(t.id)
  assert.equal(tasks.get(t.id)!.activeAgent, undefined)
})

test('hệ thống tắt failover → chờ giờ reset; bật lại thì chuyển', async () => {
  setAdapterForTest('claude', limitedClaude)
  settings.set({ ...settings.get(), failover: { enabled: false, chain: ['claude', 'codex'] } })
  const t = newTask()
  startRun(t, 'initial')
  await waiting(t.id)
  assert.equal(tasks.get(t.id)!.activeAgent, undefined)
  pump() // không chạy vì còn notBefore
  assert.equal(tasks.get(t.id)!.status, 'queued')
  tasks.patch(t.id, { status: 'failed', notBefore: null })
})

test('API: lưu failover hệ thống và project, kiểm tra chuỗi', async () => {
  const bad = await app.inject({ method: 'PUT', url: '/api/settings', payload: { failover: { enabled: true, chain: ['claude'] } } })
  assert.equal(bad.statusCode, 400)
  const badId = await app.inject({ method: 'PUT', url: '/api/settings', payload: { failover: { chain: ['claude', 'gpt'] } } })
  assert.equal(badId.statusCode, 400)
  const ok = await app.inject({ method: 'PUT', url: '/api/settings', payload: { failover: { enabled: true, chain: ['codex', 'claude', 'codex'] } } })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(settings.get().failover, { enabled: true, chain: ['codex', 'claude'] })

  const p = projects.get('pf')!
  const noChain = await app.inject({ method: 'POST', url: '/api/projects', payload: { ...p, failoverMode: 'custom', failoverChain: ['claude'] } })
  assert.equal(noChain.statusCode, 400)
  const custom = await app.inject({ method: 'POST', url: '/api/projects', payload: { ...p, failoverMode: 'custom', failoverChain: ['claude', 'codex'] } })
  assert.equal(custom.statusCode, 200, custom.body)
  assert.equal(projects.get('pf')!.failoverMode, 'custom')
  assert.deepEqual(projects.get('pf')!.failoverChain, ['claude', 'codex'])
  // Form cũ không gửi trường failover: giữ nguyên
  const keep = await app.inject({ method: 'POST', url: '/api/projects', payload: { ...p, failoverMode: undefined, failoverChain: undefined } })
  assert.equal(keep.statusCode, 200, keep.body)
  assert.equal(projects.get('pf')!.failoverMode, 'custom')
  const inherit = await app.inject({ method: 'POST', url: '/api/projects', payload: { ...p, failoverMode: 'inherit' } })
  assert.equal(inherit.statusCode, 200)
  assert.equal(projects.get('pf')!.failoverMode, undefined)
})
