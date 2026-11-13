// Trạng thái mở rộng/thu nhỏ left-menu (file thuần, không phụ thuộc DOM/React để test được)

export const SIDEBAR_STORAGE_KEY = 'sidebar-collapsed'
/** Panel Bộ lọc trên Bảng công việc dùng chung cơ chế lưu */
export const FILTER_PANEL_STORAGE_KEY = 'board-filter-collapsed'

/** Phần tối thiểu của Storage mà ta dùng (localStorage hoặc bản giả trong test) */
export type KVStorage = Pick<Storage, 'getItem' | 'setItem'>

/** Giá trị lưu → boolean. Giá trị lạ/thiếu ⇒ mặc định mở rộng (false). */
export function parseCollapsed(raw: string | null | undefined): boolean {
  return raw === '1' || raw === 'true'
}

export function serializeCollapsed(collapsed: boolean): string {
  return collapsed ? '1' : '0'
}

/** Đọc trạng thái; storage lỗi (private mode, bị chặn) ⇒ mở rộng */
export function loadCollapsed(storage: KVStorage | undefined | null, key = SIDEBAR_STORAGE_KEY): boolean {
  try {
    return parseCollapsed(storage?.getItem(key))
  } catch {
    return false
  }
}

export function saveCollapsed(storage: KVStorage | undefined | null, collapsed: boolean, key = SIDEBAR_STORAGE_KEY): void {
  try {
    storage?.setItem(key, serializeCollapsed(collapsed))
  } catch {
    /* bỏ qua */
  }
}

/** Phím tắt "[" để thu/mở menu — bỏ qua khi đang gõ trong ô nhập hoặc có phím bổ trợ */
export function isSidebarShortcut(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; targetTag?: string; isContentEditable?: boolean }): boolean {
  if (e.key !== '[' || e.ctrlKey || e.metaKey || e.altKey) return false
  if (e.isContentEditable) return false
  return !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.targetTag ?? '').toUpperCase())
}

/** Badge hiển thị gọn khi menu thu nhỏ (không đủ chỗ cho số lớn) */
export function compactBadge(n: number): string {
  if (n <= 0) return ''
  return n > 9 ? '9+' : String(n)
}
