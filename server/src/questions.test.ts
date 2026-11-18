// FR-40: Claude hỏi lại người dùng giữa lúc chạy bằng AskUserQuestion (spike S9, docs/P0-SPIKE.md).
// Hàm thuần dùng chung, luồng permissions (luôn chờ người, đáp án trong updatedInput.answers), route và Telegram.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARD_DATA = mkdtempSync(join(tmpdir(), 'taskboard question '))
process.env.TASKBOARD_DB = ':memory:'
const { events, projects, runs, tasks } = await import('./db.ts')
const {
  answerQuestion,
  decidePermission,
  decidePermissionsBatch,
  expireOverdue,
  initPermissions,
  listPermissions,
  requestPermission,
  setPermissionClock,
} = await import('./permissions.ts')
const { ruleSuggestionsFor } = await import('./ruleSuggestions.ts')
const q = await import('../../web/src/lib/question.ts')
const tg = await import('./telegramApprove.ts')
const { DEFAULT_SETTINGS } = await import('./db.ts')
const { DEFAULT_TELEGRAM } = await import('./telegram.ts')

initPermissions()

projects.upsert({
  id: 'p',
  name: 'P',
  repoPath: process.env.TASKBOARD_DATA!,
  mainBranch: 'main',
  permissionMode: 'acceptEdits',
  // Kể cả khi allowlist có AskUserQuestion, câu hỏi vẫn phải chờ người trả lời
  allowedTools: ['Read', 'AskUserQuestion'],
  maxParallel: 1,
  budgetAction: 'warn' as const,
  deliveryMode: 'direct' as const,
})

function runningTask(permissionMode: 'acceptEdits' | 'auto' = 'acceptEdits') {
  const t = tasks.create({ projectId: 'p', title: 't', prompt: 'x', status: 'running', priority: 'normal', permissionMode, tags: [] })
  runs.create({ id: `run-${t.id}`, taskId: t.id, kind: 'initial', sessionId: 's', startedAt: Date.now() })
  return t
}

/** Input thật của AskUserQuestion lấy từ fixture spike (CLI 2.1.322). */
const fixtureInput = (() => {
  const lines = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'ask-user-question.jsonl'), 'utf8').split('\n').filter(Boolean)
  for (const l of lines) {
    const e = JSON.parse(l)
    if (e.type !== 'assistant') continue
    for (const c of e.message.content) if (c.type === 'tool_use' && c.name === 'AskUserQuestion') return c.input as Record<string, unknown>
  }
  throw new Error('fixture không có AskUserQuestion')
})()
const QUESTION = 'Bạn thích màu nào trong 3 màu sau?'

const pendingFor = (taskId: number) => listPermissions().find((p) => p.taskId === taskId && p.status === 'pending')
const logOf = (taskId: number) => events.byRun(`run-${taskId}`).map((e) => (e as { text?: string }).text ?? '')

// ---------------------------------------------------------------- hàm thuần

test('parseQuestions: đọc đúng input thật của CLI, bỏ phần tử sai định dạng', () => {
  const qs = q.parseQuestions(fixtureInput)
  assert.equal(qs.length, 1)
  assert.equal(qs[0].question, QUESTION)
  assert.equal(qs[0].header, 'Màu sắc')
  assert.deepEqual(qs[0].options.map((o) => o.label), ['Đỏ', 'Xanh lá', 'Xanh dương'])
  assert.equal(qs[0].multiSelect, undefined)
  assert.deepEqual(q.parseQuestions({ questions: [{ question: '  ' }, { question: 'A?', options: [{ label: '' }, { label: 'x' }], multiSelect: true }, 3] }), [
    { question: 'A?', options: [{ label: 'x' }], multiSelect: true },
  ])
  assert.deepEqual(q.parseQuestions({}), [])
  assert.deepEqual(q.parseQuestions(null), [])
})

