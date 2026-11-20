// SPEC-PLAN-HANDOFF Phần A qua runner thật với agent giả (node.exe): lượt Kế hoạch chạy mode plan kèm chỉ dẫn,
// duyệt kế hoạch rồi lượt Thực hiện resume đúng phiên với kế hoạch đã duyệt và mức quyền của task (AC-43, AC-44, AC-45).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'taskboard runner plan '))
process.env.TASKBOARD_DATA = root
process.env.TASKBOARD_DB = ':memory:'
const dir = join(root, 'proj')
mkdirSync(dir)
writeFileSync(join(dir, 'README.md'), 'demo\n')

const { projects, runs, settings, tasks } = await import('../db.ts')
const { startRun } = await import('../runner.ts')
const { approvePlan } = await import('../review.ts')
const { setAdapterForTest } = await import('./index.ts')
const { EXECUTE_FEEDBACK, PLAN_INSTRUCTION } = await import('../../../web/src/lib/planMode.ts')
import type { AgentAdapter, RunInput } from './types.ts'
import type { Task } from '../types.ts'

after(() => setAdapterForTest('claude'))

settings.set({ ...settings.get(), maxParallel: 3 })
projects.upsert({
  id: 'pp',
  name: 'PP',
  repoPath: dir,
  mainBranch: 'main',
  permissionMode: 'auto',
  allowedTools: [],
  maxParallel: 3,
  budgetAction: 'warn' as const,
  deliveryMode: 'direct' as const,
})

/** Agent giả: in prompt nhận được làm kết quả. Ghi lại input mỗi lượt để kiểm tra mức quyền / resume / prompt. */
function fakeAgent(seen: RunInput[]): AgentAdapter {
  return {
    id: 'claude',
    name: 'Claude',
    label: 'Claude Code',
    capabilities: { interactivePermission: true, askUser: true, resume: true, costUsd: false, hardBudget: false, permissionModes: ['auto', 'plan', 'acceptEdits', 'manual'] },
    findBin: () => ({ path: process.execPath, source: 'test' }),
    missingBinReason: 'không có',
    prepare(input) {
      seen.push(input)
      return {
        ok: true,
        args: ['-e', `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('RESULT '+JSON.stringify(s)))`],
        env: process.env,
        stdin: input.prompt,
        cleanup: () => {},
      }
    },
    createParser: () => ({
      parseLine(line: string) {
        if (!line.startsWith('RESULT ')) return { events: [] }
        return { events: [], result: { isError: false, text: JSON.parse(line.slice(7)) as string, permissionDenials: [] } }
      },
    }),
    isMissingSession: () => false,
    detectRateLimit: () => undefined,
    onSuccess: () => {},
    onRateLimit: () => {},
    failureHint: () => undefined,
  }
}

async function waitStatus(id: number, statuses: Task['status'][], timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const t = tasks.get(id)!
    if (statuses.includes(t.status) && runs.byTask(id).at(-1)?.endedAt) return t
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Task #${id} chưa xong (đang ${tasks.get(id)?.status})`)
}

test('Kế hoạch trước: lượt Kế hoạch mode plan → duyệt (đã sửa) → lượt Thực hiện resume với kế hoạch, mức quyền của task', async () => {
  const seen: RunInput[] = []
  setAdapterForTest('claude', fakeAgent(seen))
  const t = tasks.create({ projectId: 'pp', title: 'kh', prompt: 'Thêm API báo cáo', status: 'queued', priority: 'normal', permissionMode: 'auto', tags: [], planMode: 'first' })

  startRun(t, 'initial')
  const planned = await waitStatus(t.id, ['review', 'failed'])
  assert.equal(planned.status, 'review', planned.failReason ?? '')
  assert.equal(planned.planPhase, 'plan')
  assert.equal(seen[0].task.permissionMode, 'plan', 'AC-43: project Auto nhưng lượt Kế hoạch chạy mode plan')
  assert.ok(seen[0].prompt.startsWith('Thêm API báo cáo') && seen[0].prompt.includes(PLAN_INSTRUCTION))
  const planRun = runs.byTask(t.id).at(-1)!
  assert.equal(planRun.phase, 'plan')

  await approvePlan(t.id, '## Các bước\n1. Bản đã sửa')
  const queued = tasks.get(t.id)!
  assert.equal(queued.status, 'queued')
  startRun(queued, 'resume', queued.pendingFeedback) // pump() làm đúng như vậy với task Queued có pendingFeedback
  const done = await waitStatus(t.id, ['review', 'failed'])
  assert.equal(done.status, 'review', done.failReason ?? '')
  assert.equal(done.planPhase, 'execute')
  const exec = seen[1]
  assert.equal(exec.task.permissionMode, 'auto', 'AC-44: mức quyền của task')
  assert.equal(exec.resume, true, 'resume đúng phiên của lượt Kế hoạch')
  assert.equal(exec.sessionId, planRun.sessionId)
  assert.ok(exec.prompt.includes('## Các bước\n1. Bản đã sửa'), 'AC-45: agent nhận đúng bản đã sửa')
  assert.ok(!exec.prompt.includes(PLAN_INSTRUCTION))
  const execRun = runs.byTask(t.id).at(-1)!
  assert.equal(execRun.phase, 'execute')
  assert.equal(execRun.feedback, EXECUTE_FEEDBACK)
})

test('Chạy lại sau khi đã duyệt kế hoạch: phiên mới vào thẳng lượt Thực hiện kèm prompt gốc + kế hoạch (FR-104)', async () => {
  const seen: RunInput[] = []
  setAdapterForTest('claude', fakeAgent(seen))
  const t = tasks.create({ projectId: 'pp', title: 'retry', prompt: 'Sửa lỗi đăng nhập', status: 'queued', priority: 'normal', permissionMode: 'manual', tags: [], planMode: 'first' })
  const ready = tasks.patch(t.id, { approvedPlan: '## KH đã duyệt', planPhase: 'execute' })!
  startRun(ready, 'retry')
  await waitStatus(t.id, ['review', 'failed'])
  assert.equal(seen[0].resume, false)
  assert.equal(seen[0].task.permissionMode, 'manual')
  assert.ok(seen[0].prompt.startsWith('Sửa lỗi đăng nhập') && seen[0].prompt.includes('## KH đã duyệt'))
})

test('Làm luôn: không đổi gì so với trước (không có giai đoạn, prompt gốc)', async () => {
  const seen: RunInput[] = []
  setAdapterForTest('claude', fakeAgent(seen))
  const t = tasks.create({ projectId: 'pp', title: 'none', prompt: 'Việc bình thường', status: 'queued', priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
  startRun(t, 'initial')
  const done = await waitStatus(t.id, ['review', 'failed'])
  assert.equal(done.planPhase, undefined)
  assert.equal(seen[0].prompt, 'Việc bình thường')
  assert.equal(seen[0].task.permissionMode, 'acceptEdits')
  assert.equal(runs.byTask(t.id).at(-1)!.phase, undefined)
})
