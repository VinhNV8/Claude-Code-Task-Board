// Cấu hình tiến trình backend dùng chung cho index.ts, runner.ts và route nội bộ.
import { randomBytes } from 'node:crypto'

export const PROD = process.env.NODE_ENV === 'production'
// NFR-04: địa chỉ lắng nghe và đăng nhập token xem auth.ts (resolveListenConfig), đọc ở index.ts.
export const PORT = Number(process.env.PORT ?? (PROD ? 3000 : 3001))

/**
 * Token nội bộ cho MCP permission server gọi về `/api/internal/*` (header x-taskboard-token).
 * Mặc định sinh ngẫu nhiên mỗi lần khởi động; đặt TASKBOARD_TOKEN để cố định khi cần debug.
 */
export const INTERNAL_TOKEN = process.env.TASKBOARD_TOKEN || randomBytes(24).toString('hex')
