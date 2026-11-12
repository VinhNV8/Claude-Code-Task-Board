// Nhãn model cho giao diện (PLAN P5). Giá trị '' nghĩa là kế thừa tầng dưới (D2).
import type { Project, Settings } from '../types'

export const MODEL_OPTIONS = [
  // P5-04 (D2): 'auto' = hệ thống chấm độ khó của task lúc chạy và chọn Haiku/Sonnet/Opus.
  { value: 'auto', label: '🤖 Tự động' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
] as const

/** Tên hiển thị: alias → Haiku/Sonnet/Opus, ID đầy đủ giữ nguyên. */
export function modelLabel(v: string | undefined) {
  if (!v) return ''
  return MODEL_OPTIONS.find((o) => o.value === v)?.label ?? v
}

/** Model một task sẽ dùng nếu để "Theo mặc định": project → Settings → CLI. */
export function inheritedModelHint(project: Pick<Project, 'defaultModel'> | undefined, settings: Pick<Settings, 'defaultModel'>) {
  if (project?.defaultModel) return `Theo project: ${modelLabel(project.defaultModel)}`
  if (settings.defaultModel) return `Theo mặc định hệ thống: ${modelLabel(settings.defaultModel)}`
  return 'Theo mặc định của Claude CLI'
}
