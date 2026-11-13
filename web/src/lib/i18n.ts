// Đa ngôn ngữ cho giao diện (vi | en).
// Cách dùng: bọc chuỗi tiếng Việt gốc bằng tr(), ví dụ tr('Giao việc') hoặc tr('{n} đang chạy', { n }).
// (Tên tr thay vì t vì code dùng t cho biến task ở rất nhiều chỗ.)
// Chuỗi tiếng Việt chính là khoá; bản tiếng Anh nằm trong web/src/i18n/en.ts. Thiếu bản dịch thì hiện tiếng Việt.
// Ngôn ngữ chọn một lần khi tải trang: lựa chọn người dùng đã lưu (Cài đặt), rồi ?lang=… trên URL
// (extension VS Code truyền theo ngôn ngữ của VS Code), rồi ngôn ngữ trình duyệt. Đổi ngôn ngữ thì tải lại trang.
import { EN } from '../i18n/en.ts'

export type Lang = 'vi' | 'en'
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'vi', label: 'Tiếng Việt' },
]

const STORAGE_KEY = 'taskboard.lang'

/** Chuẩn hoá mã ngôn ngữ bất kỳ (vd. "vi-VN", "en-US", "fr") về ngôn ngữ hỗ trợ; không hỗ trợ thì undefined. */
export function normalizeLang(code: string | null | undefined): Lang | undefined {
  const c = code?.trim().toLowerCase()
  if (!c) return undefined
  if (c === 'vi' || c.startsWith('vi-')) return 'vi'
  return 'en'
}

/** Thứ tự ưu tiên: lựa chọn đã lưu → tham số URL → ngôn ngữ trình duyệt → tiếng Việt. */
export function resolveLang(o: { search?: string; stored?: string | null; navigator?: string }): Lang {
  const fromUrl = new URLSearchParams(o.search ?? '').get('lang')
  return normalizeLang(o.stored) ?? normalizeLang(fromUrl) ?? normalizeLang(o.navigator) ?? 'vi'
}

function readStored() {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function detect(): Lang {
  if (typeof window === 'undefined') return 'vi'
  const lang = resolveLang({ search: window.location.search, stored: readStored(), navigator: window.navigator?.language })
  document.documentElement.lang = lang
  return lang
}

export const LANG: Lang = detect()

/** Điền tham số {tên} vào chuỗi. */
export function format(text: string, params?: Record<string, string | number>) {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))
}

/** Dịch chuỗi tiếng Việt gốc sang ngôn ngữ đang dùng. */
export function translate(lang: Lang, vi: string, params?: Record<string, string | number>, dict: Record<string, string> = EN) {
  return format(lang === 'en' ? (dict[vi] ?? vi) : vi, params)
}

export const tr = (vi: string, params?: Record<string, string | number>) => translate(LANG, vi, params)

/** Đổi ngôn ngữ: lưu lựa chọn (và đặt ?lang để vẫn đổi được khi trình duyệt chặn lưu trữ) rồi tải lại. */
export function setLang(lang: Lang) {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    /* không lưu được: vẫn đổi qua URL */
  }
  const url = new URL(window.location.href)
  url.searchParams.set('lang', lang)
  window.location.replace(url.toString())
}
