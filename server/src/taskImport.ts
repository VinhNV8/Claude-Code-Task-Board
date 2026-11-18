// Import task hàng loạt (SPEC FR-01a, docs/SPEC-IMPORT.md mục 2.4–2.5).
// Web đã đọc file và map tên cột (web/src/lib/taskImport.ts); ở đây kiểm tra giá trị từng dòng bằng đúng quy tắc
// của form tạo task (validateTask), giải mã phụ thuộc giữa các dòng, chống trùng tiêu đề, rồi tạo tất cả trong
// một transaction (I2). `dryRun` chỉ trả kết quả kiểm tra, không ghi gì.
import { inTransaction, projects, taskDeps, tasks } from './db.ts'
import { HttpError } from './httpError.ts'
import { validateTask } from './taskValidate.ts'
import { MAX_DEPS } from './taskDeps.ts'
import { taskCode } from '../../web/src/lib/deps.ts'
import {
  IMPORT_MAX_CELL,
  IMPORT_MAX_ROWS,
  normalizePermissionMode,
  normalizePriority,
  splitList,
  titleKey,
  type ImportRequest,
  type ImportResult,
  type ImportRow,
  type ImportRowResult,
} from '../../web/src/lib/taskImport.ts'
import type { PermissionMode, Priority, Project, Task } from './types.ts'

