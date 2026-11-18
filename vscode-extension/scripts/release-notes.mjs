// In ra release notes cho GitHub Release: mục "## <version>" trong CHANGELOG.md + hướng dẫn cài.
// Dùng: node scripts/release-notes.mjs <version> <vsix-file-name>
// Thoát lỗi nếu CHANGELOG không có mục cho version đó (tránh phát hành mà quên ghi thay đổi).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [version, vsix] = process.argv.slice(2)
if (!version || !vsix) {
  console.error('Dùng: node scripts/release-notes.mjs <version> <vsix-file-name>')
  process.exit(2)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n')

/** Nội dung giữa "## <version>" và tiêu đề "## " kế tiếp. */
function section(text, v) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${v}`)
  if (start < 0) return undefined
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim()
}

// Link tài liệu tuyệt đối theo tag (link tương đối không chạy trong trang Release)
const repo = process.env.GITHUB_REPOSITORY || 'VinhNV8/Claude-Code-Task-Board'
const ref = process.env.GITHUB_REF_NAME || 'main'
const docs = `https://github.com/${repo}/blob/${ref}/vscode-extension`

const notes = section(changelog, version)
if (!notes) {
  console.error(`CHANGELOG.md không có mục "## ${version}"`)
  process.exit(1)
}

process.stdout.write(`## Install

1. Download **${vsix}** below.
2. In VS Code, open Extensions, click **…** → **Install from VSIX…**, and pick the file.
   Or run \`code --install-extension ${vsix}\`.

Full guide: [English](${docs}/INSTALL.md) · [Tiếng Việt](${docs}/INSTALL.vi.md). Requires VS Code 1.101 or later and Claude Code (signed in) or an Anthropic API key.

To check the download, compare its SHA-256 with \`${vsix}.sha256\`.

## Changes

${notes}
`)
