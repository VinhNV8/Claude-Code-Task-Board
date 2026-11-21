import type { PermissionMode } from '../types'
import { tr } from './i18n.ts'

export interface PermissionModeOption {
  value: PermissionMode
  label: string
  description: string
}

/** Các mức quyền, thứ tự hiển thị giống bộ chọn mode của Claude Code. */
export const PERMISSION_MODES: PermissionModeOption[] = [
  {
    value: 'manual',
    label: 'Manual',
    description: tr('Mọi thao tác ghi (sửa file, chạy lệnh) đều chờ người duyệt.'),
  },
  {
    value: 'acceptEdits',
    label: 'Edit automatically',
    description: tr('Tự sửa file; lệnh ngoài whitelist của project phải chờ người duyệt.'),
  },
  {
    value: 'plan',
    label: 'Plan',
    description: tr('Chỉ đọc code và lập kế hoạch, không sửa gì.'),
  },
  {
    value: 'auto',
    label: 'Auto',
    description: tr('Tự động duyệt mọi thao tác qua được kiểm tra an toàn; chỉ dừng chờ người với lệnh rủi ro cao.'),
  },
]

/**
 * Mức quyền chọn được ở form task / project. `plan` không còn là mức quyền mà là cách làm "Chỉ kế hoạch"
 * (SPEC-PLAN-HANDOFF A5); vẫn giữ trong PERMISSION_MODES để hiển thị dữ liệu cũ.
 */
export const SELECTABLE_MODES = PERMISSION_MODES.filter((m) => m.value !== 'plan')

export const permissionModeOf = (m: PermissionMode) => PERMISSION_MODES.find((o) => o.value === m) ?? PERMISSION_MODES[1]
