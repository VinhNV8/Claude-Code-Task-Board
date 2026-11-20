// Kiểm tra dữ liệu tạo / sửa task (FR-01), dùng chung cho POST/PATCH /api/tasks và import (FR-01a).
import { projects } from './db.ts'
import { HttpError } from './httpError.ts'
import { TagError, validateTags } from './tags.ts'
import { normalizeModel } from './model.ts'
import { BudgetError, parseUsd } from './budget.ts'
import { parseAgent } from '../../web/src/lib/agent.ts'
import { normalizeScope, scopeProblem } from '../../web/src/lib/writeScope.ts'
import { isPlanMode, normalizePlanMode } from '../../web/src/lib/planMode.ts'
import type { AgentId, PermissionMode, PlanMode, Priority, Project } from './types.ts'

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
  /** '' hoặc null: kế thừa project → Settings (SPEC-MULTI-AGENT FR-91). */
  agent?: AgentId | '' | null
  /** Giới hạn chi phí mỗi lần chạy (USD, `--max-budget-usd`). null/'': không giới hạn. */
  maxCostUsd?: number | string | null
  /** Các task phải Done trước (FR-08). Không gửi: giữ nguyên; [] hoặc null: bỏ hết. */
  dependsOn?: number[] | null
  /** Phạm vi ghi (FR-49): mảng mẫu hoặc chuỗi cách nhau bởi dấu phẩy. [] / '' / null: không giới hạn. */
  writeScope?: string[] | string | null
  /** FR-100: none / first / only (nhận cả tên tiếng Việt). Không gửi: theo `defaultPlanMode` của project. */
  planMode?: PlanMode | string
  run?: boolean
}

/**
 * SPEC-PLAN-HANDOFF A5: mức quyền `plan` của task (API cũ, file import cũ) chuyển thành planMode `only`, mức quyền
 * theo project. Lượt Kế hoạch luôn chạy mode plan nên task không bị nới quyền.
 */
export function splitLegacyPlan(
  v: { permissionMode?: PermissionMode; planMode?: PlanMode | string },
  project: Pick<Project, 'permissionMode'>,
): { permissionMode?: PermissionMode; planMode?: PlanMode } {
  const planMode = v.planMode as PlanMode | undefined
  if (v.permissionMode !== 'plan') return { permissionMode: v.permissionMode, planMode }
  return { permissionMode: project.permissionMode === 'plan' ? 'manual' : project.permissionMode, planMode: planMode ?? 'only' }
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
  if (b.planMode !== undefined) {
    const m = normalizePlanMode(b.planMode) ?? 'none'
    if (!isPlanMode(m)) throw new HttpError(400, 'Cách làm không hợp lệ (làm luôn / kế hoạch trước / chỉ kế hoạch)')
    out.planMode = m
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
  if (b.agent !== undefined) {
    const a = parseAgent(b.agent)
    if (a === null) throw new HttpError(400, 'Agent không hợp lệ')
    out.agent = a ?? null // null = kế thừa
  }
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
  if (b.writeScope !== undefined) {
    const scope = normalizeScope(b.writeScope ?? [])
    const problem = scopeProblem(scope)
    if (problem) throw new HttpError(400, problem)
    out.writeScope = scope
  }
  return out
}
