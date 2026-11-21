// SPEC-PLAN-HANDOFF FR-106: duyệt kế hoạch qua Telegram (tin kèm kế hoạch + nút Duyệt). Không mạng, không DB.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PLAN_PREVIEW_MAX,
  createTelegramApprover,
  formatPlanMessage,
  parsePlanCallback,
  planCallbackData,
  planKeyboard,
  type CallbackQuery,
  type PendingPlan,
} from './telegramApprove.ts'
import { DEFAULT_TELEGRAM, type FetchLike } from './telegram.ts'
import { DEFAULT_SETTINGS } from './db.ts'
import type { Settings, Task } from './types.ts'

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'
const CHAT = '111222333'

const settingsWith = (review = true): Settings => ({
  ...DEFAULT_SETTINGS,
  notifyOn: { ...DEFAULT_SETTINGS.notifyOn, review },
  telegram: { ...DEFAULT_TELEGRAM, enabled: true, chatId: CHAT, appUrl: 'http://127.0.0.1:3000', hasToken: true },
})

const plan = (over: Partial<PendingPlan> = {}): PendingPlan => ({
  task: { id: 9, title: 'Thêm API báo cáo', projectId: 'p1', planMode: 'first' },
  runId: 'run-1',
  plan: '## Các bước\n1. Sửa a.ts',
  ...over,
})
const task = { id: 9, status: 'review' } as Task

function setup(o: { pending?: () => PendingPlan | undefined; approve?: (id: number) => Promise<unknown>; settings?: Settings } = {}) {
  const calls: { method: string; body: Record<string, any> }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const c = { method: url.split('/').pop()!, body: JSON.parse(init.body) }
    calls.push(c)
    return { ok: true, status: 200, json: async () => ({ ok: true, result: c.method === 'sendMessage' ? { message_id: 77 } : true }) }
  }
  const approved: number[] = []
  let current: PendingPlan | undefined = plan()
  const a = createTelegramApprover({
    fetchImpl,
    getSettings: () => o.settings ?? settingsWith(),
    getToken: () => TOKEN,
    getTask: (id) => ({ id, title: 't', projectId: 'p1' }),
    projectName: () => 'Web',
    decide: () => {},
    pendingPlan: o.pending ?? (() => current),
    approvePlan:
      o.approve ??
      (async (id) => {
        approved.push(id)
        current = undefined
      }),
    now: () => 0,
    log: () => {},
  })
  return { a, calls, approved, setPending: (p?: PendingPlan) => (current = p) }
}

const cq = (data: string, chatId = Number(CHAT)): CallbackQuery => ({ id: 'cb', data, message: { message_id: 77, text: 'tin', chat: { id: chatId } } })

test('soạn tin: tiêu đề theo cách làm, kế hoạch dài bị cắt, nút đúng nhãn, callback ≤ 64 byte', () => {
  const first = formatPlanMessage(plan(), { projectName: 'Web', appUrl: 'http://x' })
  assert.ok(first.startsWith('📝 Kế hoạch chờ duyệt: #9') && first.includes('## Các bước') && first.includes('http://x/tasks/9'))
  const long = formatPlanMessage(plan({ plan: 'a'.repeat(PLAN_PREVIEW_MAX + 50) }), { appUrl: '' })
  assert.ok(long.includes('đã cắt bớt') && long.length < PLAN_PREVIEW_MAX + 300)
  const only = plan({ task: { ...plan().task, planMode: 'only' } })
  assert.ok(formatPlanMessage(only, { appUrl: '' }).startsWith('📝 Kết quả phân tích chờ duyệt'))
  assert.equal(planKeyboard(plan()).inline_keyboard[0][0].text, '▶️ Duyệt và thực hiện')
  assert.equal(planKeyboard(only).inline_keyboard[0][0].text, '✅ Chấp nhận kết quả')
  assert.ok(Buffer.byteLength(planCallbackData(123456789)) <= 64)
  assert.deepEqual(parsePlanCallback('plan:9:approve'), { taskId: 9 })
  assert.equal(parsePlanCallback('plan:x:approve'), undefined)
})

test('task vào bước duyệt kế hoạch: gửi một tin có nút; bus phát lại không gửi trùng; lượt Kế hoạch mới gửi tin mới', async () => {
  const { a, calls, setPending } = setup()
  await a.onMessage({ type: 'task', task })
  await a.onMessage({ type: 'task', task })
  assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 1)
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].callback_data, 'plan:9:approve')
  setPending(plan({ runId: 'run-2', plan: '## KH sau góp ý' }))
  await a.onMessage({ type: 'task', task })
  assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 2)
})

test('tắt thông báo Review: không gửi', async () => {
  const { a, calls } = setup({ settings: settingsWith(false) })
  await a.onMessage({ type: 'task', task })
  assert.equal(calls.length, 0)
})

test('bấm Duyệt: gọi approvePlan, sửa tin "Đã duyệt", bỏ nút; nút từ chat lạ bị từ chối', async () => {
  const { a, calls, approved } = setup()
  await a.onMessage({ type: 'task', task })
  await a.handleCallback(cq('plan:9:approve', 999), { token: TOKEN, chatId: CHAT })
  assert.deepEqual(approved, [], 'chat lạ')
  await a.handleCallback(cq('plan:9:approve'), { token: TOKEN, chatId: CHAT })
  assert.deepEqual(approved, [9])
  const edit = calls.filter((c) => c.method === 'editMessageText').at(-1)!
  assert.match(edit.body.text, /✅ Đã duyệt/)
  assert.deepEqual(edit.body.reply_markup, { inline_keyboard: [] })
})

test('duyệt trên web trước: tin Telegram được sửa, bấm nút sau đó báo đã xử lý', async () => {
  const { a, calls, setPending } = setup({
    approve: async () => {
      throw Object.assign(new Error('Task #9 không ở bước duyệt kế hoạch'), { statusCode: 409 })
    },
  })
  await a.onMessage({ type: 'task', task })
  setPending(undefined)
  await a.onMessage({ type: 'task', task: { ...task, status: 'queued' } as Task })
  assert.match(calls.filter((c) => c.method === 'editMessageText').at(-1)!.body.text, /Đã xử lý trên web/)
  await a.handleCallback(cq('plan:9:approve'), { token: TOKEN, chatId: CHAT })
  assert.match(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)!.body.text, /đã được xử lý/)
})
