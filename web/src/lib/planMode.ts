// Duyệt kế hoạch trước khi làm (SPEC-PLAN-HANDOFF Phần A, FR-100..105). Hàm thuần, dùng chung web và server.
//   none  Làm luôn
//   first Lập kế hoạch trước: lượt Kế hoạch (mode plan) → người dùng duyệt ở Review → lượt Thực hiện (mức quyền project)
//   only  Chỉ lập kế hoạch: lượt Kế hoạch → Review → "Chấp nhận kế hoạch" là Done
import type { PermissionMode, PlanMode, PlanPhase, RunKind } from '../types.ts'

export const PLAN_MODES: { value: PlanMode; label: string; description: string }[] = [
  { value: 'none', label: 'Làm luôn', description: 'Agent làm ngay theo yêu cầu.' },
  {
    value: 'first',
    label: 'Kế hoạch trước',
    description: 'Agent chỉ đọc code và viết kế hoạch. Bạn duyệt (hoặc sửa) kế hoạch rồi agent mới sửa code.',
  },
  { value: 'only', label: 'Chỉ kế hoạch', description: 'Agent chỉ phân tích và viết kế hoạch, không sửa code.' },
]

export const planModeOf = (m: PlanMode | undefined) => PLAN_MODES.find((o) => o.value === (m ?? 'none')) ?? PLAN_MODES[0]

const ALIASES: Record<string, PlanMode> = {
  none: 'none',
  lamluon: 'none',
  khong: 'none',
  first: 'first',
  plan_first: 'first',
  planfirst: 'first',
  kehoachtruoc: 'first',
  lapkehoachtruoc: 'first',
  only: 'only',
  plan_only: 'only',
  planonly: 'only',
  plan: 'only',
  chikehoach: 'only',
  chilapkehoach: 'only',
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[\s-]+/g, '')

/** Giá trị cột `plan_mode` của file import / API → PlanMode. Trống: undefined. Không nhận ra: trả nguyên chuỗi để báo lỗi. */
export function normalizePlanMode(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined
  return ALIASES[fold(v)] ?? ALIASES[v.trim().toLowerCase()] ?? v.trim()
}

export const isPlanMode = (v: unknown): v is PlanMode => v === 'none' || v === 'first' || v === 'only'

/** Giai đoạn của lượt chạy đầu tiên theo planMode. */
export const initialPhase = (m: PlanMode | undefined): PlanPhase | undefined => (m === 'first' || m === 'only' ? 'plan' : undefined)

/** Mức quyền thực tế của một lượt chạy: lượt Kế hoạch luôn chạy mode plan, bất kể mức quyền của project (FR-101). */
export const runPermissionMode = (mode: PermissionMode, phase: PlanPhase | undefined): PermissionMode => (phase === 'plan' ? 'plan' : mode)

/**
 * Giai đoạn của lượt chạy sắp bắt đầu.
 * - resume (Góp ý / Yêu cầu sửa), continue (Tiếp tục): giữ giai đoạn hiện tại.
 * - initial / retry: task "Kế hoạch trước" đã có kế hoạch được duyệt thì vào thẳng lượt Thực hiện (phiên mới kèm
 *   kế hoạch, FR-104); còn lại lập kế hoạch (lại) từ đầu.
 */
export function phaseForRun(t: { planMode?: PlanMode; planPhase?: PlanPhase; approvedPlan?: string }, kind: RunKind): PlanPhase | undefined {
  if (!t.planMode || t.planMode === 'none') return undefined
  if (kind === 'resume' || kind === 'continue') return t.planPhase ?? 'plan'
  if (t.planMode === 'first' && t.approvedPlan) return 'execute'
  return 'plan'
}

/** Prompt lượt chạy initial / retry của task có lập kế hoạch (undefined = dùng prompt gốc như task làm luôn). */
export function phasePrompt(phase: PlanPhase | undefined, taskPrompt: string, approvedPlan?: string) {
  if (phase === 'plan') return planPrompt(taskPrompt)
  if (phase === 'execute' && approvedPlan) return executePrompt({ approvedPlan, resume: false, taskPrompt })
  return undefined
}

