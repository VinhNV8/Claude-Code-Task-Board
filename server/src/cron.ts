// Biểu thức cron 5 trường (PLAN 4.6): phút giờ ngày tháng thứ, tính theo giờ địa phương của máy chạy server.
// Hỗ trợ: *, danh sách (1,15), khoảng (1-5), bước (*/10, 1-30/5, 5/15), tên tháng/thứ (JAN, MON),
// thứ 7 = Chủ nhật, và các macro @hourly @daily @weekly @monthly @yearly.
// Ngày và thứ: nếu cả hai đều bị giới hạn (không bắt đầu bằng *) thì khớp khi MỘT trong hai khớp (như cron chuẩn).

export class CronError extends Error {}

export interface Cron {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  /** Trường ngày/thứ có bị giới hạn không (để áp dụng luật OR) */
  dayRestricted: boolean
  weekdayRestricted: boolean
}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

interface FieldSpec {
  label: string
  min: number
  max: number
  names?: string[]
  /** Giá trị đầu tiên của names (VD tháng bắt đầu từ 1) */
  nameBase?: number
}

const FIELDS: FieldSpec[] = [
  { label: 'phút', min: 0, max: 59 },
  { label: 'giờ', min: 0, max: 23 },
  { label: 'ngày', min: 1, max: 31 },
  { label: 'tháng', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  // 7 cũng là Chủ nhật, chuẩn hoá về 0 sau khi phân tích
  { label: 'thứ', min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
]

function parseValue(raw: string, f: FieldSpec): number {
  const up = raw.toUpperCase()
  const idx = f.names?.indexOf(up) ?? -1
  if (idx >= 0) return idx + (f.nameBase ?? 0)
  if (!/^\d+$/.test(raw)) throw new CronError(`Giá trị "${raw}" ở trường ${f.label} không hợp lệ`)
  const n = Number(raw)
  if (n < f.min || n > f.max) throw new CronError(`Trường ${f.label} phải nằm trong ${f.min}-${f.max} (đang là ${n})`)
  return n
}

function parseField(text: string, f: FieldSpec): Set<number> {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    if (!part) throw new CronError(`Trường ${f.label} có phần tử rỗng`)
    const [rangeText, stepText, extra] = part.split('/')
    if (extra !== undefined) throw new CronError(`Trường ${f.label} có bước không hợp lệ: "${part}"`)
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new CronError(`Bước "${stepText}" ở trường ${f.label} không hợp lệ`)
      step = Number(stepText)
    }
    let lo: number
    let hi: number
    if (rangeText === '*') {
      lo = f.min
      hi = f.max
    } else if (rangeText.includes('-')) {
      const [a, b, more] = rangeText.split('-')
      if (more !== undefined || !a || !b) throw new CronError(`Khoảng "${rangeText}" ở trường ${f.label} không hợp lệ`)
      lo = parseValue(a, f)
      hi = parseValue(b, f)
      if (lo > hi) throw new CronError(`Khoảng "${rangeText}" ở trường ${f.label} bị ngược`)
    } else {
      lo = parseValue(rangeText, f)
      // "5/15" nghĩa là từ 5 đến hết, bước 15
      hi = stepText !== undefined ? f.max : lo
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

/** Phân tích biểu thức cron. Ném CronError (tiếng Việt) nếu sai cú pháp. */
export function parseCron(expr: string): Cron {
  const trimmed = expr.trim()
  if (!trimmed) throw new CronError('Nhập biểu thức cron')
  const text = MACROS[trimmed.toLowerCase()] ?? trimmed
  if (text.startsWith('@')) throw new CronError(`Macro "${trimmed}" không được hỗ trợ`)
  const parts = text.split(/\s+/)
  if (parts.length !== 5) throw new CronError('Biểu thức cron cần đúng 5 trường: phút giờ ngày tháng thứ')
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => parseField(p, FIELDS[i]))
  if (weekdays.delete(7)) weekdays.add(0)
  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    dayRestricted: !parts[2].startsWith('*'),
    weekdayRestricted: !parts[4].startsWith('*'),
  }
}

function dayMatches(c: Cron, d: Date) {
  const dom = c.days.has(d.getDate())
  const dow = c.weekdays.has(d.getDay())
  if (c.dayRestricted && c.weekdayRestricted) return dom || dow
  if (c.dayRestricted) return dom
  if (c.weekdayRestricted) return dow
  return true
}

/** Giới hạn tìm kiếm: 5 năm (đủ cho 29/2 và các tổ hợp hiếm). */
const MAX_SEARCH_MS = 5 * 366 * 86_400_000

/**
 * Thời điểm khớp đầu tiên SAU `from` (epoch ms, theo giờ địa phương), hoặc null nếu không có trong 5 năm tới
 * (VD "0 0 31 2 *" không bao giờ xảy ra).
 */
export function nextRun(cron: Cron | string, from: number): number | null {
  const c = typeof cron === 'string' ? parseCron(cron) : cron
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const limit = from + MAX_SEARCH_MS
  while (d.getTime() <= limit) {
    if (!c.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!c.hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!c.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
      continue
    }
    return d.getTime()
  }
  return null
}

/** `count` lần chạy kế tiếp sau `from`, dùng để xem trước trên giao diện. */
export function nextRuns(cron: Cron | string, from: number, count: number): number[] {
  const c = typeof cron === 'string' ? parseCron(cron) : cron
  const out: number[] = []
  let t = from
  while (out.length < count) {
    const n = nextRun(c, t)
    if (n === null) break
    out.push(n)
    t = n
  }
  return out
}
