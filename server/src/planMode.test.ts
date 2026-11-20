// SPEC-PLAN-HANDOFF Phần A: hàm thuần của planMode (giá trị, mức quyền theo giai đoạn, prompt từng lượt).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  awaitingPlanApproval,
  executePrompt,
  initialPhase,
  normalizePlanMode,
  PLAN_INSTRUCTION,
  planPrompt,
  replanPrompt,
  runPermissionMode,
} from '../../web/src/lib/planMode.ts'

test('normalizePlanMode: tên kỹ thuật, tiếng Việt có/không dấu; trống → undefined; lạ → giữ nguyên để báo lỗi', () => {
  assert.equal(normalizePlanMode('first'), 'first')
  assert.equal(normalizePlanMode('Kế hoạch trước'), 'first')
  assert.equal(normalizePlanMode('lap ke hoach truoc'), 'first')
  assert.equal(normalizePlanMode('Chỉ kế hoạch'), 'only')
  assert.equal(normalizePlanMode('plan'), 'only', 'cột permission_mode=plan cũ hiểu là chỉ kế hoạch (A5)')
  assert.equal(normalizePlanMode('Làm luôn'), 'none')
  assert.equal(normalizePlanMode('  '), undefined)
  assert.equal(normalizePlanMode(undefined), undefined)
  assert.equal(normalizePlanMode('abc'), 'abc')
})

test('initialPhase / runPermissionMode: lượt Kế hoạch luôn chạy mode plan kể cả project Auto (AC-43)', () => {
  assert.equal(initialPhase('none'), undefined)
  assert.equal(initialPhase(undefined), undefined)
  assert.equal(initialPhase('first'), 'plan')
  assert.equal(initialPhase('only'), 'plan')
  assert.equal(runPermissionMode('auto', 'plan'), 'plan')
  assert.equal(runPermissionMode('auto', 'execute'), 'auto', 'AC-44: lượt Thực hiện dùng mức quyền hiện tại')
  assert.equal(runPermissionMode('manual', undefined), 'manual')
})

test('awaitingPlanApproval: chỉ Review của lượt Kế hoạch', () => {
  assert.equal(awaitingPlanApproval({ status: 'review', planPhase: 'plan' }), true)
  assert.equal(awaitingPlanApproval({ status: 'review', planPhase: 'execute' }), false)
  assert.equal(awaitingPlanApproval({ status: 'running', planPhase: 'plan' }), false)
  assert.equal(awaitingPlanApproval({ status: 'review' }), false)
})

test('prompt lượt Kế hoạch / Góp ý / Thực hiện', () => {
  assert.ok(planPrompt('Thêm API').startsWith('Thêm API'))
  assert.ok(planPrompt('Thêm API').includes(PLAN_INSTRUCTION))

  const resumed = replanPrompt({ feedback: 'Bỏ bước 3', resume: true, taskPrompt: 'Thêm API' })
  assert.ok(resumed.includes('Bỏ bước 3') && resumed.includes(PLAN_INSTRUCTION) && !resumed.includes('Thêm API'))
  const fresh = replanPrompt({ feedback: 'Bỏ bước 3', resume: false, taskPrompt: 'Thêm API', lastPlan: 'KH cũ' })
  assert.ok(fresh.startsWith('Thêm API') && fresh.includes('KH cũ'))

  const exec = executePrompt({ approvedPlan: '  ## Các bước\n1. Sửa a  ', resume: true, taskPrompt: 'Thêm API' })
  assert.ok(exec.includes('## Các bước\n1. Sửa a') && !exec.includes('Thêm API'), 'AC-45: gửi đúng bản đã duyệt')
  assert.ok(executePrompt({ approvedPlan: 'KH', resume: false, taskPrompt: 'Thêm API' }).startsWith('Thêm API'), 'AC-47: phiên mới kèm prompt gốc')
})
