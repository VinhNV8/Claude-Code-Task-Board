// Template prompt (FR-06, PLAN 4.1): dữ liệu mặc định và kiểm tra dữ liệu đầu vào.
import type { PromptTemplate } from './types.ts'
import { parseAgent } from '../../web/src/lib/agent.ts'
import { isPlanMode, normalizePlanMode } from '../../web/src/lib/planMode.ts'
import { normalizeModel } from './model.ts'

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
  {
    id: 'tpl-improve',
    name: 'Cải thiện',
    title: 'Cải thiện ',
    prompt: 'Cải thiện <phần code/tính năng> về <hiệu năng / UX / độ ổn định / khả năng đọc>.\nHiện trạng: <vấn đề đang gặp>\nMục tiêu: <kết quả mong muốn>\n\nHãy phân tích hiện trạng, đề xuất và thực hiện cải thiện, giữ nguyên hành vi hiện có (trừ phần cần cải thiện), chạy test và tóm tắt các thay đổi.',
    tags: ['improve'],
  },
  {
    id: 'tpl-review',
    name: 'Review code',
    title: 'Review ',
    prompt: 'Review <file/nhánh/diff>.\nTìm bug, lỗ hổng bảo mật, vấn đề hiệu năng và code khó bảo trì.\n\nLiệt kê theo mức độ nghiêm trọng, kèm vị trí (file:dòng) và cách sửa đề xuất. Không tự sửa code nếu chưa được yêu cầu.',
    tags: ['review'],
  },
  {
    id: 'tpl-explain',
    name: 'Tìm hiểu code',
    title: 'Tìm hiểu ',
    prompt: 'Giải thích <module/luồng/tính năng> hoạt động thế nào: các file chính, luồng dữ liệu, các phụ thuộc và điểm cần lưu ý khi sửa.\n\nChỉ đọc code, không thay đổi gì.',
    tags: ['docs'],
  },
  // ---- Requirement
  {
    id: 'tpl-req-clarify',
    name: 'Làm rõ yêu cầu',
    title: 'Làm rõ yêu cầu: ',
    prompt: 'Yêu cầu thô: <dán yêu cầu / mô tả từ khách hàng>\nBối cảnh: <người dùng, mục tiêu nghiệp vụ>\n\nHãy đọc code và tài liệu hiện có, rồi:\n1. Tóm tắt lại yêu cầu theo cách hiểu của bạn.\n2. Chỉ ra điểm mơ hồ, mâu thuẫn, thiếu sót (gap) và giả định ngầm.\n3. Liệt kê câu hỏi cần hỏi stakeholder, xếp theo mức độ ưu tiên.\n\nKhông sửa code.',
    tags: ['requirement'],
    planMode: 'only',
  },
  {
    id: 'tpl-req-story',
    name: 'Viết user story',
    title: 'User story: ',
    prompt: 'Yêu cầu: <mô tả>\n\nChuyển thành các user story dạng "Là <vai trò>, tôi muốn <hành động> để <lợi ích>". Mỗi story có tiêu chí chấp nhận (acceptance criteria) dạng Given/When/Then, gồm cả trường hợp lỗi và trường hợp biên. Đánh dấu story nào phụ thuộc story nào.\n\nGhi kết quả vào <docs/stories/ten-file.md>. Không sửa code.',
    tags: ['requirement'],
  },
  {
    id: 'tpl-req-spec',
    name: 'Viết đặc tả (SPEC)',
    title: 'Đặc tả: ',
    prompt: 'Tính năng: <mô tả>\n\nViết tài liệu đặc tả vào <docs/ten-file.md> gồm: mục tiêu, phạm vi (trong / ngoài phạm vi), luồng nghiệp vụ chính và luồng ngoại lệ, yêu cầu chức năng (đánh mã FR-xx), yêu cầu phi chức năng, dữ liệu / API liên quan, câu hỏi còn mở.\n\nĐối chiếu với code hiện có để đặc tả khớp thực tế. Không sửa code.',
    tags: ['requirement', 'docs'],
  },
  {
    id: 'tpl-req-breakdown',
    name: 'Phân rã thành task',
    title: 'Phân rã: ',
    prompt: 'Yêu cầu / tính năng: <mô tả hoặc đường dẫn tài liệu>\n\nPhân rã thành danh sách task nhỏ, mỗi task làm xong được trong một lần chạy. Mỗi task ghi: tiêu đề, mô tả, file/module dự kiến thay đổi, tiêu chí hoàn thành, task phụ thuộc. Sắp theo thứ tự nên làm và đánh dấu task có thể chạy song song.\n\nKhông sửa code.',
    tags: ['requirement', 'plan'],
    planMode: 'only',
  },
  {
    id: 'tpl-req-impact',
    name: 'Phân tích tác động',
    title: 'Tác động của thay đổi: ',
    prompt: 'Thay đổi dự kiến: <mô tả thay đổi yêu cầu>\n\nPhân tích tác động lên hệ thống hiện tại: module/file bị ảnh hưởng, thay đổi dữ liệu / API / migration, rủi ro hồi quy, test cần bổ sung hoặc sửa, ước lượng độ lớn (S/M/L) cho từng phần. Đề xuất cách triển khai ít rủi ro nhất.\n\nKhông sửa code.',
    tags: ['requirement', 'plan'],
    planMode: 'only',
  },
  {
    id: 'tpl-req-verify',
    name: 'Đối chiếu yêu cầu với code',
    title: 'Đối chiếu yêu cầu: ',
    prompt: 'Tài liệu yêu cầu: <đường dẫn SPEC / user story / danh sách tiêu chí>\n\nKiểm tra code hiện tại đã đáp ứng từng yêu cầu chưa. Lập bảng: mã yêu cầu | trạng thái (Đạt / Một phần / Chưa có / Khác yêu cầu) | bằng chứng (file:dòng, test) | ghi chú. Cuối cùng liệt kê các gap cần làm tiếp.\n\nKhông sửa code.',
    tags: ['requirement', 'review'],
    planMode: 'only',
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
  agent?: unknown
  planMode?: unknown
  model?: unknown
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
  const agent = parseAgent(b.agent)
  if (agent === null) throw new TemplateError('Agent không hợp lệ')
  // P9-08: '' / 'none' / không gửi = theo project (không lưu)
  const plan = normalizePlanMode(b.planMode)
  if (plan !== undefined && !isPlanMode(plan)) throw new TemplateError('Cách làm không hợp lệ')
  const planMode = plan === 'first' || plan === 'only' ? plan : undefined
  // P5-05: model gợi ý ('' / không gửi = theo project/hệ thống)
  let model: string
  try {
    model = normalizeModel(b.model)
  } catch (e) {
    throw new TemplateError((e as Error).message)
  }
  return {
    id: str(b.id).trim() || newId(),
    name,
    title: str(b.title).trim(),
    prompt,
    tags,
    projectId,
    ...(agent ? { agent } : {}),
    ...(planMode ? { planMode } : {}),
    ...(model ? { model } : {}),
  }
}
