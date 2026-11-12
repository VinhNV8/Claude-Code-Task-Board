// Kiểm thử nghiệm thu P5 (PLAN mục P5, task P5-08), phần backend tự động hoá được, không gọi Claude thật.
// Backend là routes + runner thật, DB SQLite trong bộ nhớ, repo git tạm (đường dẫn có dấu cách, NFR-07).
// "Claude giả" = node.exe đặt qua CLAUDE_BIN: nhận đúng mảng tham số runner sinh ra, thoát ngay với mã 9
// ("bad option: --output-format"), tức là mỗi run đều là một run lỗi. Model runner truyền vào `--model`
// đọc từ `runs.requested_model` rồi dựng lại args bằng đúng `buildClaudeArgs` + `fallbackModelFor` runner dùng.
//
//   (1) Settings mặc định 'auto' → 3 task mẫu typo / feature / refactor chạy haiku / sonnet / opus, có lý do
//   (2) Request changes lần 1 → run resume giữ model + phiên cũ, kể cả khi mặc định project đã đổi (D3)
//   (3) Run lỗi → Retry nâng một bậc (D6 trường hợp A)
//   (4) Request changes lần 2 → nâng một bậc (D6 trường hợp B)
// (3)(4) đánh dấu `todo`: P5-06 mới có hàm thuần escalation.ts, runner chưa gọi decideEscalation
// (xem PLAN "Kết quả kiểm thử P5" > Vấn đề còn lại). Khi nối xong, bỏ `todo` để test thành bắt buộc.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'taskboard p5 '))
process.env.TASKBOARD_DATA = root
process.env.TASKBOARD_DB = ':memory:'
process.env.CLAUDE_BIN = process.execPath
process.env.TASKBOARD_PERMISSION_TOOL = 'off'

const repo = join(root, 'repo p5')
mkdirSync(repo)
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' })
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'p5@test.local')
git('config', 'user.name', 'p5')
writeFileSync(join(repo, 'README.md'), '# Demo\n\nrecieve\n')
git('add', '.')
git('commit', '-q', '-m', 'init')

const { projects, runs, settings, tasks, events } = await import('./db.ts')
const { buildClaudeArgs } = await import('./permissionTool.ts')
const { fallbackModelFor } = await import('./model.ts')
const { routes } = await import('./routes.ts')
const { default: Fastify } = await import('fastify')
import type { Run, Task } from './types.ts'

const app = Fastify()
await app.register(routes)
after(() => app.close())

settings.set({ ...settings.get(), maxParallel: 3 })
projects.upsert({
  id: 'p5',
  name: 'P5',
  repoPath: repo,
  mainBranch: 'main',
  permissionMode: 'acceptEdits',
  allowedTools: [],
  maxParallel: 3,
  budgetAction: 'warn' as const,
})

async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object): Promise<T> {
  const res = await app.inject({ method, url, payload })
  assert.ok(res.statusCode < 400, `${method} ${url} → ${res.statusCode} ${res.body}`)
  return res.json() as T
}

async function waitStatus(id: number, status: Task['status'], timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const t = tasks.get(id)!
    // Run cuối phải đã đóng: finish() ghi run trước rồi mới đổi trạng thái task.
    if (t.status === status && runs.byTask(id).at(-1)?.endedAt) return t
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Task #${id} không về ${status} (đang ${tasks.get(id)?.status})`)
}

const lastRun = (taskId: number) => runs.byTask(taskId).at(-1)!

/** Tham số CLI của run, dựng đúng như spawnClaude (runner.ts). */
const argsOf = (r: Run, resume: boolean) =>
  buildClaudeArgs({
    sessionId: r.sessionId!,
    resume,
    permissionMode: 'acceptEdits',
    allowedTools: [],
    model: r.requestedModel,
    fallbackModel: fallbackModelFor(r.requestedModel),
  })
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)

const SAMPLES = {
  typo: { title: 'Sửa typo trong README', prompt: 'Sửa chữ "recieve" thành "receive" trong README.md.', tags: [] as string[] },
  feature: {
    title: 'Thêm nút Export CSV ở trang Stats',
    prompt:
      'Ở trang Stats, thêm nút "Export CSV" cạnh bộ lọc khoảng ngày. Bấm nút thì tải về file CSV gồm các cột: ngày, project, ' +
      'số task, số run, chi phí, tổng thời gian chạy. Dùng dữ liệu đang hiển thị (đã lọc). Tên file theo dạng stats-YYYY-MM-DD.csv. ' +
      'Giữ phong cách nút hiện có, không thêm thư viện mới.',
    tags: ['feature'],
  },
  refactor: {
    title: 'Refactor runner.ts tách quản lý process, tránh race condition',
    prompt: 'Tách phần quản lý tiến trình con trong runner.ts ra module riêng, đảm bảo không còn race condition khi Stop đúng lúc run vừa kết thúc.',
    tags: ['refactor'],
  },
}
const EXPECTED = { typo: 'haiku', feature: 'sonnet', refactor: 'opus' } as const
const ids = {} as Record<keyof typeof SAMPLES, number>

