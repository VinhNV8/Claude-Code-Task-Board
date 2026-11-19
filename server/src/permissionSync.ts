// FR-48: đổi mức quyền của project → hỏi người dùng có áp dụng cho các task chưa chạy hay không.
//   Phạm vi: task của project ở Backlog, Queued, Failed có mức quyền khác mức mới.
//   Bỏ qua: task ở mode Plan khi mức mới không phải Plan (task chỉ phân tích, không được tự nới thành task sửa code);
//           task chọn agent riêng mà agent đó không chạy được ở mức mới (FR-91).
// Task Running / Needs Input / Review / Done giữ nguyên: đang chạy dở hoặc đã chạy xong.
import { agentProblem } from './agents/index.ts'
import { resolveAgent } from '../../web/src/lib/agent.ts'
import type { PermissionMode, PermissionSyncPlan, PermissionSyncTask, Project, Settings, Task, TaskStatus } from './types.ts'

/** Trạng thái được đổi mức quyền theo project. */
export const SYNC_STATUSES: TaskStatus[] = ['backlog', 'queued', 'failed']

const ref = (t: Task): PermissionSyncTask => ({ id: t.id, title: t.title, status: t.status, permissionMode: t.permissionMode })

/**
 * Hàm thuần: chia task của project thành nhóm sẽ đổi và nhóm bỏ qua.
 * `project` là project SAU khi sửa (agent mặc định mới quyết định agent của task không chọn riêng).
 */
export function planPermissionSync(
  project: Pick<Project, 'id' | 'defaultAgent'>,
  mode: PermissionMode,
  allTasks: Task[],
  settings: Pick<Settings, 'defaultAgent'>,
): PermissionSyncPlan {
  const plan: PermissionSyncPlan = { mode, apply: [], skippedPlan: [], skippedAgent: [] }
  for (const t of allTasks) {
    if (t.projectId !== project.id || !SYNC_STATUSES.includes(t.status) || t.permissionMode === mode) continue
    if (t.permissionMode === 'plan') {
      plan.skippedPlan.push(ref(t))
      continue
    }
    const problem = agentProblem(resolveAgent({ agent: t.agent }, project, settings), mode)
    if (problem) {
      plan.skippedAgent.push({ ...ref(t), reason: problem })
      continue
    }
    plan.apply.push(ref(t))
  }
  for (const list of [plan.apply, plan.skippedPlan, plan.skippedAgent]) list.sort((a, b) => a.id - b.id)
  return plan
}