test('validateAnswers: đủ mọi câu, không rỗng, giới hạn độ dài, bỏ khoá lạ', () => {
  const qs = q.parseQuestions({ questions: [{ question: 'A?', options: [] }, { question: 'B?', options: [] }] })
  assert.deepEqual(q.validateAnswers(qs, { 'A?': ' x ', 'B?': 'y', 'C?': 'z' }), { answers: { 'A?': 'x', 'B?': 'y' } })
  assert.match((q.validateAnswers(qs, { 'A?': 'x' }) as { error: string }).error, /Chưa trả lời câu: B\?/)
  assert.match((q.validateAnswers(qs, { 'A?': 'x', 'B?': '   ' }) as { error: string }).error, /Chưa trả lời/)
  assert.match((q.validateAnswers(qs, { 'A?': 'x', 'B?': 'y'.repeat(q.MAX_ANSWER + 1) }) as { error: string }).error, /tối đa/)
  assert.ok('error' in q.validateAnswers(qs, ['x']))
  assert.ok('error' in q.validateAnswers([], {}))
})

test('joinSelected / noAnswerMessage', () => {
  assert.equal(q.joinSelected(['Đỏ', ' ', 'Tím ']), 'Đỏ, Tím')
  assert.match(q.noAnswerMessage('timeout'), /chưa trả lời.*thời gian chờ.*tự chọn/)
  assert.match(q.noAnswerMessage('skipped', 'Chọn cách đơn giản'), /bỏ qua.*Ghi chú của người dùng: Chọn cách đơn giản/)
})

// ---------------------------------------------------------------- permissions

test('câu hỏi luôn chờ người (kể cả mode Auto và allowlist có AskUserQuestion); trả lời → allow kèm answers', async () => {
  const t = runningTask('auto')
  const first = await requestPermission({ taskId: t.id, toolName: 'AskUserQuestion', input: fixtureInput }, 20)
  assert.ok('status' in first && first.status === 'pending', 'không được tự cho phép khi chưa có đáp án')
  assert.equal(tasks.get(t.id)!.status, 'needs_input')
  const req = pendingFor(t.id)!
  assert.deepEqual(req.rules, [])
  assert.equal(req.risk, 'normal')
  assert.equal(req.input, QUESTION)
  assert.equal(req.questions?.[0].options.length, 3)
  assert.ok(logOf(t.id).some((s) => s.includes(`Claude hỏi: ${QUESTION}`)))

  const poll = requestPermission({ taskId: t.id, toolName: 'AskUserQuestion', input: fixtureInput, requestId: req.id }, 5_000)
  const saved = answerQuestion(req.id, { [QUESTION]: 'Xanh lá' })
  assert.equal(saved.status, 'allowed')
  assert.deepEqual(saved.answers, { [QUESTION]: 'Xanh lá' })
  // Đúng định dạng spike S9: input gốc + answers
  assert.deepEqual(await poll, { decision: 'allow', updatedInput: { ...fixtureInput, answers: { [QUESTION]: 'Xanh lá' } } })
  assert.equal(tasks.get(t.id)!.status, 'running')
  assert.ok(logOf(t.id).some((s) => s.includes(`Đã trả lời câu hỏi của Claude: ${QUESTION} → Xanh lá`)))
  // Đã lưu: đọc lại từ DB vẫn có đáp án; trả lời lần 2 → 409
  assert.deepEqual(listPermissions().find((p) => p.id === req.id)!.answers, { [QUESTION]: 'Xanh lá' })
  assert.throws(() => answerQuestion(req.id, { [QUESTION]: 'Đỏ' }), { statusCode: 409 })
})

test('câu trả lời tự nhập; đáp án thiếu/không hợp lệ → 400 và câu hỏi vẫn chờ', async () => {
  const t = runningTask()
  await requestPermission({ taskId: t.id, toolName: 'AskUserQuestion', input: fixtureInput }, 20)
  const req = pendingFor(t.id)!
  assert.throws(() => answerQuestion(req.id, {}), { statusCode: 400 })
  assert.throws(() => answerQuestion(req.id, 'Xanh lá'), { statusCode: 400 })
  assert.equal(pendingFor(t.id)?.id, req.id)
  const poll = requestPermission({ taskId: t.id, toolName: 'AskUserQuestion', input: fixtureInput, requestId: req.id }, 5_000)
  answerQuestion(req.id, { [QUESTION]: 'Màu tím' })
  const r = await poll
  assert.ok('decision' in r && r.decision === 'allow')
  assert.equal((r.updatedInput.answers as Record<string, string>)[QUESTION], 'Màu tím')
})