test('(1) Settings mặc định auto → task mẫu typo/feature/refactor chạy haiku/sonnet/opus kèm lý do', async () => {
  const { settings: s } = await api<{ settings: { defaultModel: string } }>('GET', '/api/state')
  assert.equal(s.defaultModel, 'auto')

  for (const [k, v] of Object.entries(SAMPLES) as [keyof typeof SAMPLES, (typeof SAMPLES)['typo']][]) {
    // Gợi ý trực tiếp khi gõ (form tạo task) phải khớp model runner sẽ dùng
    const sug = await api<{ effective: { value: string; level: string }; suggestion?: { model: string } }>('POST', '/api/model-suggest', {
      ...v,
      projectId: 'p5',
    })
    assert.deepEqual(sug.effective, { value: 'auto', level: 'settings' })
    assert.equal(sug.suggestion?.model, EXPECTED[k], `gợi ý cho ${k}`)

    const t = await api<Task>('POST', '/api/tasks', { projectId: 'p5', ...v, run: true })
    assert.equal(t.model, undefined, 'task không đụng vào model → kế thừa')
    ids[k] = t.id
  }

  for (const k of Object.keys(SAMPLES) as (keyof typeof SAMPLES)[]) {
    await waitStatus(ids[k], 'failed')
    const all = runs.byTask(ids[k])
    assert.equal(all.length, 1)
    const r = all[0]
    assert.equal(r.kind, 'initial')
    assert.equal(r.requestedModel, EXPECTED[k], `model của ${k}`)
    assert.equal(r.modelSource, 'auto')
    assert.ok(r.modelReason && r.modelReason.length > 0)
    const args = argsOf(r, false)
    assert.equal(flag(args, '--model'), EXPECTED[k])
    assert.equal(flag(args, '--fallback-model'), k === 'refactor' ? 'sonnet' : undefined)
    // Log của run ghi lý do tự chọn
    const label = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }[EXPECTED[k]]
    assert.ok(
      events.byRun(r.id).some((e) => e.type === 'system' && e.text.startsWith(`Tự chọn model: ${label} — `)),
      `log tự chọn model của ${k}`,
    )
  }
  // Lý do giải thích được (D4)
  assert.match(lastRun(ids.refactor).modelReason!, /refactor/)
  assert.match(lastRun(ids.typo).modelReason!, /typo/)
})

/** Đưa task về Review như sau một run thành công (Claude giả luôn lỗi nên đặt trực tiếp). */
const toReview = (id: number) => tasks.patch(id, { status: 'review', failReason: null })

test('(2) Request changes lần 1 → resume giữ model và phiên cũ, kể cả khi mặc định project đổi (D3)', async () => {
  const id = ids.feature
  const before = lastRun(id)
  toReview(id)
  projects.upsert({ ...projects.get('p5')!, defaultModel: 'opus' })
  try {
    await api('POST', `/api/tasks/${id}/review`, { action: 'request_changes', feedback: 'Thêm cả cột số token vào file CSV.' })
    await waitStatus(id, 'failed')
  } finally {
    projects.upsert({ ...projects.get('p5')!, defaultModel: undefined })
  }
  const r = lastRun(id)
  assert.equal(r.kind, 'resume')
  assert.equal(r.sessionId, before.sessionId)
  assert.equal(r.requestedModel, 'sonnet')
  assert.equal(r.modelSource, 'auto')
  assert.match(r.modelReason!, /giữ từ lần chạy trước/)
  const args = argsOf(r, true)
  assert.equal(flag(args, '--resume'), before.sessionId)
  assert.equal(flag(args, '--model'), 'sonnet')
})

test(
  '(3) Run lỗi → Retry nâng một bậc haiku → sonnet (D6 A)',
  { todo: 'P5-06: runner.startRun chưa gọi decideEscalation; chưa có runs.fail_kind' },
  async () => {
    const id = ids.typo
    assert.equal(lastRun(id).requestedModel, 'haiku')
    await api('POST', `/api/tasks/${id}/retry`)
    await waitStatus(id, 'failed')
    const r = lastRun(id)
    assert.equal(r.kind, 'retry')
    assert.equal(r.requestedModel, 'sonnet')
    assert.equal(r.modelSource, 'escalated')
    assert.match(r.modelReason!, /Nâng từ Haiku/)
    assert.equal(flag(argsOf(r, false), '--model'), 'sonnet')
  },
)

test(
  '(4) Request changes lần 2 → nâng một bậc sonnet → opus, vẫn resume khi ngữ cảnh < 80k (D6 B)',
  { todo: 'P5-06: runner.startRun chưa gọi decideEscalation' },
  async () => {
    const id = ids.feature
    const before = lastRun(id)
    toReview(id)
    await api('POST', `/api/tasks/${id}/review`, { action: 'request_changes', feedback: 'Đổi tên file thành stats-export.csv.' })
    await waitStatus(id, 'failed')
    const r = lastRun(id)
    assert.equal(r.kind, 'resume')
    assert.equal(r.sessionId, before.sessionId)
    assert.equal(r.requestedModel, 'opus')
    assert.equal(r.modelSource, 'escalated')
    assert.match(r.modelReason!, /yêu cầu sửa lần 2/)
  },
)
