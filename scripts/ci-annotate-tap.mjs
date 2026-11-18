// CI: đọc file TAP của node --test, in mỗi test hỏng thành một annotation lỗi của GitHub Actions.
// Dùng: node scripts/ci-annotate-tap.mjs <file.tap> [tiêu đề]
import { existsSync, readFileSync } from 'node:fs'

const [file, title = 'Tests'] = process.argv.slice(2)
if (!file || !existsSync(file)) {
  console.log(`Không có file TAP: ${file}`)
  process.exit(0)
}

const lines = readFileSync(file, 'utf8').split(/\r?\n/)
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C')

let count = 0
for (let i = 0; i < lines.length && count < 10; i++) {
  const m = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i])
  if (!m) continue
  // Khối YAML chi tiết (thụt sâu hơn) ngay sau dòng "not ok"
  const indent = m[1].length
  const detail = []
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]
    const ind = l.length - l.trimStart().length
    if (l.trim() && ind <= indent) break
    detail.push(l.slice(indent))
  }
  // Bỏ test cha chỉ báo "subtest failed" (test con đã có annotation riêng)
  if (detail.some((l) => /failureType: 'subtestsFailed'/.test(l))) continue
  count++
  console.log(`::error title=${escProp(`${title}: ${m[2]}`)}::${esc(detail.slice(0, 60).join('\n'))}`)
}
console.log(`${count} test hỏng đã được ghi thành annotation`)
