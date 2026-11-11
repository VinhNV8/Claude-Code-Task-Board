import { useState } from 'react'
import { FolderGit2, GitBranch, Pencil, Plus, ShieldCheck, Trash2, X } from 'lucide-react'
import { deleteProject, saveProject, useStore } from '../store/store'
import { Button, ConfirmDialog, EmptyState, Field, Modal, inputCls } from '../components/ui'
import { STATUS_META } from '../lib/format'
import type { PermissionMode, Project } from '../types'

const blank: Project = {
  id: '',
  name: '',
  repoPath: '',
  mainBranch: 'main',
  permissionMode: 'acceptEdits',
  allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
  maxParallel: 1,
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

  // nạp lại form khi mở project khác
  const key = project ? project.id || 'new' : null
  if (key !== lastId) {
    setLastId(key)
    if (project) setP(project)
    setTouched(false)
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
        </div>
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
          </div>
        </div>
      </div>
    </Modal>
  )
}
