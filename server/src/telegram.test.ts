import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TELEGRAM,
  TelegramError,
  createTelegramNotifier,
  formatTaskMessage,
  mergeTelegram,
  sendTelegram,
  shouldNotify,
  type FetchLike,
  type TelegramConfig,
} from './telegram.ts'
import type { Settings, Task } from './types.ts'

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'
const ALL_ON = { review: true, needsInput: true, failed: true }

const isTgErr = (re: RegExp) => (e: unknown) => e instanceof TelegramError && re.test(e.message)

test('mergeTelegram: giữ token khi bỏ trống, xoá khi rỗng/null, kiểm tra định dạng', () => {
  const cur = { ...DEFAULT_TELEGRAM, chatId: '111', hasToken: true }
  assert.deepEqual(mergeTelegram(cur, { enabled: true }), { telegram: { enabled: true, chatId: '111', appUrl: '' }, token: undefined })
  assert.equal(mergeTelegram(cur, { botToken: '' }).token, null)
  assert.equal(mergeTelegram(cur, { botToken: null }).token, null)
  assert.equal(mergeTelegram(cur, { botToken: ` ${TOKEN} ` }).token, TOKEN)
  assert.equal(mergeTelegram(cur, { chatId: ' -1001234567890 ' }).telegram.chatId, '-1001234567890')
  assert.equal(mergeTelegram(cur, { chatId: '@my_channel' }).telegram.chatId, '@my_channel')
  assert.equal(mergeTelegram(cur, { appUrl: 'http://127.0.0.1:3000/' }).telegram.appUrl, 'http://127.0.0.1:3000')
  assert.throws(() => mergeTelegram(cur, { botToken: 'abc' }), isTgErr(/định dạng/))
  assert.throws(() => mergeTelegram(cur, { chatId: 'abc def' }), isTgErr(/Chat ID/))
  assert.throws(() => mergeTelegram(cur, { appUrl: 'ftp://x' }), isTgErr(/http/))
  assert.throws(() => mergeTelegram(cur, { appUrl: 'không phải url' }), isTgErr(/URL/))
})

test('shouldNotify: chỉ khi đổi sang Review / Needs Input / Failed và được bật', () => {
  assert.equal(shouldNotify('running', 'review', ALL_ON), true)
  assert.equal(shouldNotify('running', 'needs_input', ALL_ON), true)
  assert.equal(shouldNotify('running', 'failed', ALL_ON), true)
  assert.equal(shouldNotify(undefined, 'failed', ALL_ON), true)
  assert.equal(shouldNotify('review', 'review', ALL_ON), false)
  assert.equal(shouldNotify('queued', 'running', ALL_ON), false)
  assert.equal(shouldNotify('review', 'done', ALL_ON), false)
  assert.equal(shouldNotify('running', 'review', { ...ALL_ON, review: false }), false)
})

test('formatTaskMessage: tiêu đề theo trạng thái, project, lý do lỗi và liên kết mở task', () => {
  const msg = formatTaskMessage({ id: 7, title: 'Sửa lỗi login', status: 'failed', failReason: 'Hết lượt' }, { projectName: 'Web', appUrl: 'http://127.0.0.1:3000/' })
  assert.match(msg, /Task lỗi: #7/)
  assert.match(msg, /Sửa lỗi login/)
  assert.match(msg, /Project: Web/)
  assert.match(msg, /Lý do: Hết lượt/)
  assert.match(msg, /Mở task: http:\/\/127\.0\.0\.1:3000\/tasks\/7$/)
  assert.match(formatTaskMessage({ id: 1, title: 'x', status: 'review' }, { appUrl: '' }), /Cần review: #1/)
  assert.doesNotMatch(formatTaskMessage({ id: 1, title: 'x', status: 'review' }, { appUrl: '' }), /Mở task/)
})

function fakeFetch(status: number, body: unknown = {}, calls: { url: string; body: string }[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, body: init.body })
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
}

test('sendTelegram: gọi đúng Bot API và đổi lỗi sang tiếng Việt, không lộ token', async () => {
  const calls: { url: string; body: string }[] = []
  await sendTelegram({ token: TOKEN, chatId: '42' }, 'hi', fakeFetch(200, { ok: true }, calls))
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`)
  assert.deepEqual(JSON.parse(calls[0].body), { chat_id: '42', text: 'hi', disable_web_page_preview: true })

  const cfg = { token: TOKEN, chatId: '42' }
  await assert.rejects(sendTelegram(cfg, 'x', fakeFetch(401)), isTgErr(/token không hợp lệ/))
  await assert.rejects(sendTelegram(cfg, 'x', fakeFetch(400, { description: 'Bad Request: chat not found' })), isTgErr(/Không tìm thấy chat/))
  await assert.rejects(sendTelegram(cfg, 'x', fakeFetch(403)), isTgErr(/không được phép/))
  await assert.rejects(
    sendTelegram(cfg, 'x', fakeFetch(500, { description: `boom ${TOKEN}` })),
    (e: unknown) => e instanceof TelegramError && !e.message.includes(TOKEN) && /HTTP 500/.test(e.message),
  )
  await assert.rejects(
    sendTelegram(cfg, 'x', async () => {
      throw new Error(`fetch failed https://api.telegram.org/bot${TOKEN}`)
    }),
    (e: unknown) => e instanceof TelegramError && !e.message.includes(TOKEN) && /Không kết nối/.test(e.message),
  )
  await assert.rejects(sendTelegram({ token: '', chatId: '42' }, 'x', fakeFetch(200)), isTgErr(/bot token/))
})

