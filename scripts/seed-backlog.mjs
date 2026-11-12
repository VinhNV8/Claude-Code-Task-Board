#!/usr/bin/env node
// Nạp các task trong docs/backlog.json vào cột Backlog của Claude Task Board qua API.
//
// Cách dùng (server phải đang chạy):
//   node scripts/seed-backlog.mjs                 # tự tìm project trỏ tới repo này
//   node scripts/seed-backlog.mjs --project p-xxxx
//   node scripts/seed-backlog.mjs --only P2,C     # chỉ nạp task có mã bắt đầu bằng P2 hoặc C
//   node scripts/seed-backlog.mjs --dry-run       # chỉ in ra, không tạo
//   node scripts/seed-backlog.mjs --url http://127.0.0.1:3000
//
// Chạy lại nhiều lần an toàn: task trùng tiêu đề trong cùng project sẽ được bỏ qua.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const dryRun = args.includes('--dry-run')
const only = opt('only')
  ?.split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean)

const backlog = JSON.parse(readFileSync(join(ROOT, 'docs', 'backlog.json'), 'utf8'))
const items = backlog.tasks.filter((t) => !only || only.some((p) => t.code.toUpperCase().startsWith(p)))

async function findServer() {
  const candidates = opt('url') ? [opt('url')] : ['http://127.0.0.1:3001', 'http://127.0.0.1:3000']
  for (const base of candidates) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) return base
    } catch {
      /* thử địa chỉ tiếp theo */
    }
  }
  throw new Error(`Không kết nối được Task Board (${candidates.join(', ')}). Hãy chạy "npm run dev" hoặc "npm start" trước.`)
}

async function api(base, method, path, body) {
  const r = await fetch(`${base}/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`)
  return data
}

const norm = (p) => resolve(p).toLowerCase().replace(/[\\/]+$/, '')

const base = await findServer()
const state = await api(base, 'GET', '/state')

let project
if (opt('project')) {
  project = state.projects.find((p) => p.id === opt('project'))
  if (!project) throw new Error(`Không có project id "${opt('project')}"`)
} else {
  project = state.projects.find((p) => norm(p.repoPath) === norm(ROOT)) ?? (state.projects.length === 1 ? state.projects[0] : undefined)
  if (!project) {
    console.error('Không xác định được project. Các project hiện có:')
    for (const p of state.projects) console.error(`  ${p.id}  ${p.name}  (${p.repoPath})`)
    console.error('Thêm project trỏ tới repo này trên trang Projects, hoặc chạy lại với --project <id>.')
    process.exit(1)
  }
}

console.log(`Server: ${base}`)
console.log(`Project: ${project.name} (${project.id}) → ${project.repoPath}`)
console.log(`${items.length} task${dryRun ? ' (dry run)' : ''}\n`)

const existing = new Set(state.tasks.filter((t) => t.projectId === project.id).map((t) => t.title))
let created = 0
let skipped = 0
for (const item of items) {
  if (existing.has(item.title)) {
    console.log(`  = bỏ qua (đã có)  ${item.title}`)
    skipped++
    continue
  }
  const deps = item.dependsOn?.length ? `\n\nPhụ thuộc: cần hoàn thành trước ${item.dependsOn.join(', ')}.` : ''
  const body = {
    title: item.title,
    prompt: item.prompt + deps + (backlog.commonFooter ?? ''),
    projectId: project.id,
    priority: item.priority,
    tags: item.tags,
    run: false, // vào Backlog, không chạy ngay
  }
  if (dryRun) {
    console.log(`  + ${item.title}  [${item.priority}]`)
    continue
  }
  const t = await api(base, 'POST', '/tasks', body)
  console.log(`  + #${t.id}  ${item.title}  [${item.priority}]`)
  created++
}

if (!dryRun) console.log(`\nĐã tạo ${created}, bỏ qua ${skipped}.`)
