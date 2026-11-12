// Quản lý template prompt (FR-06): danh sách + modal thêm/sửa, dùng trong trang Cài đặt.
import { useEffect, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { deleteTemplate, saveTemplate, useStore } from '../store/store'
import type { PromptTemplate } from '../types'
import { Button, ConfirmDialog, Field, Modal, inputCls } from './ui'

function TemplateFormModal({ open, onClose, editing }: { open: boolean; onClose: () => void; editing?: PromptTemplate }) {
  const { projects } = useStore()
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [tags, setTags] = useState('')
  const [projectId, setProjectId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    setName(editing?.name ?? '')
    setTitle(editing?.title ?? '')
    setPrompt(editing?.prompt ?? '')
    setTags(editing?.tags.join(', ') ?? '')
    setProjectId(editing?.projectId ?? '')
  }, [open, editing])

  async function submit() {
    setSaving(true)
    const err = await saveTemplate({
      id: editing?.id,
      name,
      title,
      prompt,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      projectId: projectId || undefined,
    })
    setSaving(false)
    if (err) setError(err)
    else onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Sửa template ${editing.name}` : 'Thêm template'}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="primary" disabled={saving} onClick={submit}>
            Lưu template
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{error}</div>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Tên template" hint="Hiện trên nút chọn trong form tạo task">
            <input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Sửa lỗi" />
          </Field>
          <Field label="Project" hint="Để trống: dùng cho mọi project">
            <select className={inputCls} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Tất cả project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tiêu đề task gợi ý" hint="Điền vào tiêu đề nếu đang trống">
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="VD: Sửa lỗi: " />
          </Field>
          <Field label="Tag" hint="Phân cách bằng dấu phẩy">
            <input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="bug, ui" />
          </Field>
        </div>
        <Field label="Nội dung prompt">
          <textarea
            className={`${inputCls} min-h-[160px] font-mono text-[13px]`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Dùng <...> để đánh dấu chỗ cần điền"
          />
        </Field>
      </div>
    </Modal>
  )
}

export function TemplateManager() {
  const { templates, projects } = useStore()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<PromptTemplate | undefined>()
  const [del, setDel] = useState<PromptTemplate | null>(null)

  const projectName = (id?: string) => (id ? projects.find((p) => p.id === id)?.name ?? id : 'Tất cả project')

  return (
    <>
      {templates.length === 0 ? (
        <p className="text-sm text-slate-500">Chưa có template nào.</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {templates.map((t) => (
            <li key={t.id} className="flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{t.name}</span>
                  <span className="text-xs text-slate-500">· {projectName(t.projectId)}</span>
                  {t.tags.map((tag) => (
                    <span key={tag} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {tag}
                    </span>
                  ))}
                </div>
                <p className="truncate font-mono text-xs text-slate-500">{t.prompt.split('\n')[0]}</p>
              </div>
              <button
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                title="Sửa"
                onClick={() => {
                  setEditing(t)
                  setFormOpen(true)
                }}
              >
                <Pencil size={16} />
              </button>
              <button className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40" title="Xoá" onClick={() => setDel(t)}>
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button
        size="sm"
        onClick={() => {
          setEditing(undefined)
          setFormOpen(true)
        }}
      >
        <Plus size={14} /> Thêm template
      </Button>

      <TemplateFormModal open={formOpen} onClose={() => setFormOpen(false)} editing={editing} />
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        title={`Xoá template ${del?.name}?`}
        message="Task đã tạo từ template này không bị ảnh hưởng."
        confirmLabel="Xoá"
        danger
        onConfirm={() => del && deleteTemplate(del.id)}
      />
    </>
  )
}
