import type { PermissionMode } from '../types'

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
    description: 'Mọi thao tác ghi (sửa file, chạy lệnh) đều chờ người duyệt.',
  },
  {
    value: 'acceptEdits',
    label: 'Edit automatically',
    description: 'Tự sửa file; lệnh ngoài whitelist của project phải chờ người duyệt.',
  },
  {
    value: 'plan',
    label: 'Plan',
    description: 'Chỉ đọc code và lập kế hoạch, không sửa gì.',
  },
  {
    value: 'auto',
    label: 'Auto',
    description: 'Tự động duyệt mọi thao tác qua được kiểm tra an toàn; chỉ dừng chờ người với lệnh rủi ro cao.',
  },
]

export const permissionModeOf = (m: PermissionMode) => PERMISSION_MODES.find((o) => o.value === m) ?? PERMISSION_MODES[1]
