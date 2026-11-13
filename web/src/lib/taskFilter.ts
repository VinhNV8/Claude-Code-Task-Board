// Logic lọc/tìm kiếm task trên Kanban (FR-07) và chuẩn hoá tag.
// File thuần (không import gì) để server test được bằng node --test.

export const PRIORITY_VALUES = ['urgent', 'high', 'normal', 'low'] as const
export type FilterPriority = (typeof PRIORITY_VALUES)[number]

export interface BoardFilter {
  /** Từ khoá: tiêu đề, prompt, tag hoặc #id */
  q: string
  /** Rỗng = mọi project; nhiều giá trị = thuộc một trong các project */
  projectIds: string[]
  /** Task phải có đủ mọi tag đã chọn */
  tags: string[]
  /** Rỗng = mọi độ ưu tiên; nhiều giá trị = một trong các giá trị */
  priorities: FilterPriority[]
  /** Hiện cả Done/Failed cũ hơn 24 giờ */
  showAll: boolean
}

export interface FilterableTask {
  id: number
  projectId: string
  title: string
  prompt: string
  priority: string
  tags: string[]
}

export const EMPTY_FILTER: BoardFilter = { q: '', projectIds: [], tags: [], priorities: [], showAll: false }

export const MAX_TAGS = 20
export const MAX_TAG_LENGTH = 40

/** Bỏ dấu tiếng Việt + chữ thường để so khớp ("sua loi" khớp "Sửa lỗi"). */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
}

