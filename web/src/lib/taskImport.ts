// Import task hàng loạt từ CSV / .xlsx / dữ liệu dán từ bảng tính (SPEC FR-01a, docs/SPEC-IMPORT.md).
// Hàm thuần, dùng chung web và server (server/src/taskImport.ts):
// - web: đọc file → bảng chuỗi → ImportRow[] (nhận tên cột), không kiểm tra giá trị;
// - server: chuẩn hoá giá trị (ưu tiên, mức quyền tiếng Việt) và kiểm tra.
import type { AgentId, PermissionMode, Priority } from '../types.ts'

/** I6: giới hạn mỗi lần import. */
export const IMPORT_MAX_ROWS = 200
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024
/** Giới hạn ký tự của một ô Excel. */
export const IMPORT_MAX_CELL = 32767

/** Một dòng đã map tên cột. Mọi giá trị là chuỗi thô từ file; server kiểm tra. */
export interface ImportRow {
  /** Số dòng trong file (dòng tiêu đề là dòng 1). */
  line: number
  title: string
  prompt: string
  key?: string
  dependsOn?: string[]
  project?: string
  priority?: string
  tags?: string[]
  model?: string
  agent?: string
  permissionMode?: string
  maxCostUsd?: string
}

export interface ImportRequest {
  /** Project dùng khi dòng không ghi cột Project. */
  projectId: string
  rows: ImportRow[]
  onDuplicate: 'skip' | 'create'
  /** true: tạo ở Hàng đợi; false: Backlog (I1). */
  run: boolean
  /** Đã xác nhận cảnh báo mức quyền Auto (I5). */
  confirmAuto?: boolean
  /** true: chỉ kiểm tra, không tạo gì. */
  dryRun: boolean
}

export type ImportRowStatus = 'ok' | 'duplicate' | 'error'

export interface ImportRowResult {
  line: number
  status: ImportRowStatus
  errors?: string[]
  /** Trùng tiêu đề với task đã có (id) hoặc dòng khác trong file (line). */
  duplicateOf?: { taskId?: number; line?: number }
  /** Project sẽ tạo (đã giải mã từ cột Project). */
  projectId?: string
  /** Mức quyền sẽ dùng (để đếm Auto). */
  permissionMode?: PermissionMode
  /** Id task đã tạo (chỉ khi dryRun = false). */
  taskId?: number
}

export interface ImportResult {
  rows: ImportRowResult[]
  created: number
  skipped: number
  /** Số task sẽ tạo / đã tạo ở mức quyền Auto (I5). */
  autoCount: number
}

export type ImportField = Exclude<keyof ImportRow, 'line'>

// ---------------------------------------------------------------- tên cột

/** Bỏ dấu tiếng Việt, chữ thường, bỏ mọi ký tự không phải chữ/số: "Tiêu đề" → "tieude", "depends_on" → "dependson". */
export function foldKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

const HEADER_ALIASES: Record<ImportField, string[]> = {
  title: ['title', 'tiêu đề', 'tên task', 'tên', 'task', 'summary', 'name'],
  prompt: ['prompt', 'mô tả', 'description', 'nội dung', 'yêu cầu', 'details'],
  key: ['key', 'code', 'mã', 'mã task', 'id'],
  dependsOn: ['depends_on', 'depends on', 'dependencies', 'chờ task', 'phụ thuộc', 'chờ', 'blocked by'],
  project: ['project', 'dự án'],
  priority: ['priority', 'ưu tiên', 'độ ưu tiên'],
  tags: ['tags', 'tag', 'nhãn', 'labels'],
  model: ['model'],
  agent: ['agent', 'ai agent', 'tác tử'],
  permissionMode: ['permission_mode', 'permission mode', 'mức quyền', 'quyền', 'mode'],
  maxCostUsd: ['max_cost_usd', 'max cost usd', 'max cost', 'giới hạn chi phí', 'chi phí tối đa'],
}

const HEADER_LOOKUP = new Map<string, ImportField>(
  (Object.entries(HEADER_ALIASES) as [ImportField, string[]][]).flatMap(([f, names]) => names.map((n) => [foldKey(n), f] as const)),
)

export const REQUIRED_FIELDS: ImportField[] = ['title', 'prompt']

/** Nhận diện tên cột. Trả field hoặc undefined nếu không nhận ra. */
export function headerField(name: string): ImportField | undefined {
  return HEADER_LOOKUP.get(foldKey(name))
}