const task = (id: number, status: Task['status']): Task => ({
  id,
  projectId: 'p1',
  title: `Task ${id}`,
  prompt: 'prompt dài hơn mười ký tự',
  status,
  priority: 'normal',
  permissionMode: 'acceptEdits',
  tags: [],
  createdAt: 0,
  updatedAt: 0,
})

function setup(over: Partial<Settings['telegram']> = {}, tokenArg: string | null = TOKEN, send?: (c: TelegramConfig, t: string) => Promise<void>) {
  // null = chưa có token (truyền undefined sẽ bị tham số mặc định thay bằng TOKEN)
  const token = tokenArg ?? undefined
  const sent: { cfg: TelegramConfig; text: string }[] = []
  const logs: string[] = []
  const s: Settings = {
    maxParallel: 2,
    browserNotifications: false,
    notifyOn: { ...ALL_ON },
    permissionTimeoutMin: 30,
    defaultModel: '',
    autoEscalate: true,
    telegram: { enabled: true, chatId: '42', appUrl: 'http://h', hasToken: !!token, ...over },
  }
  const handle = createTelegramNotifier({
    initial: [task(1, 'review'), task(2, 'running')],
    getSettings: () => s,
    getToken: () => token,
    projectName: () => 'Proj',
    send:
      send ??
      (async (cfg, text) => {
        sent.push({ cfg, text })
      }),
    log: (m) => logs.push(m),
  })
  return { handle, sent, logs, s }
}

test('notifier: gửi khi chuyển trạng thái, không gửi lại khi trạng thái giữ nguyên', async () => {
  const { handle, sent, s } = setup()
  await handle({ type: 'task', task: task(1, 'review') }) // đã ở Review từ trước
  await handle({ type: 'task', task: task(2, 'running') })
  assert.equal(sent.length, 0)
  await handle({ type: 'task', task: task(2, 'needs_input') })
  await handle({ type: 'task', task: task(2, 'needs_input') })
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].cfg, { token: TOKEN, chatId: '42' })
  assert.match(sent[0].text, /Claude cần bạn: #2[\s\S]*Project: Proj[\s\S]*http:\/\/h\/tasks\/2/)
  s.notifyOn.review = false
  await handle({ type: 'task', task: task(2, 'review') })
  assert.equal(sent.length, 1)
  await handle({ type: 'event' })
  assert.equal(sent.length, 1)
})

test('notifier: không gửi khi tắt, thiếu chat ID hoặc thiếu token', async () => {
  for (const [over, token] of [[{ enabled: false }, TOKEN], [{ chatId: '' }, TOKEN], [{}, null]] as const) {
    const { handle, sent } = setup(over, token)
    await handle({ type: 'task', task: task(2, 'failed') })
    assert.equal(sent.length, 0)
  }
})

test('notifier: lỗi gửi chỉ ghi log, không ném ra luồng chính', async () => {
  const { handle, logs } = setup({}, TOKEN, async () => {
    throw new TelegramError('Bot token không hợp lệ hoặc đã bị thu hồi')
  })
  await assert.doesNotReject(async () => handle({ type: 'task', task: task(2, 'failed') }))
  assert.equal(logs.length, 1)
  assert.match(logs[0], /#2 thất bại: Bot token không hợp lệ/)

  const { handle: h2, logs: l2 } = setup({}, TOKEN, () => {
    throw new Error('đồng bộ')
  })
  assert.doesNotThrow(() => h2({ type: 'task', task: task(2, 'failed') }))
  assert.equal(l2.length, 1)
})
