import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKOFF_MAX_MS,
  activeConfig,
  callbackData,
  createTelegramApprover,
  createTelegramPoller,
  formatPermissionMessage,
  isConfiguredChat,
  nextBackoff,
  parseCallbackData,
  permissionKeyboard,
  type ApproveDeps,
  type CallbackQuery,
} from './telegramApprove.ts'
import { DEFAULT_TELEGRAM, type FetchLike } from './telegram.ts'
import { DEFAULT_SETTINGS } from './db.ts'
import type { PermissionRequest, Settings } from './types.ts'

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'
const CHAT = '111222333'
const REQ_ID = 'perm-0f8fad5b-d9cb-469f-a165-70867728950e'

interface Call {
  method: string
  body: Record<string, any>
}

/** fetch giả: ghi lại lời gọi, trả lời theo hàm `reply` (mặc định ok). */
function fakeFetch(reply: (c: Call) => { status?: number; result?: unknown; description?: string } | Error = () => ({})) {
  const calls: Call[] = []
  const impl: FetchLike = async (url, init) => {
    const c: Call = { method: url.split('/').pop()!, body: JSON.parse(init.body) }
    calls.push(c)
    const r = reply(c)
    if (r instanceof Error) throw r
    const status = r.status ?? 200
    return {
      ok: status < 300,
      status,
      json: async () => ({ ok: status < 300, result: r.result ?? true, description: r.description }),
    }
  }
  return { impl, calls }
}

const settingsWith = (over: Partial<Settings['telegram']> = {}, notifyNeeds = true): Settings => ({
  ...DEFAULT_SETTINGS,
  notifyOn: { ...DEFAULT_SETTINGS.notifyOn, needsInput: notifyNeeds },
  telegram: { ...DEFAULT_TELEGRAM, enabled: true, chatId: CHAT, appUrl: 'http://127.0.0.1:3000', hasToken: true, ...over },
})

const req = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: REQ_ID,
  taskId: 7,
  tool: 'Bash',
  input: 'npm test',
  risk: 'normal',
  createdAt: 0,
  timeoutAt: 30 * 60_000,
  status: 'pending',
  ...over,
})

function setup(opts: { settings?: Settings; decide?: ApproveDeps['decide']; reply?: Parameters<typeof fakeFetch>[0] } = {}) {
  const f = fakeFetch(
    opts.reply ?? ((c) => (c.method === 'sendMessage' ? { result: { message_id: 42, chat: { id: Number(CHAT) } } } : {})),
  )
  const decided: [string, string][] = []
  const logs: string[] = []
  const a = createTelegramApprover({
    fetchImpl: f.impl,
    getSettings: () => opts.settings ?? settingsWith(),
    getToken: () => TOKEN,
    getTask: (id) => ({ id, title: 'Sửa lỗi đăng nhập', projectId: 'p1' }),
    projectName: () => 'Web',
    decide:
      opts.decide ??
      ((id, d) => {
        decided.push([id, d])
      }),
    now: () => 0,
    log: (m) => logs.push(m),
  })
  return { a, calls: f.calls, decided, logs }
}

const cq = (data: string, chatId = Number(CHAT)): CallbackQuery => ({
  id: 'cb1',
  data,
  message: { message_id: 42, text: 'tin gốc', chat: { id: chatId } },
})

// ---------------------------------------------------------------- bàn phím, soạn tin

test('bàn phím: 3 nút, callback_data perm:<id>:<action> ≤ 64 byte', () => {
  const kb = permissionKeyboard(req())
  assert.deepEqual(
    kb.inline_keyboard[0].map((b) => b.text),
    ['✅ Cho phép', '♾ Luôn cho phép', '⛔ Từ chối'],
  )
  assert.deepEqual(
    kb.inline_keyboard[0].map((b) => b.callback_data),
    [`perm:${REQ_ID}:allow`, `perm:${REQ_ID}:always`, `perm:${REQ_ID}:deny`],
  )
  for (const b of kb.inline_keyboard[0]) assert.ok(Buffer.byteLength(b.callback_data) <= 64)
  assert.deepEqual(parseCallbackData(callbackData(REQ_ID, 'always')), { id: REQ_ID, action: 'always' })
  assert.equal(parseCallbackData('perm:x:hack'), undefined)
  assert.equal(parseCallbackData(undefined), undefined)
})

test('bàn phím: lệnh rủi ro cao không có "Luôn cho phép"', () => {
  const kb = permissionKeyboard(req({ risk: 'high' }))
  assert.deepEqual(
    kb.inline_keyboard[0].map((b) => b.callback_data.split(':').pop()),
    ['allow', 'deny'],
  )
})