/** Tách danh sách trong một ô: cách nhau bởi `,` `;` hoặc xuống dòng. */
export function splitList(s: string): string[] {
  return s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

export interface MappedTable {
  rows: ImportRow[]
  /** Cột tìm thấy: tên trong file → field. */
  columns: { name: string; field?: ImportField }[]
  /** Tên cột không nhận ra (bị bỏ qua). */
  unknown: string[]
  /** Field bắt buộc còn thiếu. */
  missing: ImportField[]
  /** Số dòng dữ liệu vượt quá IMPORT_MAX_ROWS (đã cắt). */
  truncated: number
}

/**
 * Bảng chuỗi (dòng đầu là tiêu đề) → ImportRow[]. Bỏ dòng trống hoàn toàn nhưng giữ đúng số dòng.
 * Cột trùng field thì lấy cột đầu tiên.
 */
export function mapTable(table: string[][]): MappedTable {
  const header = table[0] ?? []
  const used = new Set<ImportField>()
  const columns = header.map((raw) => {
    const name = raw.trim()
    const f = name ? headerField(name) : undefined
    if (f && !used.has(f)) {
      used.add(f)
      return { name, field: f }
    }
    return { name }
  })
  const unknown = columns.filter((c) => !c.field && c.name).map((c) => c.name)
  const missing = REQUIRED_FIELDS.filter((f) => !used.has(f))
  const rows: ImportRow[] = []
  let truncated = 0
  for (let i = 1; i < table.length; i++) {
    const cells = table[i]
    if (cells.every((c) => !c.trim())) continue
    if (rows.length >= IMPORT_MAX_ROWS) {
      truncated++
      continue
    }
    const row: ImportRow = { line: i + 1, title: '', prompt: '' }
    columns.forEach((c, j) => {
      if (!c.field) return
      const v = cells[j] ?? ''
      if (c.field === 'dependsOn' || c.field === 'tags') {
        const list = splitList(v)
        if (list.length) row[c.field] = list
      } else if (c.field === 'title' || c.field === 'prompt') {
        row[c.field] = c.field === 'title' ? v.trim() : v.replace(/\r\n?/g, '\n').trim()
      } else if (v.trim()) {
        row[c.field] = v.trim()
      }
    })
    rows.push(row)
  }
  return { rows, columns, unknown, missing, truncated }
}

// ---------------------------------------------------------------- CSV / TSV

/** Nhận dấu phân cách theo dòng tiêu đề (ngoài ngoặc kép): Tab, `;` hoặc `,`. */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 }
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '\n' || ch === '\r')) break
    else if (!quoted && ch in counts) counts[ch as keyof typeof counts]++
  }
  if (counts['\t'] > 0 && counts['\t'] >= counts[','] && counts['\t'] >= counts[';']) return '\t'
  return counts[';'] > counts[','] ? ';' : ','
}

/** Parser CSV theo RFC 4180: ô trong ngoặc kép có thể chứa dấu phân cách, xuống dòng và `""`. Nhận CRLF/LF/CR. */
export function parseDelimited(text: string, delimiter: string = detectDelimiter(text)): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let i = 0
  const endCell = () => {
    row.push(cell)
    cell = ''
  }
  const endRow = () => {
    endCell()
    rows.push(row)
    row = []
  }
  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
      } else cell += ch
      i++
      continue
    }
    if (ch === '"' && cell === '') quoted = true
    else if (ch === delimiter) endCell()
    else if (ch === '\r') {
      endRow()
      if (text[i + 1] === '\n') i++
    } else if (ch === '\n') endRow()
    else cell += ch
    i++
  }
  if (cell !== '' || row.length) endRow()
  return rows
}

export const CSV_ENCODINGS = ['utf-8', 'windows-1258', 'windows-1252'] as const
export type CsvEncoding = (typeof CSV_ENCODINGS)[number]

/**
 * Giải mã file CSV (R1). Không chỉ định: thử UTF-8 nghiêm ngặt, lỗi thì dùng Windows-1258
 * (mã hoá mặc định của Excel tiếng Việt khi lưu "CSV") và báo `fallback`.
 */
export function decodeText(bytes: Uint8Array, encoding?: CsvEncoding): { text: string; encoding: CsvEncoding; fallback: boolean } {
  // Windows-1258 ghi dấu thanh bằng ký tự tổ hợp riêng ("ề" = "ê" + U+0300): chuẩn hoá NFC để giống chữ gõ tay.
  const decode = (enc: CsvEncoding, fatal = false) => new TextDecoder(enc, { fatal }).decode(bytes).normalize('NFC')
  if (encoding) return { text: decode(encoding), encoding, fallback: false }
  try {
    return { text: decode('utf-8', true), encoding: 'utf-8', fallback: false }
  } catch {
    return { text: decode('windows-1258'), encoding: 'windows-1258', fallback: true }
  }
}

/** Ô của sheet Excel → chuỗi. Số giữ dạng ngắn gọn, ngày ra yyyy-mm-dd. */
export function cellToString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return String(v)
}

// ---------------------------------------------------------------- giá trị

const PRIORITY_ALIASES: Record<string, Priority> = {
  urgent: 'urgent',
  khan: 'urgent',
  khancap: 'urgent',
  gap: 'urgent',
  high: 'high',
  cao: 'high',
  normal: 'normal',
  medium: 'normal',
  thuong: 'normal',
  binhthuong: 'normal',
  trungbinh: 'normal',
  low: 'low',
  thap: 'low',
}

/** Ưu tiên tiếng Anh hoặc tiếng Việt → Priority. Rỗng: undefined; không nhận ra: trả nguyên chuỗi để báo lỗi. */
export function normalizePriority(v: string | undefined): string | undefined {
  if (!v?.trim()) return undefined
  return PRIORITY_ALIASES[foldKey(v)] ?? v.trim()
}

