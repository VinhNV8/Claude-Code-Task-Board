// Ghép output chạy test (FR-34) nhận qua WS theo offset trong luồng output của server.
import type { TestOutput } from '../types'

/** Giữ tối đa chừng này ký tự cuối (giống server). */
export const MAX_TEST_OUTPUT = 256 * 1024

export const EMPTY_TEST_OUTPUT: TestOutput = { text: '', end: 0 }

/**
 * Ghép `chunk` (bắt đầu tại `offset`) vào output hiện có. Đoạn trùng (đã có) được bỏ qua.
 * Trả null nếu bị hụt dữ liệu (offset vượt quá phần đã có): cần tải lại toàn bộ.
 */
export function appendTestOutput(cur: TestOutput, offset: number, chunk: string, max = MAX_TEST_OUTPUT): TestOutput | null {
  if (offset > cur.end) return null
  const skip = cur.end - offset
  if (skip >= chunk.length) return cur
  let text = cur.text + chunk.slice(skip)
  if (text.length > max) text = text.slice(-max)
  return { text, end: offset + chunk.length }
}
