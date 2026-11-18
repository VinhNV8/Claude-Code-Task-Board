// Cấp API key cho Claude CLI qua `apiKeyHelper` (chế độ API key), thay cho biến môi trường ANTHROPIC_API_KEY.
//
// Vì sao: biến môi trường của Claude được mọi lệnh nó chạy (Bash, npm script, hook...) thừa hưởng, nên một repo có
// prompt injection chỉ cần `env`/`printenv` là lộ key. Với apiKeyHelper, CLI tự gọi script lấy key; key không nằm
// trong môi trường và không ghi ra đĩa.
//
// Mỗi run được cấp một token riêng, chỉ dùng được khi task đó đang chạy và bị huỷ khi run kết thúc.
// CLI gọi lại helper nhiều lần (làm mới, thử lại khi lỗi xác thực), nên token dùng lại được trong suốt run.
// Giới hạn: token nằm trên dòng lệnh helper và trong file settings tạm của run; một lệnh cố ý dò tiến trình/file
// của cùng người dùng vẫn có thể lấy được trong lúc task chạy. Mục tiêu là chặn rò rỉ phổ biến qua biến môi trường.
import { randomBytes, timingSafeEqual } from 'node:crypto'

const issued = new Map<number, string>()

/** Cấp token mới cho task (thay token cũ nếu có). */
export function issueKeyToken(taskId: number) {
  const token = randomBytes(24).toString('hex')
  issued.set(taskId, token)
  return token
}

export function revokeKeyToken(taskId: number) {
  issued.delete(taskId)
}

/** Token có đúng là token đang cấp cho task không (so sánh thời gian hằng). */
export function checkKeyToken(taskId: number, token: unknown) {
  const cur = issued.get(taskId)
  if (!cur || typeof token !== 'string') return false
  const a = Buffer.from(cur)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}
