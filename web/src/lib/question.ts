// FR-40: Claude hỏi lại người dùng giữa lúc chạy bằng tool gốc AskUserQuestion (spike S9, docs/P0-SPIKE.md).
// CLI chuyển lời gọi tool qua permission prompt tool; trả `allow` + `updatedInput.answers` thì Claude
// nhận đáp án và chạy tiếp trong cùng tiến trình. Hàm thuần, dùng chung cho server và web.

export const QUESTION_TOOL = 'AskUserQuestion'

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect?: boolean
}

/** Đáp án theo đúng định dạng CLI chờ: khoá là nguyên văn câu hỏi, giá trị là nhãn đã chọn hoặc câu tự nhập. */
export type Answers = Record<string, string>

/** Độ dài tối đa của một câu trả lời tự nhập. */
export const MAX_ANSWER = 2000

export const isQuestionTool = (tool: string) => tool === QUESTION_TOOL

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** Đọc danh sách câu hỏi từ input của AskUserQuestion; bỏ phần tử sai định dạng. */
export function parseQuestions(input: unknown): Question[] {
  const raw = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(raw)) return []
  return raw.flatMap((q): Question[] => {
    const question = str((q as Question)?.question)?.trim()
    if (!question) return []
    const options = Array.isArray((q as Question).options)
      ? (q as Question).options.flatMap((o): QuestionOption[] => {
          const label = str(o?.label)?.trim()
          if (!label) return []
          const description = str(o?.description)?.trim()
          return [description ? { label, description } : { label }]
        })
      : []
    const header = str((q as Question).header)?.trim()
    return [{ question, ...(header ? { header } : {}), options, ...((q as Question).multiSelect === true ? { multiSelect: true } : {}) }]
  })
}

/** Mô tả ngắn một dòng mỗi câu hỏi (log, Telegram, thẻ rút gọn). */
export function describeQuestions(questions: Question[]): string {
  return questions.map((q) => q.question).join('\n')
}

/** Ghép lựa chọn của câu nhiều đáp án theo cách Claude Code tự làm: các nhãn nối bằng ", ". */
export function joinSelected(labels: string[]): string {
  return labels.map((l) => l.trim()).filter(Boolean).join(', ')
}

/**
 * Kiểm tra đáp án gửi lên: mỗi câu hỏi phải có câu trả lời không rỗng (≤ MAX_ANSWER ký tự).
 * Trả đáp án đã chuẩn hoá (chỉ giữ khoá là câu hỏi thật) hoặc thông báo lỗi tiếng Việt.
 */
export function validateAnswers(questions: Question[], raw: unknown): { answers: Answers } | { error: string } {
  if (!questions.length) return { error: 'Yêu cầu này không có câu hỏi nào' }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Câu trả lời không hợp lệ' }
  const answers: Answers = {}
  for (const q of questions) {
    const a = str((raw as Record<string, unknown>)[q.question])?.trim()
    if (!a) return { error: `Chưa trả lời câu: ${q.question}` }
    if (a.length > MAX_ANSWER) return { error: `Câu trả lời tối đa ${MAX_ANSWER} ký tự` }
    answers[q.question] = a
  }
  return { answers }
}

/** Message gửi Claude khi người dùng bỏ qua câu hỏi hoặc hết thời gian chờ: tự quyết và nói rõ giả định. */
export function noAnswerMessage(why: 'skipped' | 'timeout' | 'cancelled', note?: string | null): string {
  const head =
    why === 'timeout'
      ? 'Người dùng chưa trả lời câu hỏi trên Task Board trong thời gian chờ.'
      : why === 'skipped'
        ? 'Người dùng đã bỏ qua câu hỏi trên Task Board.'
        : 'Câu hỏi đã bị huỷ trên Task Board.'
  const extra = note ? ` Ghi chú của người dùng: ${note}.` : ''
  return `${head}${extra} Hãy tự chọn phương án hợp lý và an toàn nhất, không hỏi lại cùng câu này, và ghi rõ giả định đã dùng trong kết quả cuối.`
}
