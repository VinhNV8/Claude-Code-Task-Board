import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FRESH_SESSION_TOKENS, applyEscalation, decideEscalation, escalationPrompt, manualEscalationHint, maxTierForProject, nextTier, type EscalationInput, type PrevRun } from './escalation.ts'

const prev = (p: Partial<PrevRun> = {}): PrevRun => ({ kind: 'initial', requestedModel: 'haiku', modelSource: 'auto', exitCode: 1, failKind: 'claude', ...p })
const input = (o: Partial<EscalationInput> = {}): EscalationInput => ({
  kind: 'retry',
  prevRun: prev(),
  requestChangesCount: 0,
  autoEscalate: true,
  maxTier: 'opus',
  ...o,
})

test('nextTier: haiku → sonnet → opus, opus là trần, ID tự nhập không nâng', () => {
  assert.equal(nextTier('haiku'), 'sonnet')
  assert.equal(nextTier('sonnet'), 'opus')
  assert.equal(nextTier('opus'), undefined)
  assert.equal(nextTier('claude-haiku-4-5'), undefined)
  assert.equal(nextTier(undefined), undefined)
  assert.equal(nextTier(''), undefined)
})

test('A: Retry sau run Haiku lỗi do Claude → Sonnet, escalated, phiên mới không cần tóm tắt', () => {
  const e = decideEscalation(input())
  assert.deepEqual(e, { model: 'sonnet', source: 'escalated', reason: 'Nâng từ Haiku: lần chạy trước lỗi', freshSession: false })
  // Retry luôn là phiên mới, ngữ cảnh lớn cũng không dùng escalationPrompt
  assert.equal(decideEscalation(input({ prevRun: prev({ contextTokens: 200_000 }) }))?.freshSession, false)
  // Nâng tiếp từ run đã escalated
  assert.equal(decideEscalation(input({ prevRun: prev({ requestedModel: 'sonnet', modelSource: 'escalated' }) }))?.model, 'opus')
})

test('A: run trước bị Stop / giới hạn sử dụng / lỗi hạ tầng / thành công → không nâng', () => {
  for (const failKind of ['stopped', 'rate_limit', 'infra', undefined] as const)
    assert.equal(decideEscalation(input({ prevRun: prev({ failKind }) })), null, String(failKind))
})

test('A: chỉ áp dụng cho run retry', () => {
  for (const kind of ['initial', 'continue'] as const) assert.equal(decideEscalation(input({ kind })), null, kind)
})

test('Opus là trần; ID tự nhập và không truyền --model thì không nâng', () => {
  assert.equal(decideEscalation(input({ prevRun: prev({ requestedModel: 'opus' }) })), null)
  assert.equal(decideEscalation(input({ prevRun: prev({ requestedModel: 'claude-haiku-4-5' }) })), null)
  assert.equal(decideEscalation(input({ prevRun: prev({ requestedModel: undefined }) })), null)
})

test('B4: maxTier sonnet → không nâng quá sonnet', () => {
  assert.equal(decideEscalation(input({ maxTier: 'sonnet' }))?.model, 'sonnet')
  assert.equal(decideEscalation(input({ maxTier: 'sonnet', prevRun: prev({ requestedModel: 'sonnet' }) })), null)
  assert.equal(maxTierForProject('p1'), 'opus')
})

test('Model chọn tay lỗi → không nâng, có gợi ý', () => {
  const i = input({ prevRun: prev({ modelSource: 'manual' }) })
  assert.equal(decideEscalation(i), null)
  assert.equal(manualEscalationHint(i), 'Model chọn tay (Haiku) đã thất bại, cân nhắc chọn Sonnet')
  // Không phải manual hoặc không thuộc diện → không gợi ý
  assert.equal(manualEscalationHint(input()), null)
  assert.equal(manualEscalationHint(input({ prevRun: prev({ modelSource: 'manual', failKind: 'stopped' }) })), null)
  assert.equal(manualEscalationHint(input({ prevRun: prev({ modelSource: 'manual', requestedModel: 'opus' }) })), null)
})

test('autoEscalate=false → bỏ qua toàn bộ (kể cả gợi ý)', () => {
  assert.equal(decideEscalation(input({ autoEscalate: false })), null)
  assert.equal(manualEscalationHint(input({ autoEscalate: false, prevRun: prev({ modelSource: 'manual' }) })), null)
  assert.equal(decideEscalation(input({ autoEscalate: false, kind: 'resume', requestChangesCount: 3 })), null)
})

const review = (count: number, p: Partial<PrevRun> = {}) =>
  input({ kind: 'resume', requestChangesCount: count, prevRun: prev({ kind: 'initial', requestedModel: 'sonnet', exitCode: 0, failKind: undefined, ...p }) })