/** Task đang chờ duyệt kế hoạch (Review của lượt Kế hoạch). */
export const awaitingPlanApproval = (t: { status: string; planPhase?: PlanPhase }) => t.status === 'review' && t.planPhase === 'plan'

/**
 * Chỉ dẫn cho lượt Kế hoạch (FR-101). Gắn vào prompt (không dùng system prompt) để mọi agent đều nhận được.
 * Spike S1: ở chế độ headless Claude không có ExitPlanMode, nên câu trả lời cuối cùng chính là kế hoạch.
 */
export const PLAN_INSTRUCTION = [
  '[Task Board: giai đoạn LẬP KẾ HOẠCH]',
  'Chỉ đọc code và phân tích, KHÔNG sửa file, KHÔNG chạy lệnh làm thay đổi gì. Không cần gọi ExitPlanMode hay xin thoát plan mode.',
  'Câu trả lời cuối cùng của bạn CHÍNH LÀ bản kế hoạch để người dùng duyệt, viết bằng Markdown theo đúng khung sau, không thêm lời dẫn:',
  '## Hiểu yêu cầu',
  '## Các file sẽ sửa hoặc tạo',
  '## Các bước',
  '## Rủi ro và giả định',
  '## Câu hỏi còn mở',
  'Nếu yêu cầu chưa rõ tới mức không lập được kế hoạch, hãy hỏi lại bằng AskUserQuestion (nếu có) hoặc ghi vào mục "Câu hỏi còn mở".',
].join('\n')

/** Prompt lượt Kế hoạch đầu tiên (hoặc phiên mới). */
export const planPrompt = (taskPrompt: string) => `${taskPrompt}\n\n${PLAN_INSTRUCTION}`

/** Prompt "Góp ý lại" kế hoạch: resume đúng phiên chỉ cần góp ý + nhắc lại chỉ dẫn; phiên mới gửi kèm prompt gốc. */
export function replanPrompt(o: { feedback: string; resume: boolean; taskPrompt: string; lastPlan?: string }) {
  const ask = `Người dùng góp ý cho kế hoạch:\n${o.feedback}\n\nHãy lập lại kế hoạch theo góp ý.`
  if (o.resume) return `${ask}\n\n${PLAN_INSTRUCTION}`
  const prev = o.lastPlan ? `\n\nKế hoạch trước đó:\n${o.lastPlan}` : ''
  return `${o.taskPrompt}${prev}\n\n${ask}\n\n${PLAN_INSTRUCTION}`
}

/**
 * Prompt lượt Thực hiện (FR-103, FR-104). Resume đúng phiên: agent đã có ngữ cảnh, chỉ gửi kế hoạch đã duyệt.
 * Phiên mới (đổi agent, mất phiên, nâng model): gửi kèm prompt gốc.
 */
export function executePrompt(o: { approvedPlan: string; resume: boolean; taskPrompt: string }) {
  const body =
    'Kế hoạch đã được người dùng duyệt (bản cuối bên dưới, có thể đã được sửa). Giai đoạn lập kế hoạch đã xong: ' +
    'bây giờ hãy THỰC HIỆN đúng kế hoạch này. Nếu cần làm khác kế hoạch, ghi rõ lý do trong kết quả.\n\n' +
    `--- KẾ HOẠCH ĐÃ DUYỆT ---\n${o.approvedPlan.trim()}\n--- HẾT KẾ HOẠCH ---`
  return o.resume ? body : `${o.taskPrompt}\n\n${body}`
}

/** Độ dài tối đa của kế hoạch người dùng sửa trước khi duyệt. */
export const MAX_PLAN_LENGTH = 50_000

/**
 * "Feedback" ghi trên lượt Thực hiện đầu tiên (lượt resume sau khi duyệt). Prompt thật gửi cho agent do runner dựng
 * từ kế hoạch đã duyệt (executePrompt), chuỗi này chỉ để lịch sử run dễ đọc.
 */
export const EXECUTE_FEEDBACK = 'Thực hiện theo kế hoạch đã duyệt'
