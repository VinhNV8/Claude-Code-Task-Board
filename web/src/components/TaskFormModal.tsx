import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Link2, Play, Plus, Save, X } from 'lucide-react'
import { createTask, fetchDepSuggestions, updateTask, useStore, type DepSuggestion } from '../store/store'
import { collectTags, normalizeTags } from '../lib/taskFilter'
import { MODEL_OPTIONS, inheritedModelHint, modelLabel } from '../lib/model'
import type { PermissionMode, Priority, PromptTemplate, Task } from '../types'
import { PERMISSION_MODES, permissionModeOf } from '../lib/permissionMode'
import { TagInput } from './TagInput'
import { Button, Field, Modal, inputCls } from './ui'


export function TaskFormModal({
  open,
  onClose,
  editing,
  defaultProjectId,
}: {
  open: boolean
  onClose: () => void
  editing?: Task
  defaultProjectId?: string
}) {
  const { projects, templates, tasks, settings } = useStore()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [projectId, setProjectId] = useState('')
  const [priority, setPriority] = useState<Priority>('normal')
  const [mode, setMode] = useState<PermissionMode>('acceptEdits')
  const [tags, setTags] = useState<string[]>([])
  const [model, setModel] = useState('')
  /** FR-08: các task phải Done trước task này */
  const [deps, setDeps] = useState<number[]>([])
  const [depHints, setDepHints] = useState<DepSuggestion[]>([])
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setTouched(false)
    if (editing) {
      setTitle(editing.title)
      setPrompt(editing.prompt)
      setProjectId(editing.projectId)
      setPriority(editing.priority)
      setMode(editing.permissionMode)
      setTags(editing.tags)
      setModel(editing.model ?? '')
      setDeps(editing.dependsOn ?? [])
    } else {
      setTitle('')
      setPrompt('')
      const pid = defaultProjectId || projects[0]?.id || ''
      setProjectId(pid)
      setPriority('normal')
      setMode(projects.find((p) => p.id === pid)?.permissionMode ?? 'acceptEdits')
      setTags([])
      setModel('')
      setDeps([])
    }
  }, [open, editing, defaultProjectId, projects])

  // FR-08 nguồn ③: gợi ý task được nhắc tới (#id / mã [P5-01]) trong tiêu đề + prompt. Chỉ gợi ý, người dùng bấm thêm.
  useEffect(() => {
    if (!open || !projectId) return
    const ctl = { cancelled: false }
    const timer = setTimeout(() => {
      fetchDepSuggestions({ projectId, title, prompt, taskId: editing?.id, dependsOn: deps })
        .then((list) => !ctl.cancelled && setDepHints(list))
        .catch(() => !ctl.cancelled && setDepHints([]))
    }, 400)
    return () => {
      ctl.cancelled = true
      clearTimeout(timer)
    }
  }, [open, projectId, title, prompt, deps, editing?.id])

  // Task có thể chọn để chờ: cùng project, chưa Done, không phải chính nó
  const depCandidates = tasks
    .filter((t) => t.projectId === projectId && t.id !== editing?.id && t.status !== 'done' && !deps.includes(t.id))
    .sort((a, b) => b.id - a.id)
  const taskById = (id: number) => tasks.find((t) => t.id === id)

  // Gợi ý: tag của task đã có + tag trong template, dùng nhiều lên trước
  const tagSuggestions = useMemo(() => collectTags([...tasks.map((t) => t.tags), ...templates.map((t) => t.tags)]), [tasks, templates])

  const errors = {
    title: !title.trim() ? 'Vui lòng nhập tiêu đề' : undefined,
    prompt: prompt.trim().length < 10 ? 'Mô tả cần ít nhất 10 ký tự để Claude hiểu yêu cầu' : undefined,
    projectId: !projectId ? 'Chọn project' : undefined,
  }
  const valid = !errors.title && !errors.prompt && !errors.projectId

  // Template chung + template riêng của project đang chọn
  const usableTemplates = templates.filter((t) => !t.projectId || t.projectId === projectId)

  function applyTemplate(t: PromptTemplate) {
    setPrompt(t.prompt)
    // Chỉ điền tiêu đề/tag khi người dùng chưa nhập, tránh ghi đè
    if (!title.trim() && t.title) setTitle(t.title)
    if (!tags.length && t.tags.length) setTags(normalizeTags(t.tags))
  }

  async function submit(run: boolean) {
    setTouched(true)
    if (!valid) return
    const tagList = normalizeTags(tags)
    setSaving(true)
    try {
      if (editing) {
        await updateTask(editing.id, { title, prompt, projectId, priority, permissionMode: mode, tags: tagList, model, dependsOn: deps })
        onClose()
        return
      }
      const id = await createTask({ title, prompt, projectId, priority, permissionMode: mode, tags: tagList, model, dependsOn: deps, run })
      onClose()
      if (run) navigate(`/tasks/${id}`)
    } catch {
      /* lỗi đã hiện bằng toast, giữ form để sửa */
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Sửa task #${editing.id}` : 'Giao việc mới cho Claude'}
      wide
      footer={
        editing ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Huỷ
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => submit(false)}>
              <Save size={16} /> Lưu thay đổi
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Huỷ
            </Button>
            <Button disabled={saving} onClick={() => submit(false)}>
              <Save size={16} /> Lưu vào Backlog
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => submit(true)}>
              <Play size={16} /> Lưu &amp; Chạy
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <Field label="Tiêu đề" error={touched ? errors.title : undefined}>
          <input autoFocus className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="VD: Sửa lỗi không hiển thị thông báo khi đăng nhập sai" />
        </Field>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Mô tả yêu cầu (prompt gửi cho Claude)</span>
            <div className="flex flex-wrap justify-end gap-1">
              {usableTemplates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => applyTemplate(t)}
                  className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-700 dark:text-slate-300"
                  title="Dùng template"
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
          <textarea
            className={`${inputCls} min-h-[160px] font-mono text-[13px]`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Mô tả chi tiết việc cần làm, ngữ cảnh, tiêu chí hoàn thành…"
          />
          {touched && errors.prompt && <span className="text-xs text-rose-600">{errors.prompt}</span>}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Project" error={touched ? errors.projectId : undefined}>
            <select
              className={inputCls}
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value)
                setDeps([]) // phụ thuộc chỉ trong cùng project
                const p = projects.find((x) => x.id === e.target.value)
                if (p && !editing) setMode(p.permissionMode)
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Độ ưu tiên">
            <select className={inputCls} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              <option value="urgent">Khẩn cấp</option>
              <option value="high">Cao</option>
              <option value="normal">Bình thường</option>
              <option value="low">Thấp</option>
            </select>
          </Field>
          <Field label="Mức quyền" hint={permissionModeOf(mode).description}>
            <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
              {PERMISSION_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <TagInput label="Tag" value={tags} onChange={setTags} suggestions={tagSuggestions} />
          <Field
            label="Model"
            hint={model ? `Chọn riêng: ${modelLabel(model)}` : inheritedModelHint(projects.find((p) => p.id === projectId), settings)}
          >
            <select className={inputCls} value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Theo mặc định</option>
              {MODEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              {/* ID đầy đủ đặt qua API: vẫn hiện để không mất khi sửa task */}
              {model && !MODEL_OPTIONS.some((o) => o.value === model) && <option value={model}>{model}</option>}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Chờ task" hint="Task chỉ chạy khi các task này Done (đã chấp nhận output). Để trống nếu task chạy độc lập.">
              <div className="flex flex-wrap items-center gap-1.5">
                {deps.map((id) => {
                  const t = taskById(id)
                  return (
                    <span key={id} className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">
                      <Link2 size={11} /> #{id} <span className="max-w-[14rem] truncate text-slate-500">{t?.title}</span>
                      <button type="button" onClick={() => setDeps(deps.filter((d) => d !== id))} className="text-slate-400 hover:text-rose-600" title="Bỏ">
                        <X size={12} />
                      </button>
                    </span>
                  )
                })}
                <select
                  className={`${inputCls} w-auto min-w-[12rem] py-1 text-xs`}
                  value=""
                  onChange={(e) => e.target.value && setDeps([...deps, Number(e.target.value)].sort((a, b) => a - b))}
                >
                  <option value="">+ Thêm task cần chờ…</option>
                  {depCandidates.map((t) => (
                    <option key={t.id} value={t.id}>
                      #{t.id} {t.title.slice(0, 70)}
                    </option>
                  ))}
                </select>
              </div>
              {depHints.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-amber-600 dark:text-amber-400">Nội dung có nhắc tới:</span>
                  {depHints.map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => setDeps([...deps, h.id].sort((a, b) => a - b))}
                      className="inline-flex items-center gap-1 rounded border border-amber-300 px-1.5 py-0.5 hover:bg-amber-50 dark:border-amber-800 dark:hover:bg-amber-950"
                      title="Thêm vào danh sách chờ"
                    >
                      <Plus size={11} /> #{h.id} <span className="max-w-[14rem] truncate">{h.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </Field>
          </div>
        </div>
      </div>
    </Modal>
  )
}