/** Trim, gộp khoảng trắng, bỏ rỗng, bỏ trùng (không phân biệt hoa thường, giữ cách viết đầu tiên). */
export function normalizeTags(list: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    const t = raw.replace(/\s+/g, ' ').trim()
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/** Tách chuỗi "bug, ui" thành danh sách tag. */
export function splitTags(input: string): string[] {
  return normalizeTags(input.split(','))
}

function splitParam(v: string | null): string[] {
  return v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []
}

/** Đọc bộ lọc từ URL query: ?q=&project=a&project=b&tags=a,b&priority=high,urgent&all=1 (project lặp lại vì id có thể chứa dấu phẩy) */
export function parseFilter(params: URLSearchParams): BoardFilter {
  const priorities = splitParam(params.get('priority')).filter((p): p is FilterPriority =>
    (PRIORITY_VALUES as readonly string[]).includes(p),
  )
  return {
    q: params.get('q') ?? '',
    projectIds: [...new Set(params.getAll('project').filter(Boolean))],
    tags: normalizeTags(splitParam(params.get('tags'))),
    priorities: PRIORITY_VALUES.filter((p) => priorities.includes(p)),
    showAll: params.get('all') === '1',
  }
}

/** Ghi bộ lọc ra URL query, bỏ các giá trị mặc định để URL gọn. */
export function filterToParams(f: BoardFilter): URLSearchParams {
  const p = new URLSearchParams()
  if (f.q) p.set('q', f.q)
  for (const id of f.projectIds) p.append('project', id)
  if (f.tags.length) p.set('tags', f.tags.join(','))
  if (f.priorities.length) p.set('priority', f.priorities.join(','))
  if (f.showAll) p.set('all', '1')
  return p
}

/** Có bộ lọc nào làm hẹp danh sách task không (không tính showAll). */
export function isFilterActive(f: BoardFilter): boolean {
  return !!f.q.trim() || f.projectIds.length > 0 || f.tags.length > 0 || f.priorities.length > 0
}

/** Số lựa chọn lọc đang bật (từng project, ưu tiên, tag, "hiện cả cũ") — hiện trên badge panel Bộ lọc. Từ khoá tìm kiếm không tính. */
export function activeFilterCount(f: BoardFilter): number {
  return f.projectIds.length + f.priorities.length + f.tags.length + (f.showAll ? 1 : 0)
}

/** Bật/tắt một giá trị trong danh sách (so tên không phân biệt hoa thường). Giữ thứ tự thêm vào. */
export function toggleValue<T extends string>(list: readonly T[], value: T): T[] {
  const key = value.toLowerCase()
  return list.some((x) => x.toLowerCase() === key) ? list.filter((x) => x.toLowerCase() !== key) : [...list, value]
}

/** Bật/tắt độ ưu tiên và luôn trả về theo thứ tự chuẩn (urgent → low) để URL ổn định. */
export function togglePriority(list: readonly FilterPriority[], value: FilterPriority): FilterPriority[] {
  const next = toggleValue(list, value)
  return PRIORITY_VALUES.filter((p) => next.includes(p))
}

/** Danh sách "chip" bộ lọc đang bật để hiển thị và gỡ từng cái. */
export type ActiveChip =
  | { kind: 'project'; value: string }
  | { kind: 'priority'; value: FilterPriority }
  | { kind: 'tag'; value: string }

export function activeChips(f: BoardFilter): ActiveChip[] {
  return [
    ...f.projectIds.map((value) => ({ kind: 'project', value }) as const),
    ...f.priorities.map((value) => ({ kind: 'priority', value }) as const),
    ...f.tags.map((value) => ({ kind: 'tag', value }) as const),
  ]
}

/** Trả về bộ lọc sau khi gỡ một chip. */
export function removeChip(f: BoardFilter, chip: ActiveChip): BoardFilter {
  switch (chip.kind) {
    case 'project':
      return { ...f, projectIds: f.projectIds.filter((id) => id !== chip.value) }
    case 'priority':
      return { ...f, priorities: f.priorities.filter((p) => p !== chip.value) }
    case 'tag':
      return { ...f, tags: f.tags.filter((t) => t.toLowerCase() !== chip.value.toLowerCase()) }
  }
}

/** Xoá mọi bộ lọc nhưng giữ từ khoá nếu keepQuery (dùng cho nút "Đặt lại" trong panel). */
export function clearFilters(f: BoardFilter, keepQuery = true): BoardFilter {
  return { ...EMPTY_FILTER, q: keepQuery ? f.q : '' }
}

/** Từ khoá có khớp task không. "#12" chỉ khớp id; "12" khớp id hoặc chữ trong tiêu đề/prompt. */
export function matchQuery(t: FilterableTask, q: string): boolean {
  const query = fold(q.trim())
  if (!query) return true
  const idMatch = /^#(\d+)$/.exec(query)
  if (idMatch) return t.id === Number(idMatch[1])
  if (/^\d+$/.test(query) && t.id === Number(query)) return true
  const terms = query.split(/\s+/)
  const hay = fold(`${t.title}\n${t.prompt}\n${t.tags.join(' ')}`)
  return terms.every((term) => hay.includes(term))
}

export function matchTask(t: FilterableTask, f: BoardFilter): boolean {
  if (f.projectIds.length && !f.projectIds.includes(t.projectId)) return false
  if (f.priorities.length && !(f.priorities as readonly string[]).includes(t.priority)) return false
  if (f.tags.length) {
    const own = new Set(t.tags.map((x) => x.toLowerCase()))
    if (!f.tags.every((x) => own.has(x.toLowerCase()))) return false
  }
  return matchQuery(t, f.q)
}

/** Bật/tắt một project (so khớp chính xác id). */
export function toggleProject(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}

/** Bỏ id project không còn tồn tại (project đã bị xoá) — giữ nguyên object nếu không có gì thay đổi. */
export function pruneProjects(f: BoardFilter, existing: readonly string[]): BoardFilter {
  const keep = f.projectIds.filter((id) => existing.includes(id))
  return keep.length === f.projectIds.length ? f : { ...f, projectIds: keep }
}

/**
 * Số task cho từng lựa chọn trong panel lọc: số task sẽ hiện nếu bật thêm lựa chọn đó
 * (giữ nguyên các nhóm lọc khác và từ khoá).
 * - Project, ưu tiên (OR trong nhóm): đếm như khi chỉ chọn riêng giá trị đó.
 * - Tag (AND): đếm như khi thêm tag đó vào các tag đang chọn.
 */
export interface FacetCounts {
  projects: Record<string, number>
  priorities: Record<FilterPriority, number>
  /** Khoá là tag viết thường */
  tags: Record<string, number>
}

export function facetCounts(tasks: readonly FilterableTask[], f: BoardFilter, projectIds: readonly string[], tags: readonly string[]): FacetCounts {
  const count = (g: BoardFilter) => tasks.reduce((n, t) => n + (matchTask(t, g) ? 1 : 0), 0)
  const projects: Record<string, number> = {}
  for (const id of projectIds) projects[id] = count({ ...f, projectIds: [id] })
  const priorities = {} as Record<FilterPriority, number>
  for (const p of PRIORITY_VALUES) priorities[p] = count({ ...f, priorities: [p] })
  const tagCounts: Record<string, number> = {}
  for (const tag of tags) {
    const on = f.tags.some((x) => x.toLowerCase() === tag.toLowerCase())
    tagCounts[tag.toLowerCase()] = count(on ? f : { ...f, tags: [...f.tags, tag] })
  }
  return { projects, priorities, tags: tagCounts }
}

/** Tag đã dùng, sắp theo số lần dùng giảm dần rồi theo chữ cái. */
export function collectTags(lists: readonly (readonly string[])[]): string[] {
  const count = new Map<string, { name: string; n: number }>()
  for (const list of lists)
    for (const raw of list) {
      const name = raw.trim()
      if (!name) continue
      const key = name.toLowerCase()
      const cur = count.get(key)
      if (cur) cur.n++
      else count.set(key, { name, n: 1 })
    }
  return [...count.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).map((x) => x.name)
}

/** Gợi ý tag cho ô nhập: bỏ tag đã chọn, ưu tiên khớp đầu chuỗi. */
export function suggestTags(all: readonly string[], selected: readonly string[], input: string, limit = 8): string[] {
  const chosen = new Set(selected.map((x) => x.toLowerCase()))
  const q = fold(input.trim())
  const pool = all.filter((t) => !chosen.has(t.toLowerCase()))
  if (!q) return pool.slice(0, limit)
  const starts = pool.filter((t) => fold(t).startsWith(q))
  const contains = pool.filter((t) => !fold(t).startsWith(q) && fold(t).includes(q))
  return [...starts, ...contains].slice(0, limit)
}
