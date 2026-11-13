/** Lỗi trả về cho client với mã HTTP và thông báo tiếng Việt (error handler ở routes.ts). */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Mã máy đọc được để giao diện xử lý riêng (ví dụ 'DEPS_PENDING'). */
    public code?: string,
  ) {
    super(message)
  }
}