test('B: Request changes lần 1 giữ Sonnet, lần 2 → Opus', () => {
  assert.equal(decideEscalation(review(1)), null)
  const e = decideEscalation(review(2, { kind: 'resume' }))
  assert.deepEqual(e, { model: 'opus', source: 'escalated', reason: 'Nâng từ Sonnet: yêu cầu sửa lần 2', freshSession: false })
  assert.equal(decideEscalation(review(3, { requestedModel: 'opus', modelSource: 'escalated' })), null)
})

test('B: ngưỡng ngữ cảnh 80k → 79.999 resume, 80.000 phiên mới', () => {
  assert.equal(FRESH_SESSION_TOKENS, 80_000)
  assert.equal(decideEscalation(review(2, { contextTokens: 79_999 }))?.freshSession, false)
  assert.equal(decideEscalation(review(2, { contextTokens: 80_000 }))?.freshSession, true)
  assert.equal(decideEscalation(review(2, { contextTokens: undefined }))?.freshSession, false)
})

test('B: run resume trước bị gián đoạn (giới hạn sử dụng / mất phiên) → không nâng thêm bậc', () => {
  assert.equal(decideEscalation(review(2, { kind: 'resume', failKind: 'rate_limit', requestedModel: 'haiku' })), null)
  assert.equal(decideEscalation(review(2, { kind: 'resume', failKind: 'infra', requestedModel: 'haiku' })), null)
  // Run resume trước lỗi do Claude vẫn tính (lần yêu cầu sửa mới)
  assert.equal(decideEscalation(review(2, { kind: 'resume', failKind: 'claude', requestedModel: 'haiku' }))?.model, 'sonnet')
})

test('B: model chọn tay bị yêu cầu sửa lần 2 → gợi ý', () => {
  assert.equal(decideEscalation(review(2, { modelSource: 'manual' })), null)
  assert.equal(manualEscalationHint(review(2, { modelSource: 'manual' })), 'Model chọn tay (Sonnet) bị yêu cầu sửa lần 2, cân nhắc chọn Opus')
})

test('applyEscalation: thay model + ghi log; manual chỉ gợi ý; cấu hình task chọn tay thì không nâng', () => {
  const base = { requestedModel: 'haiku', modelSource: 'auto' as const, modelReason: 'prompt ngắn (−1)' }
  const a = applyEscalation(base, input())
  assert.deepEqual(a.choice, { requestedModel: 'sonnet', modelSource: 'escalated', modelReason: 'Nâng từ Haiku: lần chạy trước lỗi' })
  assert.equal(a.escalated, true)
  assert.deepEqual(a.notes, ['Nâng từ Haiku: lần chạy trước lỗi'])

  const m = applyEscalation({ ...base, modelSource: 'manual' as const }, input({ prevRun: prev({ modelSource: 'manual' }) }))
  assert.equal(m.choice.requestedModel, 'haiku')
  assert.equal(m.escalated, false)
  assert.deepEqual(m.notes, ['Model chọn tay (Haiku) đã thất bại, cân nhắc chọn Sonnet'])

  // Run trước auto lỗi nhưng người dùng vừa chọn tay model ở task → tôn trọng lựa chọn đó
  const t = applyEscalation({ requestedModel: 'haiku', modelSource: 'manual' as const, modelReason: 'Chọn ở task' }, input())
  assert.equal(t.escalated, false)
  assert.equal(t.choice.requestedModel, 'haiku')

  const f = applyEscalation({ requestedModel: 'sonnet', modelSource: 'auto' as const, modelReason: 'x' }, review(2, { contextTokens: 90_000 }))
  assert.equal(f.freshSession, true)
  assert.match(f.notes[0], /mở phiên mới/)

  assert.deepEqual(applyEscalation(base, input({ prevRun: prev({ failKind: 'stopped' }) })), { choice: base, escalated: false, freshSession: false, notes: [] })
})

test('escalationPrompt:yêu cầu gốc, tóm tắt run trước, feedback, hướng dẫn git', () => {
  const p = escalationPrompt({
    taskPrompt: 'Thêm trang login',
    lastSummary: 'Đã tạo Login.tsx',
    prevModel: 'sonnet',
    feedback: 'Thiếu validate email',
    branch: 'claude/task-7',
    mainBranch: 'main',
  })
  assert.match(p, /Yêu cầu gốc:\nThêm trang login/)
  assert.match(p, /Lần chạy trước \(model Sonnet\) đã làm:\nĐã tạo Login\.tsx/)
  assert.match(p, /Thiếu validate email/)
  assert.match(p, /git log main\.\.HEAD/)
  assert.match(p, /git diff main\.\.HEAD/)
  assert.match(p, /giữ những phần đúng/)
  assert.ok(p.indexOf('Yêu cầu gốc') < p.indexOf('Lần chạy trước') && p.indexOf('Lần chạy trước') < p.indexOf('Thiếu validate'))
  assert.match(escalationPrompt({ taskPrompt: 'x', mainBranch: 'dev', prevModel: 'claude-sonnet-4-5' }), /model claude-sonnet-4-5[\s\S]*không có tóm tắt/)
})
