// Phạm vi ghi của task (FR-49): danh sách mẫu đường dẫn tương đối với thư mục làm việc của task.
//   `docs/**` hoặc `docs/` hoặc `docs`  mọi file trong thư mục docs
//   `*.md`                             mẫu không có `/`: so với tên file ở mọi cấp thư mục
//   `src/*.ts`                         `*` khớp trong một cấp thư mục, `**` khớp nhiều cấp, `?` một ký tự
// Ba lớp: ràng buộc gắn vào prompt; lệnh ghi file ngoài phạm vi bị từ chối ngay (server/src/writeScopeGuard.ts);
// bước Review cảnh báo file ngoài phạm vi còn lọt (vd sửa bằng lệnh shell). Hàm thuần, dùng chung cho web và server.

export const MAX_SCOPE_PATTERNS = 20
export const MAX_SCOPE_PATTERN_LENGTH = 200

/** Chuẩn hoá: tách theo dấu phẩy, chấm phẩy hoặc xuống dòng; `\` → `/`; bỏ `./` và `/` đầu; bỏ trùng. */
export function normalizeScope(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[,;\n]/) : []
  const out: string[] = []
  for (const p of parts) {
    const v = p.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/')
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** Lỗi của danh sách mẫu (tiếng Việt), hoặc undefined nếu hợp lệ. */
export function scopeProblem(patterns: string[]): string | undefined {
  if (patterns.length > MAX_SCOPE_PATTERNS) return `Phạm vi ghi tối đa ${MAX_SCOPE_PATTERNS} mẫu`
  for (const p of patterns) {
    if (p.length > MAX_SCOPE_PATTERN_LENGTH) return `Mẫu phạm vi ghi quá dài (tối đa ${MAX_SCOPE_PATTERN_LENGTH} ký tự): ${p.slice(0, 40)}…`
    if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith('~')) return `Phạm vi ghi phải là đường dẫn tương đối với thư mục project: ${p}`
    if (p.split('/').includes('..')) return `Phạm vi ghi không được chứa "..": ${p}`
  }
  return undefined
}

function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` = không hoặc nhiều cấp thư mục; `**` ở cuối = mọi thứ
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}

/** Đường dẫn (tương đối, dùng `/`) có nằm trong phạm vi không. Phạm vi rỗng = không giới hạn. */
export function inScope(path: string, patterns: string[]): boolean {
  if (!patterns.length) return true
  const p = path.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  const base = p.slice(p.lastIndexOf('/') + 1)
  return patterns.some((raw) => {
    const pat = raw.replace(/\/+$/, '')
    if (!pat) return true
    const hasGlob = /[*?]/.test(pat)
    if (!pat.includes('/')) {
      // `*.md` khớp tên file ở mọi cấp; `docs` (không glob) là thư mục hoặc file ở gốc
      if (hasGlob) return globToRegex(pat).test(base)
    }
    if (!hasGlob) return p.toLowerCase() === pat.toLowerCase() || p.toLowerCase().startsWith(`${pat.toLowerCase()}/`)
    return globToRegex(pat).test(p) || globToRegex(`${pat}/**`).test(p)
  })
}

/** File trong diff nằm ngoài phạm vi (đổi tên: xét cả tên cũ lẫn tên mới). */
export function outOfScope(files: { path: string; oldPath?: string }[], patterns: string[]): string[] {
  if (!patterns.length) return []
  return files.filter((f) => !inScope(f.path, patterns) || (f.oldPath !== undefined && !inScope(f.oldPath, patterns))).map((f) => f.path)
}

/** Ràng buộc gắn vào cuối prompt gửi cho agent. */
export function scopePrompt(patterns: string[]): string {
  return [
    'Ràng buộc phạm vi ghi (do Task Board gắn thêm):',
    `- Chỉ được tạo, sửa, xoá hoặc đổi tên file khớp các mẫu sau (tương đối với thư mục làm việc): ${patterns.join(', ')}`,
    '- Được đọc mọi file để lấy ngữ cảnh.',
    '- Lệnh ghi file ngoài phạm vi sẽ bị Task Board từ chối. Không dùng lệnh shell để ghi file ngoài phạm vi.',
    '- Nếu thấy cần sửa file ngoài phạm vi này, KHÔNG tự sửa: ghi rõ file và nội dung cần sửa vào mục "Đề xuất ngoài phạm vi" ở cuối câu trả lời.',
  ].join('\n')
}

/** Prompt gốc của task kèm ràng buộc phạm vi (không có phạm vi: giữ nguyên). */
export function withScope(prompt: string, patterns: string[] | undefined): string {
  return patterns?.length ? `${prompt}\n\n${scopePrompt(patterns)}` : prompt
}