interface Planned {
  row: ImportRow
  result: ImportRowResult
  /** Dữ liệu sẽ tạo (khi dòng hợp lệ). */
  data?: {
    projectId: string
    title: string
    prompt: string
    priority: Priority
    permissionMode: PermissionMode
    tags: string[]
    model?: string
    maxCostUsd?: number
  }
  /** Phụ thuộc đã giải mã: task đã có và dòng khác trong file. */
  depTasks: number[]
  depLines: number[]
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
const list = (v: unknown) => (Array.isArray(v) ? v.map(str).map((s) => s.trim()).filter(Boolean) : typeof v === 'string' ? splitList(v) : [])
const keyOf = (k: string) => k.trim().toUpperCase()

/** Làm sạch body từ client: chỉ giữ field đã biết, ép kiểu chuỗi. */
function cleanRow(raw: unknown, index: number): ImportRow {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const line = Number.isInteger(r.line) && (r.line as number) > 0 ? (r.line as number) : index + 2
  return {
    line,
    title: str(r.title),
    prompt: str(r.prompt),
    key: str(r.key).trim() || undefined,
    dependsOn: list(r.dependsOn),
    project: str(r.project).trim() || undefined,
    priority: str(r.priority).trim() || undefined,
    tags: list(r.tags),
    model: str(r.model).trim() || undefined,
    permissionMode: str(r.permissionMode).trim() || undefined,
    maxCostUsd: str(r.maxCostUsd).trim() || undefined,
  }
}

/** Chạy một bước kiểm tra của validateTask, lỗi thì ghi vào danh sách thay vì ném. */
function check<T>(errors: string[], fn: () => T): T | undefined {
  try {
    return fn()
  } catch (e) {
    if (e instanceof HttpError) {
      errors.push(e.message)
      return undefined
    }
    throw e
  }
}

function projectResolver(fallback: Project) {
  const all = projects.all()
  return (name: string | undefined): Project | string => {
    if (!name) return fallback
    const byId = all.find((p) => p.id === name)
    if (byId) return byId
    const byName = all.filter((p) => p.name.trim().toLowerCase() === name.toLowerCase())
    if (byName.length === 1) return byName[0]
    if (byName.length > 1) return `Có ${byName.length} project tên "${name}", hãy ghi id project`
    return `Không tìm thấy project "${name}"`
  }
}

function validateRequest(body: Partial<ImportRequest> | undefined) {
  const b = body ?? {}
  const project = b.projectId ? projects.get(b.projectId) : undefined
  if (!project) throw new HttpError(400, 'Project không hợp lệ')
  if (!Array.isArray(b.rows) || b.rows.length === 0) throw new HttpError(400, 'Không có dòng nào để import')
  if (b.rows.length > IMPORT_MAX_ROWS) throw new HttpError(400, `Mỗi lần import tối đa ${IMPORT_MAX_ROWS} dòng`)
  if (b.onDuplicate !== undefined && b.onDuplicate !== 'skip' && b.onDuplicate !== 'create')
    throw new HttpError(400, 'Cách xử lý dòng trùng không hợp lệ')
  return {
    project,
    rows: b.rows.map(cleanRow),
    onDuplicate: b.onDuplicate ?? 'skip',
    run: b.run === true,
    confirmAuto: b.confirmAuto === true,
    dryRun: b.dryRun !== false,
  }
}

/** Kiểm tra toàn bộ, không ghi gì. */
function plan(req: ReturnType<typeof validateRequest>): Planned[] {
  const resolveProject = projectResolver(req.project)
  const existing = tasks.all()
  const existingByTitle = new Map<string, number>()
  for (const t of existing) {
    const k = `${t.projectId}\n${titleKey(t.title)}`
    if (!existingByTitle.has(k)) existingByTitle.set(k, t.id)
  }

  const planned: Planned[] = req.rows.map((row) => ({ row, result: { line: row.line, status: 'ok' }, depTasks: [], depLines: [] }))
  const byLine = new Map(planned.map((p) => [p.row.line, p]))
  if (byLine.size !== planned.length) throw new HttpError(400, 'Số dòng bị trùng trong dữ liệu gửi lên')

  // 1. Giá trị từng dòng (cùng quy tắc với form tạo task)
  for (const p of planned) {
    const { row, result } = p
    const errors: string[] = []
    const long = (['title', 'prompt', 'key', 'project', 'model', 'priority', 'permissionMode', 'maxCostUsd'] as const).filter(
      (f) => str(row[f]).length > IMPORT_MAX_CELL,
    )
    if (long.length) errors.push(`Ô quá dài (tối đa ${IMPORT_MAX_CELL.toLocaleString('vi-VN')} ký tự): ${long.join(', ')}`)
    const proj = resolveProject(row.project)
    if (typeof proj === 'string') errors.push(proj)
    else result.projectId = proj.id
    const v = {
      title: check(errors, () => validateTask({ title: row.title }, true).title),
      prompt: check(errors, () => validateTask({ prompt: row.prompt }, true).prompt),
      priority: check(errors, () => validateTask({ priority: normalizePriority(row.priority) as Priority | undefined }, true).priority),
      mode: check(errors, () => validateTask({ permissionMode: normalizePermissionMode(row.permissionMode) as PermissionMode | undefined }, true).permissionMode),
      tags: check(errors, () => validateTask({ tags: row.tags ?? [] }, true).tags),
      model: check(errors, () => validateTask({ model: row.model ?? '' }, true).model),
      maxCost: check(errors, () => validateTask({ maxCostUsd: row.maxCostUsd ?? '' }, true).maxCostUsd),
    }
    if (typeof proj !== 'string') {
      result.permissionMode = v.mode ?? proj.permissionMode
      if (!errors.length)
        p.data = {
          projectId: proj.id,
          title: v.title!,
          prompt: v.prompt!,
          priority: v.priority ?? 'normal',
          permissionMode: result.permissionMode,
          tags: v.tags ?? [],
          model: v.model || undefined,
          maxCostUsd: (v.maxCost as number | null | undefined) ?? undefined,
        }
    }
    if (errors.length) {
      result.status = 'error'
      result.errors = errors
    }
  }

  // 2. Mã (cột key) không trùng trong file
  const byKey = new Map<string, Planned>()
  for (const p of planned) {
    if (!p.row.key) continue
    const k = keyOf(p.row.key)
    const first = byKey.get(k)
    if (first) addError(p, `Mã "${p.row.key}" trùng với dòng ${first.row.line}`)
    else byKey.set(k, p)
  }

  // 3. Trùng tiêu đề (I3): với task đã có, hoặc dòng trước trong file. Mặc định bỏ qua dòng trùng.
  const seen = new Map<string, number>()
  for (const p of planned) {
    const pid = p.result.projectId
    if (!pid || !p.row.title.trim()) continue
    const k = `${pid}\n${titleKey(p.row.title)}`
    const taskId = existingByTitle.get(k)
    const line = seen.get(k)
    if (taskId !== undefined) p.result.duplicateOf = { taskId }
    else if (line !== undefined) p.result.duplicateOf = { line }
    else seen.set(k, p.row.line)
    if (p.result.duplicateOf && req.onDuplicate === 'skip') {
      // Dòng bị bỏ qua không chặn import, kể cả khi có lỗi giá trị.
      p.result.status = 'duplicate'
      delete p.result.errors
      p.data = undefined
    }
  }
  const creates = (p: Planned) => p.result.status !== 'duplicate'

  /** Dòng bị bỏ qua vì trùng: phụ thuộc vào nó được nối sang task đã có / dòng gốc cùng tiêu đề (I4). */
  const targetOf = (p: Planned): { taskId: number } | { line: number } | undefined => {
    for (let cur: Planned | undefined = p, hops = 0; cur && hops <= planned.length; hops++) {
      if (creates(cur)) return { line: cur.row.line }
      const d: ImportRowResult['duplicateOf'] = cur.result.duplicateOf
      if (d?.taskId !== undefined) return { taskId: d.taskId }
      cur = d?.line !== undefined ? byLine.get(d.line) : undefined
    }
    return undefined
  }

  // 4. Phụ thuộc (I4): mã trong file → `#id` / số → mã task đã có (tiêu đề "[P2-01] …"). Chỉ cùng project.
  for (const p of planned) {
    if (!creates(p) || !p.row.dependsOn?.length) continue
    const pid = p.result.projectId
    const tasksOut = new Set<number>()
    const linesOut = new Set<number>()
    for (const ref of p.row.dependsOn) {
      const inFile = byKey.get(keyOf(ref))
      if (inFile) {
        const target = targetOf(inFile)
        if (!target) {
          addError(p, `Không xác định được task của mã "${ref}"`)
          continue
        }
        if ('line' in target) {
          if (target.line === p.row.line) addError(p, 'Task không thể chờ chính nó')
          else if (byLine.get(target.line)!.result.projectId !== pid) addError(p, `Mã "${ref}" thuộc project khác, chỉ chờ được task cùng project`)
          else linesOut.add(target.line)
          continue
        }
        const t = tasks.get(target.taskId)
        if (t && t.projectId === pid) tasksOut.add(t.id)
        else addError(p, `Mã "${ref}" thuộc project khác, chỉ chờ được task cùng project`)
        continue
      }
      const idMatch = ref.match(/^#?(\d{1,9})$/)
      if (idMatch) {
        const t = tasks.get(Number(idMatch[1]))
        if (!t) addError(p, `Không tìm thấy task #${idMatch[1]}`)
        else if (t.projectId !== pid) addError(p, `Task #${t.id} thuộc project khác, chỉ chờ được task cùng project`)
        else tasksOut.add(t.id)
        continue
      }
      const byCode = existing.filter((t) => t.projectId === pid && taskCode(t.title) === keyOf(ref))
      if (byCode.length === 1) tasksOut.add(byCode[0].id)
      else if (byCode.length > 1) addError(p, `Có ${byCode.length} task mang mã "${ref}", hãy ghi #id`)
      else addError(p, `Không tìm thấy mã "${ref}" trong file hoặc trong các task đã có`)
    }
    if (tasksOut.size + linesOut.size > MAX_DEPS) addError(p, `Một task chờ tối đa ${MAX_DEPS} task`)
    p.depTasks = [...tasksOut]
    p.depLines = [...linesOut]
  }

  // 5. Vòng tròn giữa các dòng mới (task đã có không thể chờ task chưa tạo, nên vòng chỉ nằm trong file)
  const label = (line: number) => {
    const k = byLine.get(line)?.row.key
    return k ? `dòng ${line} (${k})` : `dòng ${line}`
  }
  const state = new Map<number, 1 | 2>() // 1: đang duyệt, 2: xong
  const reported = new Set<number>()
  const visit = (line: number, path: number[]) => {
    state.set(line, 1)
    for (const next of byLine.get(line)!.depLines) {
      const st = state.get(next)
      if (st === 1) {
        const cycle = [...path.slice(path.indexOf(next)), next]
        const msg = `Phụ thuộc vòng tròn: ${cycle.map(label).join(' → ')}`
        for (const l of cycle) if (!reported.has(l)) addError(byLine.get(l)!, msg)
        cycle.forEach((l) => reported.add(l))
      } else if (st === undefined) visit(next, [...path, next])
    }
    state.set(line, 2)
  }
  for (const p of planned) if (creates(p) && !state.has(p.row.line)) visit(p.row.line, [p.row.line])

  return planned
}

function addError(p: Planned, msg: string) {
  p.result.status = 'error'
  p.result.errors = [...(p.result.errors ?? []), msg]
  p.data = undefined
}

function summary(planned: Planned[]): ImportResult {
  const rows = planned.map((p) => p.result)
  const ok = rows.filter((r) => r.status === 'ok')
  return {
    rows,
    created: 0,
    skipped: rows.filter((r) => r.status === 'duplicate').length,
    autoCount: ok.filter((r) => r.permissionMode === 'auto').length,
  }
}

/**
 * POST /api/tasks/import. dryRun (mặc định): kết quả kiểm tra từng dòng.
 * Tạo thật: còn dòng lỗi thì 400 và không tạo gì; có task mức quyền Auto mà chưa xác nhận thì 400 `CONFIRM_AUTO`.
 */
export function importTasks(body: Partial<ImportRequest> | undefined): ImportResult & { tasks: Task[] } {
  const req = validateRequest(body)
  const planned = plan(req)
  const out = summary(planned)
  if (req.dryRun) return { ...out, tasks: [] }

  const errorCount = out.rows.filter((r) => r.status === 'error').length
  if (errorCount) throw new HttpError(400, `Còn ${errorCount} dòng lỗi, chưa tạo task nào`, 'IMPORT_INVALID')
  if (out.autoCount && !req.confirmAuto)
    throw new HttpError(400, `${out.autoCount} task dùng mức quyền Auto, cần xác nhận trước khi tạo`, 'CONFIRM_AUTO')

  const toCreate = planned.filter((p) => p.data)
  if (!toCreate.length) return { ...out, tasks: [] }
  const idByLine = new Map<number, number>()
  inTransaction(() => {
    for (const p of toCreate) {
      const t = tasks.create({ ...p.data!, status: req.run ? 'queued' : 'backlog' })
      idByLine.set(p.row.line, t.id)
      p.result.taskId = t.id
    }
    for (const p of toCreate) {
      const deps = [...new Set([...p.depTasks, ...p.depLines.map((l) => idByLine.get(l)!)])].sort((a, b) => a - b)
      if (deps.length) taskDeps.write(p.result.taskId!, deps)
    }
  })
  return { ...out, created: toCreate.length, tasks: toCreate.map((p) => tasks.get(p.result.taskId!)!) }
}
