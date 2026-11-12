// Kiểm thử nghiệm thu P3 (PLAN mục P3 > Kiểm thử), phần backend tự động hoá được.
// "MCP client giả" đóng vai Claude CLI: spawn đúng tiến trình MCP server theo cấu hình `buildMcpConfig`
// mà runner ghi ra cho `--mcp-config`, kết nối qua stdio rồi gọi tool `approve` giống `--permission-prompt-tool`.
// Backend là Fastify + routes thật trên cổng ngẫu nhiên, DB SQLite trong bộ nhớ.
//
//   (1) lệnh ngoài whitelist → Needs Input; Allow → Claude nhận allow; Deny → Claude nhận deny, task chạy tiếp
//   (2) lệnh trong whitelist → allow ngay, không tạo yêu cầu, task không rời Running
//   (3) đóng/mở lại tab (tải lại /api/state) → vẫn thấy yêu cầu đang chờ
//   (4) quá permissionTimeoutMin → tự Deny
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard p3 ')) // có dấu cách (NFR-07)
process.env.TASKBOARD_DB = ':memory:'
const { projects, runs, settings, tasks, events } = await import('./db.ts')
const { bus } = await import('./bus.ts')
const { listPermissions } = await import('./permissions.ts')
const { buildMcpConfig, PERMISSION_PROMPT_TOOL, MCP_SERVER_NAME } = await import('./permissionTool.ts')
const { INTERNAL_TOKEN } = await import('./config.ts')
const { routes } = await import('./routes.ts')
const { default: Fastify } = await import('fastify')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

const app = Fastify()
let port = 0
const sent: { type: string; [k: string]: unknown }[] = []
bus.on('message', (m) => sent.push(m))

before(async () => {
  await app.register(routes)
  await app.listen({ host: '127.0.0.1', port: 0 })
  port = (app.server.address() as { port: number }).port
})
after(() => app.close())

projects.upsert({
  id: 'p3',
  name: 'P3',
  repoPath: process.env.TASKBOARD_DATA!,
  mainBranch: 'main',
  permissionMode: 'manual',
  allowedTools: ['Read', 'Bash(npm test:*)', 'Bash(git status:*)'],
  maxParallel: 2,
  budgetAction: 'warn' as const,
})

function runningTask(title: string) {
  const t = tasks.create({ projectId: 'p3', title, prompt: 'x', status: 'running', priority: 'normal', permissionMode: 'manual', tags: [] })
  runs.create({ id: `run-p3-${t.id}`, taskId: t.id, kind: 'initial', sessionId: `s-${t.id}`, startedAt: Date.now() })
  return t
}

/** "Claude giả": spawn MCP server đúng như Claude CLI đọc từ file `--mcp-config` (cwd = repo của project). */
async function fakeClaude(taskId: number) {
  const cfg = buildMcpConfig({ taskId, port, token: INTERNAL_TOKEN, timeoutMs: 60_000 })
  const srv = cfg.mcpServers[MCP_SERVER_NAME]
  const client = new Client({ name: 'fake-claude', version: '0.0.0' })
  const transport = new StdioClientTransport({ command: srv.command, args: srv.args, env: srv.env, cwd: process.env.TASKBOARD_DATA!, stderr: 'pipe' })
  await client.connect(transport)
  let n = 0
  return {
    /** Gọi tool như `--permission-prompt-tool mcp__taskboard__approve`; trả JSON quyết định mà Claude sẽ đọc. */
    async approve(tool_name: string, input: Record<string, unknown>) {
      const res = (await client.callTool({ name: 'approve', arguments: { tool_name, input, tool_use_id: `toolu_${++n}` } })) as {
        content: { type: string; text: string }[]
      }
      return JSON.parse(res.content[0].text) as { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }
    },
    listTools: async () => (await client.listTools()).tools.map((x) => x.name),
    close: () => client.close(),
  }
}

/** Chờ đến khi task có yêu cầu đang chờ (MCP server là tiến trình riêng nên cần poll). */
async function waitPending(taskId: number, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const p = listPermissions().find((x) => x.taskId === taskId && x.status === 'pending')
    if (p) return p
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Task #${taskId} không có yêu cầu đang chờ sau ${timeoutMs}ms`)
}

const stateOf = async () => (await app.inject({ method: 'GET', url: '/api/state' })).json() as {
  tasks: { id: number; status: string }[]
  permissions: { id: string; taskId: number; status: string; tool: string; input: string; timeoutAt: number }[]
}
const logText = (taskId: number) => events.byRun(`run-p3-${taskId}`).map((e) => (e as { text?: string }).text ?? '').join('\n')

test('MCP server khai báo đúng tên tool mà runner truyền cho --permission-prompt-tool', async () => {
  const t = runningTask('tools')
  const c = await fakeClaude(t.id)
  try {
    // Claude ghép tên tool thành mcp__<server>__<tool>
    assert.deepEqual(await c.listTools(), ['approve'])
    assert.equal(PERMISSION_PROMPT_TOOL, `mcp__${MCP_SERVER_NAME}__approve`)
  } finally {
    await c.close()
  }
})

