/** Lỗi trả về cho client với mã HTTP và thông báo tiếng Việt (error handler ở routes.ts). */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
