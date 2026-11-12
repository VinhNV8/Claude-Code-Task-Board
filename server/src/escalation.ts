// P5-06 (PLAN P5, D6): Lớp 3 — tự nâng model một bậc khi task thất bại. Hàm thuần, không đụng DB.
import { MODEL_ALIASES, type ModelAlias } from './model.ts'
import { maxTierForLevel, type BudgetLevel } from './budget.ts'
import type { ModelSource, Run, RunKind } from './types.ts'

/** Ngữ cảnh ≥ ngưỡng này thì nâng model bằng phiên mới kèm tóm tắt thay vì `--resume` (D6: cache gắn với từng model). */
export const FRESH_SESSION_TOKENS = 80_000

const LABEL: Record<ModelAlias, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

const asAlias = (m: string | undefined): ModelAlias | undefined =>
  (MODEL_ALIASES as readonly string[]).includes(m ?? '') ? (m as ModelAlias) : undefined

/** Bậc kế tiếp haiku → sonnet → opus. Opus là trần; ID tự nhập (không phải alias) không nâng (D1). */
export function nextTier(alias: string | undefined): ModelAlias | undefined {
  const a = asAlias(alias)
  if (!a) return undefined
  return MODEL_ALIASES[MODEL_ALIASES.indexOf(a) + 1]
}

const tierIndex = (a: ModelAlias) => MODEL_ALIASES.indexOf(a)

/** `failKind` (runs.fail_kind): chỉ 'claude' mới tính là model làm hỏng. */
export type PrevRun = Pick<Run, 'kind' | 'requestedModel' | 'modelSource' | 'contextTokens' | 'exitCode' | 'failKind'>

export interface EscalationInput {
  kind: RunKind
  /** Run gần nhất của task (trước run sắp tạo). */
  prevRun: PrevRun | undefined
  /** Số review `request_changes` của task, tính cả lần đang gửi. */
  requestChangesCount: number
  autoEscalate: boolean
  /** B4 (P6): trần model của project. */
  maxTier: ModelAlias
}

export interface Escalation {
  model: ModelAlias
  source: Extract<ModelSource, 'escalated'>
  reason: string
  /** true: mở phiên mới (không `--resume`) và dùng escalationPrompt. */
  freshSession: boolean
}

type Trigger = { why: 'failed' } | { why: 'request_changes'; count: number }

/**
 * Run sắp chạy có thuộc diện nâng model không (bỏ qua autoEscalate / manual / trần):
 * - A: run 'retry' sau run lỗi do Claude (không tính Stop, giới hạn sử dụng, lỗi hạ tầng).
 * - B: run 'resume' từ lần Request changes thứ 2 trở đi. Run trước là chính run resume này bị gián đoạn
 *   (giới hạn sử dụng / mất phiên) thì không tính lại, để một lần yêu cầu sửa chỉ nâng tối đa một bậc.
 */
function trigger(o: Pick<EscalationInput, 'kind' | 'prevRun' | 'requestChangesCount'>): Trigger | undefined {
  const prev = o.prevRun
  if (!prev) return undefined
  if (o.kind === 'retry' && prev.failKind === 'claude') return { why: 'failed' }
  if (o.kind === 'resume' && o.requestChangesCount >= 2) {
    if (prev.kind === 'resume' && (prev.failKind === 'rate_limit' || prev.failKind === 'infra')) return undefined
    return { why: 'request_changes', count: o.requestChangesCount }
  }
  return undefined
}

const whyText = (t: Trigger) => (t.why === 'failed' ? 'lần chạy trước lỗi' : `yêu cầu sửa lần ${t.count}`)

/** Quyết định nâng model cho run sắp chạy (D6). null = giữ model theo quy tắc thường (D2/D3). */
export function decideEscalation(o: EscalationInput): Escalation | null {
  if (!o.autoEscalate) return null
  const t = trigger(o)
  const prev = o.prevRun
  if (!t || !prev || prev.modelSource === 'manual') return null
  const from = asAlias(prev.requestedModel)
  let to = nextTier(from)
  if (!from || !to) return null
  if (tierIndex(to) > tierIndex(o.maxTier)) to = o.maxTier
  if (tierIndex(to) <= tierIndex(from)) return null
  return {
    model: to,
    source: 'escalated',
    reason: `Nâng từ ${LABEL[from]}: ${whyText(t)}`,
    // Retry luôn là phiên mới; resume thì chỉ mở phiên mới khi ngữ cảnh lớn (đổi model mất cache).
    freshSession: t.why === 'request_changes' && (prev.contextTokens ?? 0) >= FRESH_SESSION_TOKENS,
  }
}

