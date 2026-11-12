import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HttpError } from './httpError.ts'
import {
  autoModelNote,
  chooseRunModel,
  fallbackModelFor,
  isValidModel,
  modelChoiceFor,
  modelSuggestFor,
  normalizeModel,
  resolveModelSetting,
} from './model.ts'

test('isValidModel: alias và ID claude-…', () => {
  for (const v of ['haiku', 'sonnet', 'opus', 'claude-haiku-4-5', 'claude-opus-4-1-20250805']) assert.ok(isValidModel(v), v)
  for (const v of ['', 'auto', 'Haiku', 'gpt-4', 'claude-', 'claude-Opus', 'claude-opus 4', 'claude-opus;rm', '--model']) assert.ok(!isValidModel(v), v)
})

test('normalizeModel: trim + lowercase, rỗng → ""', () => {
  assert.equal(normalizeModel('  Sonnet '), 'sonnet')
  assert.equal(normalizeModel('CLAUDE-HAIKU-4-5'), 'claude-haiku-4-5')
  assert.equal(normalizeModel(''), '')
  assert.equal(normalizeModel('   '), '')
  assert.equal(normalizeModel(undefined), '')
  assert.equal(normalizeModel(null), '')
  // P5-04: 'auto' hợp lệ ở mọi tầng cấu hình
  assert.equal(normalizeModel(' Auto '), 'auto')
})

test('normalizeModel: giá trị sai → HttpError 400 tiếng Việt', () => {
  for (const v of ['gpt-4', 'autox', 'claude opus', 42, {}, 'claude-' + 'x'.repeat(200)]) {
    assert.throws(
      () => normalizeModel(v),
      (e: unknown) => e instanceof HttpError && e.status === 400 && e.message.startsWith('Model không hợp lệ:'),
      String(v),
    )
  }
})

test('resolveModelSetting: giá trị không rỗng đầu tiên Task → Project → Settings', () => {
  const cases: [string | undefined, string | undefined, string | undefined, string | undefined, string][] = [
    ['haiku', 'sonnet', 'opus', 'haiku', 'task'],
    ['haiku', undefined, undefined, 'haiku', 'task'],
    ['', 'sonnet', 'opus', 'sonnet', 'project'],
    [undefined, 'sonnet', '', 'sonnet', 'project'],
    [undefined, undefined, 'opus', 'opus', 'settings'],
    ['', '', 'opus', 'opus', 'settings'],
    ['  ', ' ', ' ', undefined, 'none'],
    [undefined, undefined, undefined, undefined, 'none'],
    ['', '', '', undefined, 'none'],
  ]
  for (const [t, p, s, value, level] of cases)
    assert.deepEqual(resolveModelSetting({ model: t }, { defaultModel: p }, { defaultModel: s }), { value, level }, JSON.stringify([t, p, s]))
})

test('modelChoiceFor: task = manual, còn lại = default kèm lý do', () => {
  assert.deepEqual(modelChoiceFor('task'), { modelSource: 'manual', modelReason: 'Chọn ở task' })
  assert.deepEqual(modelChoiceFor('project'), { modelSource: 'default', modelReason: 'Mặc định của project' })
  assert.deepEqual(modelChoiceFor('settings'), { modelSource: 'default', modelReason: 'Mặc định hệ thống' })
  assert.deepEqual(modelChoiceFor('none'), { modelSource: 'default', modelReason: 'Mặc định của Claude CLI' })
})

test('chooseRunModel: initial/retry resolve 3 tầng', () => {
  const prev = { requestedModel: 'haiku', modelSource: 'manual' as const, modelReason: 'Chọn ở task' }
  assert.deepEqual(chooseRunModel('initial', undefined, {}, { defaultModel: 'sonnet' }, { defaultModel: '' }), {
    requestedModel: 'sonnet',
    modelSource: 'default',
    modelReason: 'Mặc định của project',
  })
  // retry không giữ model run trước mà resolve lại
  assert.equal(chooseRunModel('retry', prev, {}, { defaultModel: 'opus' }, { defaultModel: '' }).requestedModel, 'opus')
  assert.deepEqual(chooseRunModel('initial', undefined, {}, {}, { defaultModel: '' }), {
    requestedModel: undefined,
    modelSource: 'default',
    modelReason: 'Mặc định của Claude CLI',
  })
})

test('chooseRunModel: resume/continue dùng lại model run trước dù cấu hình đã đổi (D3)', () => {
  const prev = { requestedModel: 'haiku', modelSource: 'manual' as const, modelReason: 'Chọn ở task' }
  for (const kind of ['resume', 'continue'] as const) {
    const c = chooseRunModel(kind, prev, { model: '' }, { defaultModel: 'opus' }, { defaultModel: 'sonnet' })
    assert.deepEqual(c, { requestedModel: 'haiku', modelSource: 'manual', modelReason: 'Chọn ở task (giữ từ lần chạy trước)' })
    // Chuỗi resume liên tiếp không lặp hậu tố
    assert.equal(chooseRunModel(kind, c, {}, {}, {}).modelReason, 'Chọn ở task (giữ từ lần chạy trước)')
  }
  // Run trước không truyền --model → resume cũng không truyền
  const none = chooseRunModel(
    'resume',
    { requestedModel: undefined, modelSource: 'default', modelReason: 'Mặc định của Claude CLI' },
    {},
    { defaultModel: 'opus' },
    {},
  )
  assert.equal(none.requestedModel, undefined)
  // Run cũ (trước P5-03) không có thông tin model
  assert.deepEqual(chooseRunModel('continue', {}, {}, { defaultModel: 'opus' }, {}), {
    requestedModel: undefined,
    modelSource: 'default',
    modelReason: 'Giữ model của lần chạy trước',
  })
  // Không có run trước → resolve như bình thường
  assert.equal(chooseRunModel('resume', undefined, {}, { defaultModel: 'opus' }, {}).requestedModel, 'opus')
})

