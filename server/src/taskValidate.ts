// Kiểm tra dữ liệu tạo / sửa task (FR-01), dùng chung cho POST/PATCH /api/tasks và import (FR-01a).
import { projects } from './db.ts'
import { HttpError } from './httpError.ts'
import { TagError, validateTags } from './tags.ts'
import { normalizeModel } from './model.ts'
import { BudgetError, parseUsd } from './budget.ts'
import type { PermissionMode, Priority } from './types.ts'

export const PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low']
// Không cho phép bypassPermissions (SPEC Mục 9)
export const MODES: PermissionMode[] = ['acceptEdits', 'manual', 'auto', 'plan']

export interface TaskBody {
  title?: string
  prompt?: string
  projectId?: string
  priority?: Priority
  permissionMode?: PermissionMode
  tags?: string[]
  /** '' hoặc null: kế thừa project → Settings (P5, D2). */
  model?: string | null
  /** Giới hạn chi phí mỗi lần chạy (USD, `--max-budget-usd`). null/'': không giới hạn. */
  maxCostUsd?: number | string | null
  /** Các task phải Done trước (FR-08). Không gửi: giữ nguyên; [] hoặc null: bỏ hết. */
  dependsOn?: number[] | null
  run?: boolean
}

export function validateTask(b: TaskBody, partial = false) {
  const out: TaskBody = {}
  if (!partial || b.title !== undefined) {
    if (!b.title?.trim()) throw new HttpError(400, 'Vui lòng nhập tiêu đề')
    out.title = b.title.trim()
  }
  if (!partial || b.prompt !== undefined) {
    if (!b.prompt || b.prompt.trim().length < 10) throw new HttpError(400, 'Mô tả cần ít nhất 10 ký tự')
    out.prompt = b.prompt
  }
  if (!partial || b.projectId !== undefined) {
    if (!b.projectId || !projects.get(b.projectId)) throw new HttpError(400, 'Project không hợp lệ')
    out.projectId = b.projectId
  }
  if (b.priority !== undefined) {
    if (!PRIORITIES.includes(b.priority)) throw new HttpError(400, 'Độ ưu tiên không hợp lệ')
    out.priority = b.priority
  }
  if (b.permissionMode !== undefined) {
    if (!MODES.includes(b.permissionMode)) throw new HttpError(400, 'Mức quyền không hợp lệ')
    out.permissionMode = b.permissionMode
  }
  if (b.tags !== undefined) {
    try {
      out.tags = validateTags(b.tags)
    } catch (e) {
      if (e instanceof TagError) throw new HttpError(400, e.message)
      throw e
    }
  }
  if (b.model !== undefined) out.model = normalizeModel(b.model)
  if (b.maxCostUsd !== undefined) {
    try {
      const n = parseUsd(b.maxCostUsd, 'Giới hạn chi phí mỗi lần chạy')
      if (n === 0) throw new BudgetError('Giới hạn chi phí mỗi lần chạy phải lớn hơn 0 (để trống nếu không giới hạn)')
      out.maxCostUsd = n ?? null
    } catch (e) {
      if (e instanceof BudgetError) throw new HttpError(400, e.message)
      throw e
    }
  }
  return out
}
