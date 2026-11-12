/** Gộp rule mới vào danh sách hiện có: giữ thứ tự, bỏ rule rỗng và trùng (so sánh sau trim). Cùng logic với server/src/permissionPresets.ts. */
export function mergeRules(current: string[], add: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of [...current, ...add]) {
    const t = r.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}
