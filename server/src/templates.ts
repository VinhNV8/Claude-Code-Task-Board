// Template prompt (FR-06, PLAN 4.1): dữ liệu mặc định và kiểm tra dữ liệu đầu vào.
import type { PromptTemplate } from './types.ts'

export const DEFAULT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'tpl-bug',
    name: 'Sửa lỗi',
    title: 'Sửa lỗi: ',
    prompt: 'Lỗi: <mô tả lỗi>\nCách tái hiện: <các bước>\nKỳ vọng: <hành vi đúng>\n\nHãy tìm nguyên nhân, sửa lỗi và viết test để ngăn tái diễn.',
    tags: ['bug'],
  },
  {
    id: 'tpl-test',
    name: 'Viết test',
    title: 'Viết test cho ',
    prompt: 'Viết unit test cho <module/file>. Bao phủ các trường hợp biên. Chạy test và đảm bảo tất cả pass.',
    tags: ['test'],
  },
  {
    id: 'tpl-refactor',
    name: 'Refactor',
    title: 'Refactor ',
    prompt: 'Refactor <phần code> để <mục tiêu>. Không thay đổi hành vi. Chạy test sau khi sửa.',
    tags: ['refactor'],
  },
  {
    id: 'tpl-feature',
    name: 'Tính năng mới',
    title: '',
    prompt: 'Tính năng: <mô tả>\nYêu cầu:\n- \n- \n\nHãy triển khai, viết test và tóm tắt các thay đổi.',
    tags: ['feature'],
  },
]

export class TemplateError extends Error {}

export interface TemplateInput {
  id?: unknown
  name?: unknown
  title?: unknown
  prompt?: unknown
  tags?: unknown
  projectId?: unknown
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * Chuẩn hoá và kiểm tra template. Ném TemplateError (thông báo tiếng Việt) nếu không hợp lệ.
 * `projectExists` dùng để kiểm tra projectId; `newId` sinh id cho template mới.
 */
export function validateTemplate(b: TemplateInput, projectExists: (id: string) => boolean, newId: () => string): PromptTemplate {
  const name = str(b.name).trim()
  if (!name) throw new TemplateError('Nhập tên template')
  if (name.length > 40) throw new TemplateError('Tên template tối đa 40 ký tự')
  const prompt = str(b.prompt)
  if (prompt.trim().length < 10) throw new TemplateError('Nội dung prompt cần ít nhất 10 ký tự')
  if (b.tags !== undefined && !Array.isArray(b.tags)) throw new TemplateError('Tag phải là danh sách')
  const tags = [...new Set(((b.tags as unknown[]) ?? []).map((t) => str(t).trim()).filter(Boolean))]
  const projectId = str(b.projectId).trim() || undefined
  if (projectId && !projectExists(projectId)) throw new TemplateError('Project không hợp lệ')
  return { id: str(b.id).trim() || newId(), name, title: str(b.title).trim(), prompt, tags, projectId }
}