const MODE_ALIASES: Record<string, PermissionMode> = {
  manual: 'manual',
  default: 'manual',
  thucong: 'manual',
  acceptedits: 'acceptEdits',
  editautomatically: 'acceptEdits',
  tusua: 'acceptEdits',
  plan: 'plan',
  kehoach: 'plan',
  auto: 'auto',
  tudong: 'auto',
}

/** Mức quyền (tên kỹ thuật hoặc tên hiển thị) → PermissionMode. Không nhận ra: trả nguyên chuỗi để báo lỗi. */
export function normalizePermissionMode(v: string | undefined): string | undefined {
  if (!v?.trim()) return undefined
  return MODE_ALIASES[foldKey(v)] ?? v.trim()
}

const AGENT_ALIASES: Record<string, AgentId> = {
  claude: 'claude',
  claudecode: 'claude',
  codex: 'codex',
  openaicodex: 'codex',
  antigravity: 'antigravity',
  googleantigravity: 'antigravity',
  agy: 'antigravity',
  cursor: 'cursor',
  cursoragent: 'cursor',
}

/** Agent (id hoặc tên hiển thị, VD "Claude Code") → AgentId. Không nhận ra: trả nguyên chuỗi để báo lỗi. */
export function normalizeAgent(v: string | undefined): string | undefined {
  if (!v?.trim()) return undefined
  return AGENT_ALIASES[foldKey(v)] ?? v.trim()
}

/** So khớp tiêu đề để chống trùng (I3): bỏ khoảng trắng thừa, không phân biệt hoa thường. */
export const titleKey = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

// ---------------------------------------------------------------- file mẫu (FR-01b)

/** Tên file mẫu (không có đuôi). Mặc định tải bản .xlsx (web/src/lib/xlsxTemplate.ts), CSV là tuỳ chọn. */
export const TEMPLATE_BASENAME = 'task-import-mau'

/** Dữ liệu mẫu dùng chung cho file .xlsx và .csv: dòng tiêu đề cột + 2 task, task 2 chờ task 1. */
export const TEMPLATE_ROWS: string[][] = [
  ['key', 'title', 'prompt', 'depends_on', 'priority', 'tags', 'model', 'agent', 'permission_mode', 'max_cost_usd'],
  ['A1', 'Thêm API xuất báo cáo', 'Thêm endpoint GET /api/report trả về tổng số task theo trạng thái.\nViết unit test cho endpoint.', '', 'high', 'backend, api', '', '', '', ''],
  ['A2', 'Hiển thị báo cáo trên trang Thống kê', 'Gọi /api/report và hiển thị bảng tổng hợp trên trang Thống kê.', 'A1', 'normal', 'web', 'sonnet', '', '', ''],
]

/** Sheet "Hướng dẫn" của file mẫu .xlsx (import chỉ đọc sheet đầu nên sheet này không ảnh hưởng). */
export const TEMPLATE_GUIDE: string[][] = [
  ['Cột', 'Bắt buộc', 'Giá trị'],
  ['title', 'Có', 'Tiêu đề task. Tên cột cũng nhận "Tiêu đề"'],
  ['prompt', 'Có', 'Yêu cầu gửi cho Claude, ít nhất 10 ký tự, được nhiều dòng (Alt+Enter). Tên cột cũng nhận "Mô tả"'],
  ['key', '', 'Mã riêng trong file (vd A1) để dòng khác chờ. Không lưu vào task'],
  ['depends_on', '', 'Mã của dòng khác, #id hoặc mã task đã có (vd P2-01), cách nhau bởi dấu phẩy'],
  ['project', '', 'Tên hoặc id project. Trống: dùng project chọn trên hộp thoại import'],
  ['priority', '', 'urgent / high / normal / low (hoặc khẩn / cao / thường / thấp). Trống: normal'],
  ['tags', '', 'Cách nhau bởi dấu phẩy hoặc ;'],
  ['model', '', 'auto / haiku / sonnet / opus hoặc ID claude-…. Chỉ dùng cho Claude. Trống: kế thừa project'],
  ['agent', '', 'claude / codex / antigravity. Trống: agent mặc định của project. Agent phải hỗ trợ mức quyền của dòng'],
  ['permission_mode', '', 'manual / acceptEdits / plan / auto. Trống: mặc định của project. Auto phải xác nhận khi import'],
  ['max_cost_usd', '', 'Giới hạn chi phí mỗi lần chạy (USD), vd 1,5'],
  ['', '', ''],
  ['Lưu ý', '', 'Chỉ đọc sheet đầu tiên. Tối đa 200 dòng mỗi lần. Dòng trùng tiêu đề với task đã có mặc định bị bỏ qua'],
]

const csvCell = (s: string) => (/[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

/** File mẫu CSV, có BOM để Excel mở đúng tiếng Việt. */
export function templateCsv(): string {
  return '﻿' + TEMPLATE_ROWS.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
