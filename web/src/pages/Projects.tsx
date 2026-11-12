import { useEffect, useRef, useState } from 'react'
import { FlaskConical, FolderGit2, GitBranch, Lightbulb, Pencil, Plus, ShieldCheck, Trash2, X } from 'lucide-react'
import {
  deleteProject,
  dismissRuleSuggestion,
  fetchPermissionPresets,
  fetchRuleSuggestions,
  onRuleSuggestions,
  saveProject,
  toast,
  useStore,
} from '../store/store'
import { Button, ConfirmDialog, EmptyState, Field, Modal, inputCls } from '../components/ui'
import { STATUS_META } from '../lib/format'
import { MODEL_OPTIONS, modelLabel } from '../lib/model'
import { mergeRules } from '../lib/rules'
import type { PermissionMode, PermissionPreset, Project, RuleSuggestion } from '../types'

const blank: Project = {
  id: '',
  name: '',
  repoPath: '',
  mainBranch: 'main',
  permissionMode: 'acceptEdits',
  allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
  maxParallel: 1,
  budgetAction: 'warn',
}

export function Projects() {
  const s = useStore()
  const [editing, setEditing] = useState<Project | null>(null)
  const [del, setDel] = useState<Project | null>(null)

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center">
        <h1 className="text-lg font-semibold">Projects</h1>
        <Button variant="primary" className="ml-auto" onClick={() => setEditing(blank)}>
          <Plus size={16} /> Thêm project
        </Button>
      </div>

      {s.projects.length === 0 ? (
        <EmptyState icon={<FolderGit2 size={48} />} title="Chưa có project" body="Thêm một repo git để bắt đầu giao việc cho Claude." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {s.projects.map((p) => {
            const tasks = s.tasks.filter((t) => t.projectId === p.id)
            const count = (st: string) => tasks.filter((t) => t.status === st).length
            return (
              <div key={p.id} className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                <div className="flex items-start gap-3">
                  <FolderGit2 className="mt-0.5 text-indigo-500" size={20} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{p.name}</p>
                    <p className="truncate font-mono text-xs text-slate-500" title={p.repoPath}>
                      {p.repoPath}
                    </p>
                  </div>
                  <button onClick={() => setEditing(p)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800" aria-label="Sửa">
                    <Pencil size={15} />
                  </button>
                  <button onClick={() => setDel(p)} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950" aria-label="Xoá">
                    <Trash2 size={15} />
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
                  <span className="inline-flex items-center gap-1">
                    <GitBranch size={12} /> {p.mainBranch}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <ShieldCheck size={12} /> {p.permissionMode}
                  </span>
                  <span>Song song tối đa: {p.maxParallel}</span>
                  {p.testCommand && (
                    <span className="inline-flex items-center gap-1 font-mono">
                      <FlaskConical size={12} /> {p.testCommand}
                    </span>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {(['running', 'needs_input', 'review', 'queued'] as const).map((st) => (
                    <span key={st} className={`rounded-full px-2 py-0.5 text-[11px] ${STATUS_META[st].badge}`}>
                      {STATUS_META[st].label}: {count(st)}
                    </span>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {p.allowedTools.map((t) => (
                    <span key={t} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {t}
                    </span>
                  ))}
                </div>
                <RuleSuggestions project={p} />
              </div>
            )
          })}
        </div>
      )}

      <ProjectModal project={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        title={`Xoá project ${del?.name}?`}
        message="Chỉ xoá khỏi Task Board, repo trên đĩa không bị ảnh hưởng."
        confirmLabel="Xoá"
        danger
        onConfirm={() => del && deleteProject(del.id)}
      />
    </div>
  )
}

export function ProjectModal({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const [p, setP] = useState<Project>(blank)
  const [tool, setTool] = useState('')
  const [touched, setTouched] = useState(false)
  const [lastId, setLastId] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [presetNote, setPresetNote] = useState<string | null>(null)
  const systemModel = useStore().settings.defaultModel

  // nạp lại form khi mở project khác
  const key = project ? project.id || 'new' : null
  if (key !== lastId) {
    setLastId(key)
    if (project) setP(project)
    setTouched(false)
    setPresetNote(null)
    setServerError(null)
  }
  // Kiểm tra cơ bản ở client; việc có phải git repo hay không do server kiểm tra
  const pathError = !p.repoPath.trim()
    ? 'Nhập đường dẫn repo'
    : !/^[A-Za-z]:[\\/]/.test(p.repoPath) && !p.repoPath.startsWith('/')
      ? 'Đường dẫn phải là đường dẫn tuyệt đối'
      : serverError ?? undefined
  const nameError = !p.name.trim() ? 'Nhập tên project' : undefined

  return (
    <Modal
      open={!!project}
      onClose={onClose}
      title={project?.id ? `Sửa project ${project.name}` : 'Thêm project'}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            variant="primary"
            disabled={saving}
            onClick={async () => {
              setTouched(true)
              if ((pathError && pathError !== serverError) || nameError) return
              setSaving(true)
              const err = await saveProject({ ...p, id: p.id || '' })
              setSaving(false)
              setServerError(err)
              if (!err) onClose()
            }}
          >
            {saving ? 'Đang kiểm tra…' : 'Lưu'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tên" error={touched ? nameError : undefined}>
            <input className={inputCls} value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} placeholder="shop-web" />
          </Field>
          <Field label="Nhánh chính">
            <input className={inputCls} value={p.mainBranch} onChange={(e) => setP({ ...p, mainBranch: e.target.value })} />
          </Field>
        </div>
        <Field label="Đường dẫn repo" error={touched ? pathError : undefined} hint="Thư mục gốc chứa .git, ví dụ D:\Projects\my-repo">
          <input className={`${inputCls} font-mono`} value={p.repoPath} onChange={(e) => {
              setP({ ...p, repoPath: e.target.value })
              setServerError(null)
            }} placeholder="D:\Projects\my-repo" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mức quyền mặc định">
            <select className={inputCls} value={p.permissionMode} onChange={(e) => setP({ ...p, permissionMode: e.target.value as PermissionMode })}>
              <option value="acceptEdits">acceptEdits: tự sửa file</option>
              <option value="manual">manual: xin quyền mọi thao tác ghi</option>
              <option value="plan">plan: chỉ lập kế hoạch</option>
            </select>
          </Field>
          <Field label="Số task song song tối đa">
            <input type="number" min={1} max={5} className={inputCls} value={p.maxParallel} onChange={(e) => setP({ ...p, maxParallel: Number(e.target.value) || 1 })} />
          </Field>
          <Field
            label="Model mặc định"
            hint={
              p.defaultModel
                ? 'Áp dụng cho task của project không chọn model riêng.'
                : `Kế thừa hệ thống: ${modelLabel(systemModel) || 'mặc định của Claude CLI'}`
            }
          >
            <select className={inputCls} value={p.defaultModel ?? ''} onChange={(e) => setP({ ...p, defaultModel: e.target.value || undefined })}>
              <option value="">Kế thừa hệ thống</option>
              {MODEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              {p.defaultModel && !MODEL_OPTIONS.some((o) => o.value === p.defaultModel) && <option value={p.defaultModel}>{p.defaultModel}</option>}
            </select>
          </Field>
        </div>
        <Field
          label="Lệnh test (tuỳ chọn)"
          hint="Chạy trong worktree của task khi bấm “Chạy test” trên trang Review. Không hỗ trợ &&, |, >: hãy dùng script, ví dụ npm run test:ci hoặc npm it (cài rồi test)."
        >
          <input
            className={`${inputCls} font-mono`}
            value={p.testCommand ?? ''}
            onChange={(e) => {
              setP({ ...p, testCommand: e.target.value })
              setServerError(null)
            }}
            placeholder="npm test"
          />
        </Field>
        <div>
          <span className="text-sm font-medium">Tool được tự động cho phép (whitelist)</span>
          <p className="mb-2 text-xs text-slate-500">
            Ví dụ: <span className="font-mono">Bash(npm test:*)</span> cho phép mọi lệnh bắt đầu bằng <span className="font-mono">npm test</span>. Lệnh ngoài danh sách sẽ chuyển task sang Needs Input.
          </p>
          <div className="mb-2 flex flex-wrap gap-1">
            {p.allowedTools.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded bg-slate-100 py-0.5 pl-1.5 pr-1 font-mono text-xs dark:bg-slate-800">
                {t}
                <button onClick={() => setP({ ...p, allowedTools: p.allowedTools.filter((x) => x !== t) })} className="text-slate-400 hover:text-rose-600" aria-label={`Bỏ ${t}`}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              className={`${inputCls} font-mono`}
              value={tool}
              onChange={(e) => setTool(e.target.value)}
              placeholder="Bash(git diff:*)"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && tool.trim()) {
                  setP({ ...p, allowedTools: [...new Set([...p.allowedTools, tool.trim()])] })
                  setTool('')
                }
              }}
            />
            <Button
              onClick={() => {
                if (!tool.trim()) return
                setP({ ...p, allowedTools: [...new Set([...p.allowedTools, tool.trim()])] })
                setTool('')
              }}
            >
              Thêm
            </Button>
            <PresetMenu
              onPick={(preset) => {
                const merged = mergeRules(p.allowedTools, preset.rules)
                const added = merged.length - mergeRules(p.allowedTools, []).length
                setP({ ...p, allowedTools: merged })
                setPresetNote(
                  added > 0
                    ? `Đã thêm ${added} rule mới từ “${preset.name}”. Bấm Lưu để áp dụng.`
                    : `Mọi rule của “${preset.name}” đã có trong danh sách.`,
                )
              }}
            />
          </div>
          {presetNote && <p className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-400">{presetNote}</p>}
        </div>
      </div>
    </Modal>
  )
}

/**
 * Khối "Gợi ý thêm vào allowlist" (FR-44): rule đã được cho phép ≥ 3 lần trong 30 ngày.
 * Ẩn khi không có gợi ý. Danh sách cập nhật realtime khi duyệt quyền hoặc sửa allowlist.
 */
function RuleSuggestions({ project }: { project: Project }) {
  const [list, setList] = useState<RuleSuggestion[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const latest = useStore().projects.find((x) => x.id === project.id) ?? project

  useEffect(() => {
    let alive = true
    fetchRuleSuggestions(project.id)
      .then((l) => alive && setList(l))
      .catch(() => alive && setList([])) // không chặn trang Projects khi lỗi tải gợi ý
    const off = onRuleSuggestions((id, l) => id === project.id && setList(l))
    return () => {
      alive = false
      off()
    }
  }, [project.id])

  if (!list.length) return null

  const add = async (rule: string) => {
    setBusy(rule)
    const err = await saveProject({ ...latest, allowedTools: [...new Set([...latest.allowedTools, rule])] })
    setBusy(null)
    if (err) toast({ kind: 'error', title: 'Không thêm được rule', body: err })
    else setList((l) => l.filter((s) => s.rule !== rule))
  }
  const dismiss = async (rule: string) => {
    setBusy(rule)
    const next = await dismissRuleSuggestion(project.id, rule)
    setBusy(null)
    if (next) setList(next)
  }

  return (
    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50/60 p-2.5 dark:border-amber-900/60 dark:bg-amber-950/30">
      <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-300">
        <Lightbulb size={13} /> Gợi ý thêm vào allowlist
      </p>
      <ul className="space-y-1.5">
        {list.map((s) => (
          <li key={s.rule} className="flex items-center gap-2 text-xs">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono font-medium">{s.rule}</span>
                <span className="text-slate-500">đã cho phép {s.count} lần</span>
              </p>
              <p className="truncate font-mono text-[11px] text-slate-500" title={s.example}>
                {s.example}
              </p>
            </div>
            <Button size="sm" disabled={busy === s.rule} onClick={() => add(s.rule)}>
              Thêm
            </Button>
            <Button size="sm" variant="ghost" disabled={busy === s.rule} onClick={() => dismiss(s.rule)}>
              Bỏ qua
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Nút "Thêm từ preset ▾" (PLAN P7-01): tải danh sách preset từ backend khi mở lần đầu. */
function PresetMenu({ onPick }: { onPick: (preset: PermissionPreset) => void }) {
  const [open, setOpen] = useState(false)
  const [presets, setPresets] = useState<PermissionPreset[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    if (!presets) {
      setError(null)
      fetchPermissionPresets()
        .then(setPresets)
        .catch((e: Error) => setError(e.message))
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, presets])

  return (
    <div className="relative" ref={ref}>
      <Button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className="whitespace-nowrap">
        Thêm từ preset ▾
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {error ? (
            <p className="px-3 py-2 text-xs text-rose-600">{error}</p>
          ) : !presets ? (
            <p className="px-3 py-2 text-xs text-slate-500">Đang tải…</p>
          ) : (
            presets.map((preset) => (
              <button
                key={preset.id}
                role="menuitem"
                onClick={() => {
                  onPick(preset)
                  setOpen(false)
                }}
                className="block w-full rounded px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
                title={preset.rules.join('\n')}
              >
                <span className="flex items-center text-sm font-medium">
                  {preset.name}
                  <span className="ml-auto text-[11px] font-normal text-slate-500">{preset.rules.length} rule</span>
                </span>
                <span className="block text-xs text-slate-500">{preset.description}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
