// Đăng nhập bằng token khi backend mở truy cập từ xa (PLAN 4.7, NFR-04).
// Phiên lưu trong cookie HttpOnly do backend đặt; web chỉ hỏi trạng thái và gửi token.
// Không phụ thuộc store để store (và WebSocket) chỉ được nạp sau khi đã đăng nhập.

export interface AuthStatus {
  required: boolean
  authenticated: boolean
}

/** Bản mock không có backend: luôn coi như đã đăng nhập. */
export async function fetchAuthStatus(): Promise<AuthStatus> {
  if (__APP_ENV__ === 'mock') return { required: false, authenticated: true }
  const res = await fetch('/api/auth/status', { cache: 'no-store' })
  if (!res.ok) throw new Error(`Lỗi ${res.status}`)
  return (await res.json()) as AuthStatus
}

/** Trả về thông báo lỗi, hoặc null nếu đăng nhập thành công. */
export async function login(token: string): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (res.ok) return null
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    return data.error ?? `Lỗi ${res.status}`
  } catch {
    return 'Không kết nối được tới backend'
  }
}

export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined)
  location.reload()
}

/** Phiên hết hạn / token đổi: tải lại trang để hiện màn hình đăng nhập. */
export function onUnauthorized() {
  location.reload()
}

/** Gọi khi mất kết nối WS: nếu nguyên nhân là chưa đăng nhập thì quay về màn hình đăng nhập. */
export async function checkStillAuthenticated() {
  try {
    const s = await fetchAuthStatus()
    if (s.required && !s.authenticated) onUnauthorized()
  } catch {
    /* backend chưa chạy: để store tự kết nối lại */
  }
}