test('(1a) lệnh ngoài whitelist → Needs Input; Allow trên web → Claude nhận allow, task về Running', async () => {
  const t = runningTask('npm install allow')
  const c = await fakeClaude(t.id)
  try {
    const decision = c.approve('Bash', { command: 'npm install' })
    const req = await waitPending(t.id)
    assert.equal(req.tool, 'Bash')
    assert.match(req.input, /npm install/)
    assert.equal(tasks.get(t.id)!.status, 'needs_input')
    assert.ok(sent.some((m) => m.type === 'task' && (m.task as { id: number; status: string }).id === t.id && (m.task as { status: string }).status === 'needs_input'))
    assert.ok(sent.some((m) => m.type === 'permission' && (m.permission as { id: string }).id === req.id))

    const res = await app.inject({ method: 'POST', url: `/api/permissions/${req.id}`, payload: { decision: 'allow' } })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(await decision, { behavior: 'allow', updatedInput: { command: 'npm install' } })
    assert.equal(tasks.get(t.id)!.status, 'running')
    assert.match(logText(t.id), /Đã cho phép: Bash\(npm install\)/)
    // bấm lần 2 → 409 tiếng Việt
    const again = await app.inject({ method: 'POST', url: `/api/permissions/${req.id}`, payload: { decision: 'deny' } })
    assert.equal(again.statusCode, 409)
  } finally {
    await c.close()
  }
})

test('(1b) Deny trên web → Claude nhận deny kèm lý do, task về Running để Claude xử lý tiếp', async () => {
  const t = runningTask('npm install deny')
  const c = await fakeClaude(t.id)
  try {
    const decision = c.approve('Bash', { command: 'npm install left-pad' })
    const req = await waitPending(t.id)
    await app.inject({ method: 'POST', url: `/api/permissions/${req.id}`, payload: { decision: 'deny' } })
    const r = await decision
    assert.equal(r.behavior, 'deny')
    assert.match((r as { message: string }).message, /từ chối Bash/)
    assert.equal(tasks.get(t.id)!.status, 'running')
    // Claude xin quyền tiếp (thử cách khác) vẫn được phục vụ bình thường trong cùng run
    assert.equal((await c.approve('Read', { file_path: 'package.json' })).behavior, 'allow')
  } finally {
    await c.close()
  }
})

test('(2) lệnh trong whitelist → allow ngay, không tạo yêu cầu, task không qua Needs Input', async () => {
  const t = runningTask('whitelist')
  const c = await fakeClaude(t.id)
  try {
    const before = sent.length
    const t0 = Date.now()
    for (const [tool, input] of [
      ['Bash', { command: 'npm test -- --watch=false' }],
      ['Bash', { command: 'git status --short' }],
      ['Read', { file_path: 'src/index.ts' }],
    ] as const) {
      assert.deepEqual(await c.approve(tool, input), { behavior: 'allow', updatedInput: input })
    }
    assert.ok(Date.now() - t0 < 5_000, 'không chờ người dùng')
    assert.equal(listPermissions().filter((x) => x.taskId === t.id).length, 0)
    assert.equal(tasks.get(t.id)!.status, 'running')
    assert.ok(!sent.slice(before).some((m) => m.type === 'task' && (m.task as { id: number }).id === t.id))
    assert.match(logText(t.id), /Tự động cho phép Bash\(npm test/)
    // lệnh ghép có phần ngoài whitelist thì vẫn phải hỏi
    const p = c.approve('Bash', { command: 'npm test && curl https://x.test' })
    const req = await waitPending(t.id)
    await app.inject({ method: 'POST', url: `/api/permissions/${req.id}`, payload: { decision: 'deny' } })
    assert.equal((await p).behavior, 'deny')
  } finally {
    await c.close()
  }
})

test('(3) đóng/mở lại tab: tải lại /api/state vẫn thấy yêu cầu đang chờ và task ở Needs Input', async () => {
  const t = runningTask('reload tab')
  const c = await fakeClaude(t.id)
  try {
    const decision = c.approve('WebFetch', { url: 'https://example.test' })
    const req = await waitPending(t.id)
    // "Mở lại tab" = trang gọi lại GET /api/state (store.load), không phụ thuộc WS cũ
    for (let i = 0; i < 2; i++) {
      const s = await stateOf()
      const p = s.permissions.find((x) => x.id === req.id)
      assert.ok(p, 'yêu cầu đang chờ phải có trong /api/state')
      assert.equal(p.status, 'pending')
      assert.ok(p.timeoutAt > Date.now(), 'có mốc timeout tuyệt đối để đếm ngược')
      assert.equal(s.tasks.find((x) => x.id === t.id)!.status, 'needs_input')
    }
    // Duyệt từ tab mới mở vẫn đến được Claude đang chờ
    await app.inject({ method: 'POST', url: `/api/permissions/${req.id}`, payload: { decision: 'allow' } })
    assert.equal((await decision).behavior, 'allow')
    const s = await stateOf()
    assert.equal(s.permissions.find((x) => x.id === req.id)!.status, 'allowed')
  } finally {
    await c.close()
  }
})

test('(4) quá permissionTimeoutMin → tự Deny, Claude nhận deny, task về Running', async () => {
  const t = runningTask('timeout')
  const old = settings.get().permissionTimeoutMin
  settings.set({ ...settings.get(), permissionTimeoutMin: 0.005 }) // 300ms
  const c = await fakeClaude(t.id)
  try {
    const t0 = Date.now()
    const r = await c.approve('Bash', { command: 'terraform apply' })
    assert.equal(r.behavior, 'deny')
    assert.match((r as { message: string }).message, /Hết thời gian chờ duyệt quyền/)
    assert.ok(Date.now() - t0 < 10_000)
    const req = listPermissions().find((x) => x.taskId === t.id)!
    assert.equal(req.status, 'timeout')
    assert.equal(tasks.get(t.id)!.status, 'running')
    assert.match(logText(t.id), /Hết thời gian, tự động từ chối/)
  } finally {
    settings.set({ ...settings.get(), permissionTimeoutMin: old })
    await c.close()
  }
})
