// M1 (SPEC-MULTI-AGENT): runner chạy task hoàn toàn qua AgentAdapter. Thay adapter bằng "agent giả" (node.exe)
// rồi kiểm tra: dùng đúng bin/args/env/stdin của adapter, parser của adapter, dọn file tạm, thông báo lỗi theo tên agent.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'taskboard adapter '))
process.env.TASKBOARD_DATA = root
process.env.TASKBOARD_DB = ':memory:'
const dir = join(root, 'proj a')
mkdirSync(dir)
writeFileSync(join(dir, 'README.md'), 'demo\n')

const { projects, runs, settings, tasks, events } = await import('../db.ts')
const { startRun } = await import('../runner.ts')
const { setAdapterForTest } = await import('./index.ts')
import type { AgentAdapter, RunInput } from './types.ts'
import type { Task } from '../types.ts'

after(() => setAdapterForTest('claude'))

settings.set({ ...settings.get(), maxParallel: 3 })
projects.upsert({
  id: 'pa',
  name: 'PA',
  repoPath: dir,
  mainBranch: 'main',
  permissionMode: 'acceptEdits',
  allowedTools: [],
  maxParallel: 3,
  budgetAction: 'warn' as const,
  deliveryMode: 'direct' as const,
})

/** Agent giả: chạy `node -e <script>`, in ra stdout; parser hiểu dòng `RESULT <text>` là kết quả thành công. */
function fakeAdapter(script: string, o: { prepareError?: string; seen?: RunInput[]; cleaned?: string[] } = {}): AgentAdapter {
  return {
    id: 'claude',
    name: 'Codex',
    label: 'OpenAI Codex',
    capabilities: { interactivePermission: true, askUser: false, resume: true, costUsd: false, hardBudget: false, permissionModes: ['acceptEdits'] },
    findBin: () => ({ path: process.execPath, source: 'test' }),
    missingBinReason: 'không có',
    prepare(input) {
      o.seen?.push(input)
      if (o.prepareError) return { ok: false, error: o.prepareError }
      return {
        ok: true,
        args: ['-e', script],
        env: { ...process.env, FAKE_AGENT_ENV: 'yes' },
        stdin: input.prompt,
        cleanup: () => o.cleaned?.push(input.runId),
      }
    },
    createParser: () => ({
      parseLine(line: string) {
        if (line.startsWith('RESULT ')) {
          const text = line.slice(7)
          return { events: [{ type: 'system' as const, text: `agent: ${text}` }], result: { isError: false, text, permissionDenials: [] } }
        }
        return { events: [] }
      },
    }),
    isMissingSession: () => false,
    detectRateLimit: () => undefined,
    onSuccess: () => {},
    onRateLimit: () => {},
    failureHint: () => undefined,
  }
}

function newTask(title: string): Task {
  return tasks.create({ projectId: 'pa', title, prompt: `prompt của ${title}`, status: 'queued', priority: 'normal', permissionMode: 'acceptEdits', tags: [] })
}

async function waitDone(id: number, statuses: Task['status'][], timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const t = tasks.get(id)!
    if (statuses.includes(t.status) && runs.byTask(id).at(-1)?.endedAt) return t
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Task #${id} chưa xong (đang ${tasks.get(id)?.status})`)
}

test('chạy thành công qua adapter: prompt qua stdin, env của adapter, parser của adapter, dọn file tạm, task sang Review', async () => {
  const seen: RunInput[] = []
  const cleaned: string[] = []
  // Đọc stdin (prompt) và biến môi trường của adapter rồi in kết quả
  const script = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log('noise');console.log('RESULT '+process.env.FAKE_AGENT_ENV+'|'+s)})`
  setAdapterForTest('claude', fakeAdapter(script, { seen, cleaned }))
  const t = newTask('ok')
  startRun(t, 'initial')
  const done = await waitDone(t.id, ['review', 'failed'])
  assert.equal(done.status, 'review', done.failReason ?? '')
  const run = runs.byTask(t.id).at(-1)!
  assert.equal(run.summary, 'yes|prompt của ok')
  assert.equal(run.exitCode, 0)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].cwd, dir)
  assert.equal(seen[0].prompt, 'prompt của ok')
  assert.equal(seen[0].resume, false)
  assert.deepEqual(cleaned, [run.id])
  assert.ok(events.byRun(run.id).some((e) => (e as { text?: string }).text === 'agent: yes|prompt của ok'))
})

test('CLI thoát lỗi: lý do thất bại ghi theo tên agent, vẫn dọn file tạm', async () => {
  const cleaned: string[] = []
  setAdapterForTest('claude', fakeAdapter(`process.stderr.write('boom\\n');process.exit(3)`, { cleaned }))
  const t = newTask('fail')
  startRun(t, 'initial')
  const done = await waitDone(t.id, ['failed'])
  assert.equal(done.failReason, 'Codex CLI thoát với mã 3: boom')
  assert.equal(runs.byTask(t.id).at(-1)!.failKind, 'claude')
  assert.equal(cleaned.length, 1)
})

test('adapter không chuẩn bị được (ví dụ chưa đăng nhập): task Failed với lý do của adapter, lỗi hạ tầng', async () => {
  setAdapterForTest('claude', fakeAdapter('', { prepareError: 'Chưa đăng nhập Codex: chạy `codex login`.' }))
  const t = newTask('noauth')
  startRun(t, 'initial')
  const done = await waitDone(t.id, ['failed'])
  assert.equal(done.failReason, 'Chưa đăng nhập Codex: chạy `codex login`.')
  assert.equal(runs.byTask(t.id).at(-1)!.failKind, 'infra')
})

test('không tìm thấy CLI: task Failed với hướng dẫn của adapter', () => {
  setAdapterForTest('claude', { ...fakeAdapter(''), findBin: () => null, missingBinReason: 'Không tìm thấy Codex CLI.' })
  const t = newTask('nobin')
  startRun(t, 'initial')
  const after = tasks.get(t.id)!
  assert.equal(after.status, 'failed')
  assert.equal(after.failReason, 'Không tìm thấy Codex CLI.')
})