test('Cho phép suông → 400; Bỏ qua (deny) kèm ghi chú → Claude được bảo tự quyết', async () => {
  const t = runningTask()
  await requestPermission({ taskId: t.id, toolName: 'AskUserQuestion', input: fixtureInput }, 20)
  const req = pendingFor(t.id)!
  assert.throws(() => decidePermission(req.id, 'allow'), { statusCode: 400 })
  assert.throws(() => decidePermission(req.id, 'always'), { statusCode: 400 })
  const poll = requestPermission({ taskId: t.id, toolName: 'AskUserQuestion', input: fixtureInput, requestId: req.id }, 5_000)
  decidePermission(req.id, 'deny', 'Chọn cách đơn giản')
  const r = (await poll) as { decision: string; message: string }
  assert.equal(r.decision, 'deny')
  assert.match(r.message, /bỏ qua câu hỏi.*Chọn cách đơn giản.*tự chọn phương án/)
  assert.ok(logOf(t.id).some((s) => s.includes('Đã bỏ qua câu hỏi của Claude • ghi chú: Chọn cách đơn giản')))
})

test('hết thời gian chờ → Claude tự quyết', async (tt) => {
  let clock = Date.now()
  setPermissionClock(() => clock)
  tt.after(() => setPermissionClock())
  const t = runningTask()
  await requestPermission({ taskId: t.id, toolName: 'AskUserQuestion', input: fixtureInput }, 20)
  const req = pendingFor(t.id)!
  clock = req.timeoutAt + 1
  assert.ok(expireOverdue() >= 1)
  const r = (await requestPermission({ taskId: t.id, toolName: 'AskUserQuestion', input: fixtureInput, requestId: req.id }, 20)) as { message: string }
  assert.match(r.message, /chưa trả lời câu hỏi.*thời gian chờ/)
})

test('không có câu hỏi hợp lệ → từ chối ngay, không tạo yêu cầu', async () => {
  const t = runningTask()
  const r = await requestPermission({ taskId: t.id, toolName: 'AskUserQuestion', input: { questions: [] } }, 20)
  assert.equal((r as { decision: string }).decision, 'deny')
  assert.equal(pendingFor(t.id), undefined)
  assert.equal(tasks.get(t.id)!.status, 'running')
})

test('duyệt hàng loạt bỏ qua câu hỏi; answerQuestion với yêu cầu quyền thường → 400', async () => {
  const t = runningTask()
  await requestPermission({ taskId: t.id, toolName: 'AskUserQuestion', input: fixtureInput }, 20)
  const question = pendingFor(t.id)!
  assert.deepEqual(decidePermissionsBatch([question.id], 'allow'), { decided: 0, skipped: 1 })
  assert.equal(pendingFor(t.id)?.id, question.id)
  decidePermission(question.id, 'deny')

  await requestPermission({ taskId: t.id, toolName: 'Bash', input: { command: 'docker ps' } }, 20)
  const perm = pendingFor(t.id)!
  assert.throws(() => answerQuestion(perm.id, { x: 'y' }), { statusCode: 400 })
  decidePermission(perm.id, 'deny')
})

test('gợi ý rule không bao giờ đề xuất AskUserQuestion', async () => {
  projects.upsert({ ...projects.get('p')!, allowedTools: ['Read'] })
  for (let i = 0; i < 4; i++) {
    const t = runningTask()
    await requestPermission({ taskId: t.id, toolName: 'AskUserQuestion', input: fixtureInput }, 20)
    answerQuestion(pendingFor(t.id)!.id, { [QUESTION]: 'Đỏ' })
  }
  assert.ok(!ruleSuggestionsFor(projects.get('p')!).some((s) => s.rule.includes('AskUserQuestion')))
})

