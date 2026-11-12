// Bộ rule allowlist có sẵn (PLAN P7-01): thêm nhanh vào project để giảm số lần phải duyệt quyền.
// Chỉ gồm lệnh đọc/kiểm tra, KHÔNG có lệnh có tác dụng phụ (npm install, git push, git commit...).
// Cú pháp rule giống permissionRules.ts.

export interface PermissionPreset {
  id: string
  name: string
  description: string
  rules: string[]
}

export const PERMISSION_PRESETS: PermissionPreset[] = [
  {
    id: 'read',
    name: 'Chỉ đọc file',
    description: 'Đọc và tìm kiếm file trong repo (Read, Glob, Grep).',
    rules: ['Read'],
  },
  {
    id: 'git-read',
    name: 'Git chỉ đọc',
    description: 'Xem trạng thái, diff, lịch sử git. Không commit, không push.',
    rules: [
      'Bash(git status)',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git branch)',
      'Bash(git rev-parse:*)',
    ],
  },
  {
    id: 'node',
    name: 'Node/npm',
    description: 'Chạy test, lint, typecheck, build. Không cài package.',
    rules: [
      'Bash(npm test)',
      'Bash(npm test:*)',
      'Bash(npm run test:*)',
      'Bash(npm run lint:*)',
      'Bash(npm run typecheck:*)',
      'Bash(npm run build:*)',
      'Bash(npx tsc:*)',
      'Bash(node --version)',
    ],
  },
  {
    id: 'python',
    name: 'Python',
    description: 'Chạy pytest, ruff check, mypy. Không cài package.',
    rules: ['Bash(pytest:*)', 'Bash(python -m pytest:*)', 'Bash(ruff check:*)', 'Bash(mypy:*)', 'Bash(python --version)'],
  },
]

/** Gộp rule mới vào danh sách hiện có: giữ thứ tự, bỏ rule rỗng và rule trùng (so sánh sau trim). */
export function mergeRules(current: string[], add: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of [...current, ...add]) {
    const t = r.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}
