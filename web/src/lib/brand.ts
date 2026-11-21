// Nhận diện thương hiệu: tên tool + logo dùng chung cho sidebar, màn đăng nhập, title tab và favicon.
import { tr } from './i18n.ts'
export const APP_NAME = 'Agent Task Board'
export const APP_TAGLINE = tr('Điều phối Claude Code theo bảng công việc')

/** Tiêu đề tab: thêm nhãn môi trường (DEV/UAT) và/hoặc tên trang. */
export function pageTitle(opts: { env?: string; page?: string } = {}): string {
  const base = opts.env ? `[${opts.env}] ${APP_NAME}` : APP_NAME
  return opts.page ? `${opts.page} · ${base}` : base
}