test('route POST /api/permissions/:id/answer', async () => {
  const { default: Fastify } = await import('fastify')
  const { routes } = await import('./routes.ts')
  const app = Fastify()
  await app.register(routes)
  try {
    const t = runningTask()
    await requestPermission({ taskId: t.id, toolName: 'AskUserQuestion', input: fixtureInput }, 20)
    const req = pendingFor(t.id)!
    const bad = await app.inject({ method: 'POST', url: `/api/permissions/${req.id}/answer`, payload: { answers: {} } })
    assert.equal(bad.statusCode, 400)
    const ok = await app.inject({ method: 'POST', url: `/api/permissions/${req.id}/answer`, payload: { answers: { [QUESTION]: 'Đỏ' } } })
    assert.equal(ok.statusCode, 200)
    assert.deepEqual(ok.json().answers, { [QUESTION]: 'Đỏ' })
    const missing = await app.inject({ method: 'POST', url: '/api/permissions/perm-x/answer', payload: { answers: {} } })
    assert.equal(missing.statusCode, 404)
  } finally {
    await app.close()
  }
})

test('end-to-end: MCP permission tool ↔ route HTTP thật → Claude nhận {behavior: allow, updatedInput.answers}', async () => {
  const { default: Fastify } = await import('fastify')
  const { routes } = await import('./routes.ts')
  const { INTERNAL_TOKEN } = await import('./config.ts')
  const { requestDecision } = await import('./mcp/permission.ts')
  const app = Fastify()
  await app.register(routes)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as { port: number }).port
  try {
    const t = runningTask('auto')
    const cfg = { taskId: String(t.id), port, token: INTERNAL_TOKEN, timeoutMs: 10_000, requestTimeoutMs: 5_000, maxNetworkErrors: 3, retryDelayMs: 10 }
    const pending = requestDecision({ tool_name: 'AskUserQuestion', input: fixtureInput }, cfg)
    let req
    for (let i = 0; i < 100 && !req; i++) {
      await new Promise((r) => setTimeout(r, 10))
      req = pendingFor(t.id)
    }
    assert.ok(req, 'mode Auto vẫn phải tạo câu hỏi chờ người')
    const res = await app.inject({ method: 'POST', url: `/api/permissions/${req!.id}/answer`, payload: { answers: { [QUESTION]: 'Xanh dương' } } })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { ...fixtureInput, answers: { [QUESTION]: 'Xanh dương' } } })
  } finally {
    await app.close()
  }
})

// ---------------------------------------------------------------- Telegram

const CHAT = '111222333'
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'
const REQ_ID = 'perm-0f8fad5b-d9cb-469f-a165-70867728950e'

function tgSetup() {
  const calls: { method: string; body: Record<string, any> }[] = []
  const decided: [string, string][] = []
  const answered: [string, Record<string, string>][] = []
  const a = tg.createTelegramApprover({
    fetchImpl: async (url, init) => {
      const c = { method: url.split('/').pop()!, body: JSON.parse(init.body) }
      calls.push(c)
      const result = c.method === 'sendMessage' ? { message_id: 42 } : true
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) }
    },
    getSettings: () => ({
      ...DEFAULT_SETTINGS,
      notifyOn: { ...DEFAULT_SETTINGS.notifyOn, needsInput: true },
      telegram: { ...DEFAULT_TELEGRAM, enabled: true, chatId: CHAT, appUrl: 'http://127.0.0.1:3000', hasToken: true },
    }),
    getToken: () => TOKEN,
    getTask: (id) => ({ id, title: 'Chọn màu', projectId: 'p1' }),
    projectName: () => 'Web',
    decide: (id, d) => void decided.push([id, d]),
    answer: (id, ans) => void answered.push([id, ans]),
    now: () => 0,
    log: () => {},
  })
  return { a, calls, decided, answered }
}

const questionReq = (questions = q.parseQuestions(fixtureInput)) => ({
  id: REQ_ID,
  taskId: 7,
  tool: 'AskUserQuestion',
  input: q.describeQuestions(questions),
  rules: [],
  risk: 'normal' as const,
  createdAt: 0,
  timeoutAt: 30 * 60_000,
  status: 'pending' as const,
  questions,
})
const cq = (data: string) => ({ id: 'cb1', data, message: { message_id: 42, text: 'tin gốc', chat: { id: Number(CHAT) } } })

