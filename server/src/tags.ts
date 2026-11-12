// Chuẩn hoá tag của task (FR-07). Giới hạn khớp với web/src/lib/taskFilter.ts.

export const MAX_TAGS = 20
export const MAX_TAG_LENGTH = 40

export class TagError extends Error {}

/** Trim, gộp khoảng trắng, bỏ rỗng, bỏ trùng không phân biệt hoa thường (giữ cách viết đầu tiên). */
export function validateTags(input: unknown): string[] {
  if (!Array.isArray(input)) throw new TagError('Tag phải là danh sách')
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') throw new TagError('Tag phải là chuỗi')
    const t = raw.replace(/\s+/g, ' ').trim()
    if (!t) continue
    if (t.length > MAX_TAG_LENGTH) throw new TagError(`Tag "${t.slice(0, 20)}…" dài quá ${MAX_TAG_LENGTH} ký tự`)
    if (t.includes(',')) throw new TagError('Tag không được chứa dấu phẩy')
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  if (out.length > MAX_TAGS) throw new TagError(`Mỗi task tối đa ${MAX_TAGS} tag`)
  return out
}