test('soạn tin: task, tool, lệnh cắt ≤ 300 ký tự, hạn chờ, link', () => {
  const long = 'x'.repeat(1000)
  const text = formatPermissionMessage(req({ input: long, risk: 'high', riskReasons: ['xoá đệ quy'] }), { id: 7, title: 'Sửa lỗi' }, {
    projectName: 'Web',
    appUrl: 'http://h:3000',
    now: 0,
  })
  assert.match(text, /#7/)
  assert.match(text, /Sửa lỗi/)
  assert.match(text, /Công cụ: Bash/)
  const cmd = text.split('\n').find((l) => l.startsWith('Lệnh: '))!
  assert.ok(cmd.length - 'Lệnh: '.length <= 300)
  assert.match(text, /Rủi ro cao: xoá đệ quy/)
  assert.match(text, /Hạn chờ: \d\d:\d\d \(còn 30 phút/)
  assert.match(text, /http:\/\/h:3000\/tasks\/7/)
  assert.match(formatPermissionMessage(req({ tool: 'Edit', input: 'src/a.ts' }), undefined, { appUrl: '', now: 0 }), /Đường dẫn: src\/a.ts/)
})

test('activeConfig / isConfiguredChat', () => {
  assert.deepEqual(activeConfig(settingsWith(), TOKEN), { token: TOKEN, chatId: CHAT })
  assert.equal(activeConfig(settingsWith({ enabled: false }), TOKEN), undefined)
  assert.equal(activeConfig(settingsWith(), undefined), undefined)
  assert.equal(isConfiguredChat({ id: 111222333 }, CHAT), true)
  assert.equal(isConfiguredChat({ id: 999 }, CHAT), false)
  assert.equal(isConfiguredChat({ id: -100, username: 'My_Chan' }, '@my_chan'), true)
  assert.equal(isConfiguredChat(undefined, CHAT), false)
})

// ---------------------------------------------------------------- gửi / sửa tin theo bus

test('yêu cầu pending mới → sendMessage kèm bàn phím, chỉ gửi một lần', async () => {
  const { a, calls } = setup()
  await a.onMessage({ type: 'permission', permission: req() })
  await a.onMessage({ type: 'permission', permission: req() })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'sendMessage')
  assert.equal(calls[0].body.chat_id, CHAT)
  assert.deepEqual(calls[0].body.reply_markup, permissionKeyboard(req()))
  assert.equal(a.sent.get(REQ_ID)?.messageId, 42)
})

test('không gửi khi Telegram tắt hoặc notifyOn.needsInput = false', async () => {
  for (const s of [settingsWith({ enabled: false }), settingsWith({}, false)]) {
    const { a, calls } = setup({ settings: s })
    await a.onMessage({ type: 'permission', permission: req() })
    assert.equal(calls.length, 0)
  }
})

test('quyết định trên web / hết hạn → sửa tin, bỏ nút; lỗi sửa tin bị bỏ qua', async () => {
  for (const [status, re] of [
    ['allowed', /Đã xử lý trên web/],
    ['timeout', /Hết thời gian/],
  ] as const) {
    const { a, calls } = setup()
    await a.onMessage({ type: 'permission', permission: req() })
    await a.onMessage({ type: 'permission', permission: req({ status }) })
    const ed = calls[1]
    assert.equal(ed.method, 'editMessageText')
    assert.equal(ed.body.message_id, 42)
    assert.match(ed.body.text, re)
    assert.deepEqual(ed.body.reply_markup, { inline_keyboard: [] })
    assert.equal(a.sent.has(REQ_ID), false)
  }
  const { a } = setup({ reply: (c) => (c.method === 'sendMessage' ? { result: { message_id: 1 } } : { status: 400 }) })
  await a.onMessage({ type: 'permission', permission: req() })
  await a.onMessage({ type: 'permission', permission: req({ status: 'denied' }) }) // không ném
})

// ---------------------------------------------------------------- callback_query

test('callback đúng chat → decidePermission được gọi, trả lời và sửa tin', async () => {
  const { a, calls, decided } = setup()
  await a.onMessage({ type: 'permission', permission: req() })
  await a.handleCallback(cq(`perm:${REQ_ID}:always`), { token: TOKEN, chatId: CHAT })
  assert.deepEqual(decided, [[REQ_ID, 'always']])
  const ans = calls.find((c) => c.method === 'answerCallbackQuery')!
  assert.equal(ans.body.callback_query_id, 'cb1')
  const ed = calls.find((c) => c.method === 'editMessageText')!
  assert.match(ed.body.text, /♾ Đã luôn cho phép lúc \d\d:\d\d$/)
  assert.match(ed.body.text, /Claude xin quyền/) // giữ nội dung gốc
  assert.deepEqual(ed.body.reply_markup, { inline_keyboard: [] })
})

test('callback từ chat lạ → không gọi decidePermission, trả lời "Không có quyền"', async () => {
  const { a, calls, decided } = setup()
  await a.handleCallback(cq(`perm:${REQ_ID}:allow`, 999), { token: TOKEN, chatId: CHAT })
  assert.equal(decided.length, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'answerCallbackQuery')
  assert.equal(calls[0].body.text, 'Không có quyền')
})

test('quyết định trên Telegram không bị sửa thành "Đã xử lý trên web"', async () => {
  let a!: ReturnType<typeof setup>['a']
  const s = setup({
    decide: (id) => void a.onMessage({ type: 'permission', permission: req({ id, status: 'allowed' }) }), // settle() phát bus đồng bộ
  })
  a = s.a
  await a.onMessage({ type: 'permission', permission: req() })
  await a.handleCallback(cq(`perm:${REQ_ID}:allow`), { token: TOKEN, chatId: CHAT })
  const edits = s.calls.filter((c) => c.method === 'editMessageText')
  assert.equal(edits.length, 1)
  assert.match(edits[0].body.text, /✅ Đã cho phép lúc/)
})

test('request đã xử lý → "Yêu cầu đã được xử lý trước đó"', async () => {
  const err = Object.assign(new Error('Yêu cầu này đã được xử lý'), { statusCode: 409 })
  const { a, calls } = setup({
    decide: () => {
      throw err
    },
  })
  await a.handleCallback(cq(`perm:${REQ_ID}:deny`), { token: TOKEN, chatId: CHAT })
  assert.equal(calls.find((c) => c.method === 'answerCallbackQuery')!.body.text, 'Yêu cầu đã được xử lý trước đó')
  assert.deepEqual(calls.find((c) => c.method === 'editMessageText')!.body.reply_markup, { inline_keyboard: [] })
})

// ---------------------------------------------------------------- long polling

test('nextBackoff: 5s, nhân đôi, tối đa 60s', () => {
  const seq: number[] = []
  let b = 0
  for (let i = 0; i < 6; i++) seq.push((b = nextBackoff(b)))
  assert.deepEqual(seq, [5000, 10000, 20000, 40000, BACKOFF_MAX_MS, BACKOFF_MAX_MS])
})

test('poller: offset tăng sau mỗi update, chỉ chuyển callback_query, tham số getUpdates đúng', async () => {
  let offset = 0
  let round = 0
  const handled: string[] = []
  const f = fakeFetch((c) => {
    round++
    if (round === 1)
      return {
        result: [
          { update_id: 10, callback_query: { id: 'a', data: 'x', message: { message_id: 1, chat: { id: 1 } } } },
          { update_id: 11 },
          { update_id: 12, callback_query: { id: 'b', data: 'y', message: { message_id: 2, chat: { id: 1 } } } },
        ],
      }
    return { result: [] }
  })
  let n = 0
  const p = createTelegramPoller({
    fetchImpl: async (url, init) => {
      const r = await f.impl(url, init)
      if (++n === 2) void p.stop() // dừng sau vòng thứ 2
      return r
    },
    getConfig: () => ({ token: TOKEN, chatId: CHAT }),
    getOffset: () => offset,
    setOffset: (o) => (offset = o),
    onCallback: async (q) => {
      handled.push(q.id)
      if (q.id === 'a') throw new Error('lỗi xử lý') // không làm vỡ vòng lặp
    },
    log: () => {},
  })
  p.start()
  await p.done()
  assert.deepEqual(handled, ['a', 'b'])
  assert.equal(offset, 13)
  assert.equal(f.calls[0].body.timeout, 50)
  assert.deepEqual(f.calls[0].body.allowed_updates, ['callback_query'])
  assert.equal(f.calls[0].body.offset, undefined)
  assert.equal(f.calls[1].body.offset, 13)
})

test('poller: lỗi mạng → chờ 5s rồi tăng dần; 409 → ghi log và dừng', async () => {
  const waits: number[] = []
  const logs: string[] = []
  let n = 0
  const f = fakeFetch(() => (++n <= 3 ? new TypeError('fetch failed') : { status: 409, description: 'Conflict: webhook is active' }))
  const p = createTelegramPoller({
    fetchImpl: f.impl,
    getConfig: () => ({ token: TOKEN, chatId: CHAT }),
    getOffset: () => 0,
    setOffset: () => {},
    onCallback: async () => {},
    log: (m) => logs.push(m),
    sleep: async (ms) => void waits.push(ms),
  })
  assert.equal(p.start(), true)
  await p.done()
  assert.deepEqual(waits, [5000, 10000, 20000])
  assert.equal(p.isRunning(), false)
  assert.match(logs.at(-1)!, /webhook.*409/)
  assert.ok(logs.every((l) => !l.includes(TOKEN)))
  assert.equal(f.calls.filter((c) => c.method === 'deleteWebhook').length, 0)
})

test('poller: không chạy khi chưa cấu hình; refresh khởi động lại khi đổi cấu hình, stop dừng', async () => {
  let cfg: { token: string; chatId: string } | undefined
  const f = fakeFetch(() => ({ result: [] }))
  const p = createTelegramPoller({
    fetchImpl: async (url, init) => {
      // giả lập long poll: chờ tới khi bị huỷ
      await new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))
      return f.impl(url, init)
    },
    getConfig: () => cfg,
    getOffset: () => 0,
    setOffset: () => {},
    onCallback: async () => {},
    log: () => {},
  })
  assert.equal(p.start(), false)
  cfg = { token: TOKEN, chatId: CHAT }
  await p.refresh()
  assert.equal(p.isRunning(), true)
  cfg = undefined
  await p.refresh()
  assert.equal(p.isRunning(), false)
  cfg = { token: TOKEN, chatId: CHAT }
  await p.refresh()
  assert.equal(p.isRunning(), true)
  await p.stop()
  assert.equal(p.isRunning(), false)
})