test('Telegram: câu hỏi một đáp án → tin có câu hỏi + mỗi lựa chọn một nút + Bỏ qua; bấm nút → answerQuestion', async () => {
  const { a, calls, answered } = tgSetup()
  await a.onMessage({ type: 'permission', permission: questionReq() })
  const send = calls.find((c) => c.method === 'sendMessage')!
  assert.match(send.body.text, /❓ Claude hỏi: #7/)
  assert.match(send.body.text, /2\. Xanh lá — Màu xanh lá/)
  assert.match(send.body.text, /quá hạn Claude sẽ tự quyết/)
  const kb = send.body.reply_markup.inline_keyboard as { text: string; callback_data: string }[][]
  assert.deepEqual(kb.map((r) => r[0].callback_data), [`perm:${REQ_ID}:o0`, `perm:${REQ_ID}:o1`, `perm:${REQ_ID}:o2`, `perm:${REQ_ID}:deny`])
  for (const r of kb) assert.ok(Buffer.byteLength(r[0].callback_data) <= 64)

  await a.handleCallback(cq(`perm:${REQ_ID}:o1`), { token: TOKEN, chatId: CHAT })
  assert.deepEqual(answered, [[REQ_ID, { [QUESTION]: 'Xanh lá' }]])
  const ed = calls.find((c) => c.method === 'editMessageText')!
  assert.match(ed.body.text, /✅ Đã trả lời: Xanh lá lúc \d\d:\d\d$/)
})

test('Telegram: nhiều câu hoặc chọn nhiều → chỉ có Bỏ qua, nhắn trả lời trên web; Bỏ qua → deny', async () => {
  const { a, calls, decided } = tgSetup()
  const multi = q.parseQuestions({ questions: [{ question: 'A?', options: [{ label: 'x' }], multiSelect: true }] })
  await a.onMessage({ type: 'permission', permission: questionReq(multi) })
  const send = calls.find((c) => c.method === 'sendMessage')!
  assert.match(send.body.text, /A\? \(chọn nhiều\)/)
  assert.match(send.body.text, /Trả lời trên web: http/)
  assert.deepEqual(send.body.reply_markup.inline_keyboard.map((r: { callback_data: string }[]) => r[0].callback_data), [`perm:${REQ_ID}:deny`])
  // Nút số giả mạo cho câu nhiều đáp án → không trả lời, nhắn dùng web
  await a.handleCallback(cq(`perm:${REQ_ID}:o0`), { token: TOKEN, chatId: CHAT })
  assert.match(calls.at(-1)!.body.text, /trả lời câu hỏi này trên web/)
  await a.handleCallback(cq(`perm:${REQ_ID}:deny`), { token: TOKEN, chatId: CHAT })
  assert.deepEqual(decided, [[REQ_ID, 'deny']])
  assert.match(calls.find((c) => c.method === 'editMessageText')!.body.text, /⏭ Đã bỏ qua, Claude tự quyết/)
})

test('Telegram: trả lời trên web / hết hạn → sửa tin theo kiểu câu hỏi', async () => {
  const { a, calls } = tgSetup()
  await a.onMessage({ type: 'permission', permission: questionReq() })
  await a.onMessage({ type: 'permission', permission: { ...questionReq(), status: 'allowed' } })
  assert.match(calls.find((c) => c.method === 'editMessageText')!.body.text, /Đã xử lý trên web.*đã trả lời/)
  assert.match(tg.outsideResultLine('timeout', 0, true), /Claude tự quyết/)
  assert.deepEqual(tg.parseCallbackData(`perm:${REQ_ID}:o12`), { id: REQ_ID, action: 'option', option: 12 })
  assert.deepEqual(tg.parseCallbackData(`perm:${REQ_ID}:allow`), { id: REQ_ID, action: 'allow' })
  assert.equal(tg.parseCallbackData(`perm:${REQ_ID}:o`), undefined)
})
