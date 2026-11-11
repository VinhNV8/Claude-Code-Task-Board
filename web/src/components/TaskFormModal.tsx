import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Play, Save } from 'lucide-react'
import { promptTemplates } from '../mocks/data'
import { createTask, updateTask, useStore } from '../store/store'
import type { PermissionMode, Priority, Task } from '../types'
import { Button, Field, Modal, inputCls } from './ui'

const PERMISSION_LABEL: Record<PermissionMode, string> = {
  acceptEdits: 'Tự sửa file, lệnh ngoài whitelist phải xin quyền',
  manual: 'Mọi thao tác ghi đều phải xin quyền',
  plan: 'Chỉ lập kế hoạch, không sửa file',
}

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
  const { projects } = useStore()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [projectId, setProjectId] = useState('')
  const [priority, setPriority] = useState<Priority>('normal')
  const [mode, setMode] = useState<PermissionMode>('acceptEdits')
  const [tags, setTags] = useState('')
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
      setTags(editing.tags.join(', '))
    } else {
      setTitle('')
      setPrompt('')
      const pid = defaultProjectId || projects[0]?.id || ''
      setProjectId(pid)
      setPriority('normal')
      setMode(projects.find((p) => p.id === pid)?.permissionMode ?? 'acceptEdits')
      setTags('')
    }
  }, [open, editing, defaultProjectId, projects])

  const errors = {
    title: !title.trim() ? 'Vui lòng nhập tiêu đề' : undefined,
    prompt: prompt.trim().length < 10 ? 'Mô tả cần ít nhất 10 ký tự để Claude hiểu yêu cầu' : undefined,
    projectId: !projectId ? 'Chọn project' : undefined,
  }
  const valid = !errors.title && !errors.prompt && !errors.projectId

  async function submit(run: boolean) {
    setTouched(true)
    if (!valid) return
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean)
    setSaving(true)
    try {
      if (editing) {
        await updateTask(editing.id, { title, prompt, projectId, priority, permissionMode: mode, tags: tagList })
        onClose()
        return
      }
      const id = await createTask({ title, prompt, projectId, priority, permissionMode: mode, tags: tagList, run })
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
            <div className="flex gap-1">
              {promptTemplates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setPrompt(t.text)}
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
          <Field label="Mức quyền" hint={PERMISSION_LABEL[mode]}>
            <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
              <option value="acceptEdits">acceptEdits</option>
              <option value="manual">manual</option>
              <option value="plan">plan</option>
            </select>
          </Field>
          <Field label="Tag" hint="Phân cách bằng dấu phẩy">
            <input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="bug, ui" />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
