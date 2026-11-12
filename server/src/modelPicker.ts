// P5-04 (PLAN P5, D4): Lớp 1 — chấm điểm độ khó của task bằng quy tắc, chọn haiku/sonnet/opus kèm lý do.
// Hàm thuần: không đụng DB, không gọi model (D7).
import type { ModelAlias } from './model.ts'
import type { PermissionMode } from './types.ts'

export interface PickInput {
  title: string
  prompt: string
  tags: string[]
  permissionMode: PermissionMode
}

export interface Suggestion {
  model: ModelAlias
  score: number
  reasons: string[]
}

export interface PickRules {
  planMode: number
  easyTags: { words: string[]; score: number }
  hardTags: { words: string[]; score: number }
  normalTags: { words: string[]; score: number }
  easyKeywords: { words: string[]; score: number }
  hardKeywords: { words: string[]; score: number }
  /** Độ dài title+prompt < maxChars → score. */
  short: { maxChars: number; score: number }
  /** Độ dài title+prompt > minChars → score. */
  long: { minChars: number; score: number }
  /** Số đường dẫn file khác nhau trong prompt ≥ minFiles → score. */
  manyFiles: { minFiles: number; score: number }
  /** D4: score ≤ haikuMax → haiku; score ≥ opusMin → opus; còn lại sonnet. */
  thresholds: { haikuMax: number; opusMin: number }
}

export const DEFAULT_RULES: PickRules = {
  planMode: 3,
  easyTags: { words: ['docs', 'typo', 'format', 'rename', 'comment', 'readme'], score: -3 },
  hardTags: { words: ['refactor', 'architecture', 'security', 'migration', 'perf', 'performance', 'debug-hard'], score: 3 },
  normalTags: { words: ['bugfix', 'feature', 'bug'], score: 1 },
  easyKeywords: {
    words: ['sửa chính tả', 'chính tả', 'typo', 'đổi tên', 'rename', 'thêm comment', 'cập nhật readme', 'update readme', 'format code', 'định dạng'],
    score: -2,
  },
  hardKeywords: {
    words: [
      'thiết kế',
      'kiến trúc',
      'architecture',
      'refactor',
      'tối ưu',
      'optimize',
      'race condition',
      'bảo mật',
      'security',
      'migration',
      'không rõ nguyên nhân',
      'ngẫu nhiên',
      'intermittent',
      'deadlock',
      'memory leak',
      'rò rỉ bộ nhớ',
    ],
    score: 2,
  },
  short: { maxChars: 150, score: -1 },
  long: { minChars: 1500, score: 1 },
  manyFiles: { minFiles: 5, score: 1 },
  thresholds: { haikuMax: -2, opusMin: 3 },
}

const FILE_RE = /[\w./\\-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|cs|css|scss|html|json|md|sql|yml|yaml)\b/gi

/** Lowercase + bỏ dấu tiếng Việt (NFD, xoá dấu kết hợp, đ→d) để "sua chinh ta" khớp "sửa chính tả". */
export function foldVi(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
}

const pts = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0')

const LABEL: Record<ModelAlias, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }
export const modelAliasLabel = (m: ModelAlias) => LABEL[m]

/** Số đường dẫn file khác nhau (không phân biệt hoa thường, `\` ≡ `/`). */
export function countFiles(text: string): number {
  const found = new Set<string>()
  for (const m of text.matchAll(FILE_RE)) found.add(m[0].toLowerCase().replace(/\\/g, '/'))
  return found.size
}

export function suggestModel(input: PickInput, rules: PickRules = DEFAULT_RULES): Suggestion {
  let score = 0
  const reasons: string[] = []
  const add = (n: number, why: string) => {
    score += n
    reasons.push(`${why} (${pts(n)})`)
  }

  if (input.permissionMode === 'plan') add(rules.planMode, 'chế độ Plan')

  // Tag: mỗi nhóm cộng tối đa 1 lần, lấy tag đầu tiên khớp để ghi lý do.
  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean)
  const tagGroup = (g: { words: string[]; score: number }) => {
    const hit = tags.find((t) => g.words.includes(t.toLowerCase()))
    if (hit) add(g.score, `tag "${hit}"`)
  }
  tagGroup(rules.easyTags)
  tagGroup(rules.hardTags)
  tagGroup(rules.normalTags)

  // Từ khoá: so khớp trên title+prompt đã bỏ dấu; mỗi nhóm cộng tối đa 1 lần.
  const text = `${input.title ?? ''}\n${input.prompt ?? ''}`
  const folded = foldVi(text)
  const kwGroup = (g: { words: string[]; score: number }) => {
    const hit = g.words.find((w) => folded.includes(foldVi(w)))
    if (hit) add(g.score, `prompt có "${hit}"`)
  }
  kwGroup(rules.easyKeywords)
  kwGroup(rules.hardKeywords)

  const len = (input.title ?? '').length + (input.prompt ?? '').length
  if (len < rules.short.maxChars) add(rules.short.score, 'prompt ngắn')
  else if (len > rules.long.minChars) add(rules.long.score, 'prompt dài')

  const files = countFiles(input.prompt ?? '')
  if (files >= rules.manyFiles.minFiles) add(rules.manyFiles.score, `nhắc tới ${files} file`)

  const model: ModelAlias = score <= rules.thresholds.haikuMax ? 'haiku' : score >= rules.thresholds.opusMin ? 'opus' : 'sonnet'
  if (!reasons.length) reasons.push(`Không có tín hiệu đặc biệt → mặc định ${LABEL[model]}`)
  return { model, score, reasons }
}