/** Gợi ý khi model chọn tay thất bại (D6: không tự nâng). null nếu không thuộc diện. */
export function manualEscalationHint(o: Omit<EscalationInput, 'maxTier'>): string | null {
  if (!o.autoEscalate || o.prevRun?.modelSource !== 'manual') return null
  const t = trigger(o)
  const from = asAlias(o.prevRun.requestedModel)
  const to = nextTier(from)
  if (!t || !from || !to) return null
  const what = t.why === 'failed' ? 'đã thất bại' : `bị yêu cầu sửa lần ${t.count}`
  return `Model chọn tay (${LABEL[from]}) ${what}, cân nhắc chọn ${LABEL[to]}`
}

export interface BaseChoice {
  requestedModel: string | undefined
  modelSource: ModelSource
  modelReason: string
}

/**
 * Áp Lớp 3 lên lựa chọn thường (chooseRunModel). Trả về model cuối cùng, có mở phiên mới không,
 * và các dòng log hệ thống cần ghi (lý do nâng hoặc gợi ý cho model chọn tay).
 * Cấu hình hiện tại là model chọn tay ở task (người dùng vừa chọn trước khi Retry) thì cũng không nâng (D6).
 */
export function applyEscalation<T extends BaseChoice>(
  base: T,
  o: EscalationInput,
): { choice: T | BaseChoice; escalated: boolean; freshSession: boolean; notes: string[] } {
  const hint = manualEscalationHint(o)
  if (hint) return { choice: base, escalated: false, freshSession: false, notes: [hint] }
  const esc = base.modelSource === 'manual' ? null : decideEscalation(o)
  if (!esc) return { choice: base, escalated: false, freshSession: false, notes: [] }
  return {
    choice: { requestedModel: esc.model, modelSource: esc.source, modelReason: esc.reason },
    escalated: true,
    freshSession: esc.freshSession,
    notes: [esc.freshSession ? `${esc.reason}. Ngữ cảnh lớn nên mở phiên mới kèm tóm tắt thay vì chạy tiếp phiên cũ.` : esc.reason],
  }
}

/** Prompt cho phiên mới khi nâng model lúc resume với ngữ cảnh lớn (D6). */
export function escalationPrompt(o: {
  taskPrompt: string
  lastSummary?: string
  /** Model của run trước (alias hoặc ID thực tế), để ghi vào prompt. */
  prevModel?: string
  feedback?: string
  branch?: string
  mainBranch: string
}): string {
  const model = o.prevModel ? (LABEL[o.prevModel as ModelAlias] ?? o.prevModel) : 'trước'
  const parts = [
    `Yêu cầu gốc:\n${o.taskPrompt}`,
    `Lần chạy trước (model ${model}) đã làm:\n${o.lastSummary?.trim() || '(không có tóm tắt)'}`,
  ]
  if (o.feedback?.trim()) parts.push(`Yêu cầu sửa sau khi review:\n${o.feedback.trim()}`)
  parts.push(
    `Code của lần chạy trước đã nằm trong worktree này${o.branch ? ` (nhánh ${o.branch})` : ''}. ` +
      `Xem thay đổi đã có bằng \`git log ${o.mainBranch}..HEAD\` và \`git diff ${o.mainBranch}..HEAD\` trước khi sửa, giữ những phần đúng.`,
  )
  return parts.join('\n\n')
}

/**
 * Nguồn mức budget của project. Mặc định 'none' để file này vẫn thuần (không đụng DB);
 * budgetService.ts đăng ký nguồn thật (chi tiêu tháng từ DB) khi được nạp.
 */
let budgetLevelOf: (projectId: string) => BudgetLevel = () => 'none'

export function setBudgetLevelSource(fn: (projectId: string) => BudgetLevel) {
  budgetLevelOf = fn
}

/** B4 (P6): project đã ≥ 80% budget (warn/over) thì không nâng quá sonnet, ngược lại trần là opus. */
export function maxTierForProject(projectId: string): ModelAlias {
  return maxTierForLevel(budgetLevelOf(projectId))
}
