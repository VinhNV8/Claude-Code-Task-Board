// F2 (FEATURE-PROPOSAL-2026-11): nhân bản task. Hàm thuần, không đụng DB.
// Giữ: prompt, project, độ ưu tiên, mức quyền, tag, model, agent, giới hạn chi phí, phạm vi ghi, cách làm.
// Không giữ: lịch sử run, kết quả, diff, phiên, nhánh/worktree, kế hoạch đã duyệt, phụ thuộc (người dùng chọn lại).
import type { Task } from './types.ts'

export const COPY_SUFFIX = ' (bản sao)'

/** Tiêu đề bản sao: thêm hậu tố một lần (nhân bản bản sao không thành "(bản sao) (bản sao)"). */
export function copyTitle(title: string) {
  const t = title.trim()
  return t.endsWith(COPY_SUFFIX.trim()) ? t : `${t}${COPY_SUFFIX}`
}

export function duplicateFields(t: Task, run: boolean) {
  return {
    projectId: t.projectId,
    title: copyTitle(t.title),
    prompt: t.prompt,
    priority: t.priority,
    permissionMode: t.permissionMode,
    tags: [...t.tags],
    model: t.model,
    agent: t.agent,
    maxCostUsd: t.maxCostUsd,
    writeScope: t.writeScope ? [...t.writeScope] : undefined,
    planMode: t.planMode,
    status: (run ? 'queued' : 'backlog') as Task['status'],
  }
}