// ---------------------------------------------------------------- P5-04: 'auto'

const hardTask = {
  title: 'Refactor runner.ts tách quản lý process, tránh race condition',
  prompt: 'Tách phần quản lý process con ra module riêng.',
  tags: ['refactor'],
  permissionMode: 'acceptEdits' as const,
}
const easyTask = { title: 'Sửa typo trong README', prompt: 'Sửa chữ "recieve".', tags: [], permissionMode: 'acceptEdits' as const }

test('chooseRunModel: settings auto → gọi bộ chọn, source auto, lý do = reasons', () => {
  for (const kind of ['initial', 'retry'] as const) {
    const c = chooseRunModel(kind, undefined, hardTask, {}, { defaultModel: 'auto' })
    assert.equal(c.requestedModel, 'opus')
    assert.equal(c.modelSource, 'auto')
    assert.equal(c.modelReason, c.suggestion!.reasons.join('; '))
    assert.match(c.modelReason, /tag "refactor" \(\+3\)/)
  }
  // auto ở tầng task / project cũng dùng bộ chọn
  assert.equal(chooseRunModel('initial', undefined, { ...easyTask, model: 'auto' }, { defaultModel: 'opus' }, {}).requestedModel, 'haiku')
  assert.equal(chooseRunModel('initial', undefined, easyTask, { defaultModel: 'auto' }, { defaultModel: 'opus' }).modelSource, 'auto')
  // Chọn tay ở task thắng 'auto' của tầng dưới
  const manual = chooseRunModel('initial', undefined, { ...hardTask, model: 'haiku' }, {}, { defaultModel: 'auto' })
  assert.deepEqual(manual, { requestedModel: 'haiku', modelSource: 'manual', modelReason: 'Chọn ở task' })
})

test('chooseRunModel + buildClaudeArgs: settings auto → --model đúng alias gợi ý; resume giữ model cũ (D3)', async () => {
  const { buildClaudeArgs } = await import('./permissionTool.ts')
  const argsFor = (model: string | undefined) =>
    buildClaudeArgs({ sessionId: 's', resume: false, permissionMode: 'acceptEdits', allowedTools: [], model })
  const first = chooseRunModel('initial', undefined, easyTask, {}, { defaultModel: 'auto' })
  const a = argsFor(first.requestedModel)
  assert.equal(a[a.indexOf('--model') + 1], 'haiku')

  // Resume sau khi task được sửa thành khó: vẫn giữ haiku của run trước, không gợi ý lại
  const resumed = chooseRunModel('resume', first, hardTask, {}, { defaultModel: 'auto' })
  assert.equal(resumed.requestedModel, 'haiku')
  assert.equal(resumed.modelSource, 'auto')
  assert.equal(resumed.suggestion, undefined)
  assert.ok(resumed.modelReason.endsWith('(giữ từ lần chạy trước)'))
  const b = argsFor(resumed.requestedModel)
  assert.equal(b[b.indexOf('--model') + 1], 'haiku')

  // Retry thì chấm lại
  assert.equal(chooseRunModel('retry', first, hardTask, {}, { defaultModel: 'auto' }).requestedModel, 'opus')
})

test('autoModelNote: dòng log hệ thống', () => {
  const c = chooseRunModel('initial', undefined, hardTask, {}, { defaultModel: 'auto' })
  assert.equal(autoModelNote(c.suggestion!), `Tự chọn model: Opus — ${c.modelReason}`)
})

test('modelSuggestFor: chỉ trả suggestion khi hiệu lực là auto', () => {
  const r = modelSuggestFor(easyTask, {}, { defaultModel: 'auto' })
  assert.deepEqual(r.effective, { value: 'auto', level: 'settings' })
  assert.equal(r.suggestion?.model, 'haiku')
  const p = modelSuggestFor(easyTask, { defaultModel: 'opus' }, { defaultModel: 'auto' })
  assert.deepEqual(p, { effective: { value: 'opus', level: 'project' } })
  assert.deepEqual(modelSuggestFor({}, {}, { defaultModel: '' }), { effective: { value: undefined, level: 'none' } })
  // Rỗng: chỉ có "prompt ngắn (−1)" → sonnet
  assert.deepEqual(modelSuggestFor({}, { defaultModel: 'auto' }, {}).suggestion, { model: 'sonnet', score: -1, reasons: ['prompt ngắn (−1)'] })
})

test('fallbackModelFor: chỉ opus mới có fallback sonnet', () => {
  assert.equal(fallbackModelFor('opus'), 'sonnet')
  assert.equal(fallbackModelFor('claude-opus-4-1'), 'sonnet')
  assert.equal(fallbackModelFor('sonnet'), undefined)
  assert.equal(fallbackModelFor('haiku'), undefined)
  assert.equal(fallbackModelFor(undefined), undefined)
})
