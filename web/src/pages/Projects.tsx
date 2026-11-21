import { useEffect, useRef, useState } from 'react'
import { FlaskConical, FolderGit2, GitBranch, Lightbulb, Pencil, Plus, ShieldCheck, Trash2, X } from 'lucide-react'
import {
  deleteProject,
  dismissRuleSuggestion,
  fetchPermissionPresets,
  fetchRuleSuggestions,
  onRuleSuggestions,
  previewPermissionSync,
  saveProject,
  toast,
  useStore,
} from '../store/store'
import { Button, ConfirmDialog, EmptyState, Field, Modal, inputCls } from '../components/ui'
import { STATUS_META } from '../lib/format'
import { MODEL_OPTIONS, modelLabel } from '../lib/model'
import { AgentSelect, ChainEditor, agentHint, useAgents } from '../components/AgentSelect'
import { AGENT_NAMES } from '../lib/agent'
import { mergeRules } from '../lib/rules'
import { SELECTABLE_MODES, permissionModeOf } from '../lib/permissionMode'
import { PLAN_MODES, planModeOf } from '../lib/planMode'
import type { FailoverMode, PermissionMode, PermissionPreset, PermissionSyncPlan, PermissionSyncTask, Project, RuleSuggestion, TaskStatus } from '../types'
import { tr } from '../lib/i18n'

/** Project trống cho form "Thêm project" (dùng cả ở Bảng công việc) */
export const BLANK_PROJECT: Project = {
  id: '',
  name: '',
  repoPath: '',
  mainBranch: 'main',
  permissionMode: 'acceptEdits',
  allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
  maxParallel: 1,
  budgetAction: 'warn',
  // Chỉ là giá trị giữ chỗ: form project mới mặc định "Tự chọn" (FR-63), server quyết định theo thư mục
  deliveryMode: 'direct',
}

/** Lựa chọn "Nơi lưu output" trên form project. */
const DELIVERY_MODES: { value: Project['deliveryMode']; label: string; desc: string }[] = [
  {
    value: 'direct',
    label: tr('Ghi thẳng vào thư mục project'),
    desc: tr('Output nằm ngay trong thư mục trên máy bạn, không cần git. Mỗi lúc chạy 1 task để các task không ghi đè nhau.'),
  },
  {
    value: 'worktree',
    label: tr('Nhánh git riêng cho từng task'),
    desc: tr('Cần git repo. Mỗi task làm trên nhánh claude/task-<id> ở local, chạy song song được. Bạn tự merge/PR theo quy trình riêng.'),
  },
]

export function Projects() {
  const s = useStore()
  const [editing, setEditing] = useState<Project | null>(null)
  const [del, setDel] = useState<Project | null>(null)

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center">
        <h1 className="text-lg font-semibold">Projects</h1>
        <Button variant="primary" className="ml-auto" onClick={() => setEditing(BLANK_PROJECT)}>
          <Plus size={16} /> {tr('Thêm project')}
        </Button>
      </div>

      {s.projects.length === 0 ? (
        <EmptyState icon={<FolderGit2 size={48} />} title={tr('Chưa có project')} body={tr('Thêm một thư mục (có thể là git repo) để bắt đầu giao việc cho Claude.')} />
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
                  <button onClick={() => setEditing(p)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800" aria-label={tr('Sửa')}>
                    <Pencil size={15} />
                  </button>
                  <button onClick={() => setDel(p)} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950" aria-label={tr('Xoá')}>
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
                  <span>{p.deliveryMode === 'direct' ? tr('Ghi thẳng vào thư mục') : tr('Nhánh riêng · song song tối đa: {n}', { n: p.maxParallel })}</span>
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
        title={tr('Xoá project {name}?', { name: del?.name ?? '' })}
        message={tr('Chỉ xoá khỏi Agent Task Board, thư mục trên đĩa không bị ảnh hưởng.')}
        confirmLabel={tr('Xoá')}
        danger
        onConfirm={() => del && deleteProject(del.id)}
      />
    </div>
  )
}

export function ProjectModal({ project, onClose, onSaved }: { project: Project | null; onClose: () => void; onSaved?: (saved: Project) => void }) {
  const [p, setP] = useState<Project>(BLANK_PROJECT)
  const [tool, setTool] = useState('')
  const [touched, setTouched] = useState(false)
  const [lastId, setLastId] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [presetNote, setPresetNote] = useState<string | null>(null)
  const [syncPlan, setSyncPlan] = useState<PermissionSyncPlan | null>(null)
  // FR-63: project mới mặc định "Tự chọn" cách giao output (không gửi deliveryMode, server chọn theo thư mục)
  const [autoDelivery, setAutoDelivery] = useState(true)
  const auto = autoDelivery && !p.id
  const direct = !auto && p.deliveryMode === 'direct'
  const save = async (syncTasks?: number) => {
    setSaving(true)
    const payload = auto ? ({ ...p, id: '', deliveryMode: undefined } as unknown as Project) : { ...p, id: p.id || '' }
    const err = await saveProject(payload, onSaved, syncTasks)
    setSaving(false)
    setServerError(err)
    setSyncPlan(null)
    if (!err) onClose()
  }
  const systemModel = useStore().settings.defaultModel
  const systemAgent = useStore().settings.defaultAgent
  const systemFailover = useStore().settings.failover
  const agents = useAgents()

  // nạp lại form khi mở project khác
  const key = project ? project.id || 'new' : null
  if (key !== lastId) {
    setLastId(key)
    if (project) setP(project)
    setAutoDelivery(true)
    setTouched(false)
    setPresetNote(null)
    setServerError(null)
  }
  // Kiểm tra cơ bản ở client; việc có phải git repo hay không (mode worktree) do server kiểm tra
  const pathError = !p.repoPath.trim()
    ? tr('Nhập đường dẫn thư mục project')
    : !/^[A-Za-z]:[\\/]/.test(p.repoPath) && !p.repoPath.startsWith('/')
      ? tr('Đường dẫn phải là đường dẫn tuyệt đối')
      : serverError ?? undefined
  const nameError = !p.name.trim() ? tr('Nhập tên project') : undefined

  return (
    <>
    <Modal
      open={!!project && !syncPlan}
      onClose={onClose}
      title={project?.id ? tr('Sửa project {name}', { name: project.name }) : tr('Thêm project')}
      wide="2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr('Huỷ')}
          </Button>
          <Button
            variant="primary"
            disabled={saving}
            onClick={async () => {
              setTouched(true)
              if ((pathError && pathError !== serverError) || nameError) return
              // FR-48: đổi mức quyền của project đã có → hỏi có áp dụng cho task chưa chạy không.
              if (project?.id && project.permissionMode !== p.permissionMode) {
                setSaving(true)
                const plan = await previewPermissionSync(p)
                setSaving(false)
                if (typeof plan === 'string') return setServerError(plan)
                if (plan.apply.length || plan.skippedPlan.length || plan.skippedAgent.length) return setSyncPlan(plan)
              }
              await save()
            }}
          >
            {saving ? tr('Đang kiểm tra…') : tr('Lưu')}
          </Button>
        </>
      }
    >
      <div className="grid gap-x-6 gap-y-4 lg:grid-cols-2">
        {/* Cột trái: thông tin project, cách giao output, chạy task */}
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr('Tên')} error={touched ? nameError : undefined}>
              <input className={inputCls} value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} placeholder="shop-web" />
            </Field>
            <Field label={tr('Nhánh chính')}>
              <input className={inputCls} value={p.mainBranch} onChange={(e) => setP({ ...p, mainBranch: e.target.value })} />
            </Field>
          </div>
          <Field
            label={tr('Thư mục project')}
            error={touched ? pathError : undefined}
            hint={
              direct || auto
                ? tr('Thư mục trên máy bạn, nơi Claude ghi output, ví dụ {example}', { example: 'D:\\Projects\\my-repo' })
                : tr('Thư mục gốc chứa .git, ví dụ {example}', { example: 'D:\\Projects\\my-repo' })
            }
          >
            <input className={`${inputCls} font-mono`} value={p.repoPath} onChange={(e) => {
                setP({ ...p, repoPath: e.target.value })
                setServerError(null)
              }} placeholder="D:\Projects\my-repo" />
          </Field>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium text-slate-700 dark:text-slate-200">{tr('Nơi lưu output')}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {!p.id && (
                <label
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm transition sm:col-span-2 ${
                    auto
                      ? 'border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950/40'
                      : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
                  }`}
                >
                  <input
                    type="radio"
                    name="deliveryMode"
                    className="mt-1"
                    checked={auto}
                    onChange={() => {
                      setAutoDelivery(true)
                      setServerError(null)
                    }}
                  />
                  <span>
                    <span className="block font-medium">{tr('Tự chọn (khuyên dùng)')}</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {tr('Thư mục là git repo có commit: dùng Nhánh git riêng. Thư mục không có git: Ghi thẳng vào thư mục.')}
                    </span>
                  </span>
                </label>
              )}
              {DELIVERY_MODES.map((m) => {
                const active = !auto && p.deliveryMode === m.value
                return (
                  <label
                    key={m.value}
                    className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm transition ${
                      active
                        ? 'border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950/40'
                        : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
                    }`}
                  >
                    <input
                      type="radio"
                      name="deliveryMode"
                      className="mt-1"
                      checked={active}
                      onChange={() => {
                        setP({ ...p, deliveryMode: m.value })
                        setAutoDelivery(false)
                        setServerError(null)
                      }}
                    />
                    <span>
                      <span className="block font-medium">{m.label}</span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400">{m.desc}</span>
                    </span>
                  </label>
                )
              })}
            </div>
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              {tr('Duyệt task chỉ là chấp nhận output; Task Board không tự merge. Đổi lựa chọn chỉ áp dụng cho task chưa chạy.')}
            </span>
            {direct && (
              <span className="block text-xs text-amber-700 dark:text-amber-400">
                {tr('Có session Claude Code khác, công cụ khác hoặc bạn cùng sửa thư mục này? Nên dùng Nhánh git riêng để thay đổi của từng task tách hẳn.')}
              </span>
            )}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr('Số task song song tối đa')} hint={direct ? tr('Ghi thẳng vào thư mục: luôn chạy 1 task mỗi lúc') : undefined}>
              <input
                type="number"
                min={1}
                max={5}
                disabled={direct}
                className={inputCls}
                value={direct ? 1 : p.maxParallel}
                onChange={(e) => setP({ ...p, maxParallel: Number(e.target.value) || 1 })}
              />
            </Field>
            <Field
              label={tr('Model mặc định')}
              hint={
                p.defaultModel
                  ? tr('Áp dụng cho task của project không chọn model riêng.')
                  : tr('Kế thừa hệ thống: {model}', { model: modelLabel(systemModel) || tr('mặc định của Claude CLI') })
              }
            >
              <select className={inputCls} value={p.defaultModel ?? ''} onChange={(e) => setP({ ...p, defaultModel: e.target.value || undefined })}>
                <option value="">{tr('Kế thừa hệ thống')}</option>
                {MODEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
                {p.defaultModel && !MODEL_OPTIONS.some((o) => o.value === p.defaultModel) && <option value={p.defaultModel}>{p.defaultModel}</option>}
              </select>
            </Field>
          </div>
        </div>
        {/* Cột phải: quyền và cách làm của task */}
        <div className="space-y-4">
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium text-slate-700 dark:text-slate-200">{tr('Mức quyền mặc định')}</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {SELECTABLE_MODES.map((m) => {
                const active = p.permissionMode === m.value
                return (
                  <label
                    key={m.value}
                    title={m.description}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-sm transition ${
                      active
                        ? 'border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950/40'
                        : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
                    }`}
                  >
                    <input
                      type="radio"
                      name="permissionMode"
                      checked={active}
                      onChange={() => setP({ ...p, permissionMode: m.value as PermissionMode })}
                    />
                    <span className="font-medium text-slate-800 dark:text-slate-100">{m.label}</span>
                  </label>
                )
              })}
            </div>
            <span className="block text-xs text-slate-600 dark:text-slate-300">{permissionModeOf(p.permissionMode).description}</span>
            <span className="block text-xs text-slate-500 dark:text-slate-400">{tr('Task mới của project sẽ dùng mức quyền này (có thể đổi riêng từng task). Khi đổi mức quyền, bạn sẽ được hỏi có áp dụng cho các task chưa chạy không.')}</span>
          </fieldset>
          <fieldset className="space-y-1">
            {/* SPEC-PLAN-HANDOFF FR-100: cách làm mặc định cho task mới (form, import, lịch) */}
            <legend className="text-sm font-medium text-slate-700 dark:text-slate-200">{tr('Cách làm mặc định của task mới')}</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {PLAN_MODES.map((m) => {
                const active = (p.defaultPlanMode ?? 'none') === m.value
                return (
                  <label
                    key={m.value}
                    title={tr(m.description)}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-sm transition ${
                      active
                        ? 'border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950/40'
                        : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
                    }`}
                  >
                    <input type="radio" name="defaultPlanMode" checked={active} onChange={() => setP({ ...p, defaultPlanMode: m.value })} />
                    <span className="font-medium text-slate-800 dark:text-slate-100">{tr(m.label)}</span>
                  </label>
                )
              })}
            </div>
            <span className="block text-xs text-slate-600 dark:text-slate-300">{tr(planModeOf(p.defaultPlanMode).description)}</span>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={tr('Agent mặc định')}
              hint={
                p.defaultAgent
                  ? `${tr('Áp dụng cho task của project không chọn agent riêng.')} ${agentHint(agents, p.defaultAgent, p.permissionMode)}`
                  : tr('Kế thừa hệ thống: {agent}', { agent: agentHint(agents, systemAgent, p.permissionMode) })
              }
            >
              <AgentSelect
                value={p.defaultAgent ?? ''}
                onChange={(v) => setP({ ...p, defaultAgent: v || undefined })}
                inherit={systemAgent}
                mode={p.permissionMode}
              />
            </Field>
            <Field
              label={tr('Khi agent hết hạn mức')}
              hint={
                (p.failoverMode ?? 'inherit') === 'inherit'
                  ? systemFailover.enabled
                    ? tr('Theo hệ thống: chuyển theo chuỗi {chain}', { chain: systemFailover.chain.map((id) => AGENT_NAMES[id]).join(' → ') })
                    : tr('Theo hệ thống: đang tắt, task chờ giờ reset')
                  : p.failoverMode === 'off'
                    ? tr('Task chờ giờ reset, không chuyển agent (ví dụ project có dữ liệu không được gửi cho nhà cung cấp khác).')
                    : tr('Chuyển theo chuỗi riêng của project.')
              }
            >
              <select
                className={inputCls}
                value={p.failoverMode ?? 'inherit'}
                onChange={(e) => {
                  const mode = e.target.value as FailoverMode
                  setP({ ...p, failoverMode: mode, failoverChain: mode === 'custom' && !p.failoverChain?.length ? [...systemFailover.chain] : p.failoverChain })
                }}
              >
                <option value="inherit">{tr('Dùng chuỗi của hệ thống')}</option>
                <option value="custom">{tr('Tuỳ chỉnh')}</option>
                <option value="off">{tr('Tắt tự chuyển agent')}</option>
              </select>
              {p.failoverMode === 'custom' && (
                <div className="mt-2">
                  <ChainEditor value={p.failoverChain ?? []} onChange={(chain) => setP({ ...p, failoverChain: chain })} />
                </div>
              )}
            </Field>
          </div>
          <div>
            <span className="text-sm font-medium">{tr('Tool được tự động cho phép (whitelist)')}</span>
            <p className="mb-2 text-xs text-slate-500">
              {tr('Ví dụ:')} <span className="font-mono">Bash(npm test:*)</span> {tr('cho phép mọi lệnh bắt đầu bằng')} <span className="font-mono">npm test</span>.{' '}
              {tr('Lệnh ngoài danh sách sẽ chuyển task sang Needs Input.')}
            </p>
            <div className="mb-2 flex flex-wrap gap-1">
              {p.allowedTools.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded bg-slate-100 py-0.5 pl-1.5 pr-1 font-mono text-xs dark:bg-slate-800">
                  {t}
                  <button onClick={() => setP({ ...p, allowedTools: p.allowedTools.filter((x) => x !== t) })} className="text-slate-400 hover:text-rose-600" aria-label={tr('Bỏ {rule}', { rule: t })}>
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
                {tr('Thêm')}
              </Button>
              <PresetMenu
                onPick={(preset) => {
                  const merged = mergeRules(p.allowedTools, preset.rules)
                  const added = merged.length - mergeRules(p.allowedTools, []).length
                  setP({ ...p, allowedTools: merged })
                  setPresetNote(
                    added > 0
                      ? tr('Đã thêm {n} rule mới từ “{name}”. Bấm Lưu để áp dụng.', { n: added, name: preset.name })
                      : tr('Mọi rule của “{name}” đã có trong danh sách.', { name: preset.name }),
                  )
                }}
              />
            </div>
            {presetNote && <p className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-400">{presetNote}</p>}
          </div>
          <Field
            label={tr('Lệnh test (tuỳ chọn)')}
            hint={tr('Chạy trong thư mục của task khi bấm “Chạy test” trên trang Review. Không hỗ trợ &&, |, >: hãy dùng script, ví dụ npm run test:ci hoặc npm it (cài rồi test).')}
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
        </div>
      </div>
    </Modal>
    {syncPlan && project && (
      <PermissionSyncDialog
        plan={syncPlan}
        from={project.permissionMode}
        saving={saving}
        onCancel={() => setSyncPlan(null)}
        onSave={(withTasks) => save(withTasks ? syncPlan.apply.length : undefined)}
      />
    )}
    </>
  )
}

/** FR-48: đổi mức quyền project → hỏi có đổi theo cho các task chưa chạy (Backlog, Queued, Failed) không. */
function PermissionSyncDialog({
  plan,
  from,
  saving,
  onCancel,
  onSave,
}: {
  plan: PermissionSyncPlan
  from: PermissionMode
  saving: boolean
  onCancel: () => void
  onSave: (withTasks: boolean) => void
}) {
  const to = permissionModeOf(plan.mode).label
  const n = plan.apply.length
  const count = (s: TaskStatus) => plan.apply.filter((t) => t.status === s).length
  const byStatus = (['backlog', 'queued', 'failed'] as const)
    .filter((s) => count(s))
    .map((s) => `${STATUS_META[s].label} ${count(s)}`)
    .join(' · ')
  const row = (t: PermissionSyncTask, note?: string) => (
    <li key={t.id} className="flex gap-2 py-0.5">
      <span className="shrink-0 font-mono text-xs text-slate-400">#{t.id}</span>
      <span className="min-w-0 flex-1 truncate" title={t.title}>
        {t.title}
      </span>
      <span className="shrink-0 text-xs text-slate-500">{note ?? permissionModeOf(t.permissionMode).label}</span>
    </li>
  )
  return (
    <Modal
      open
      onClose={onCancel}
      wide
      title={tr('Đổi mức quyền: {from} → {to}', { from: permissionModeOf(from).label, to })}
      footer={
        <>
          <Button variant="ghost" disabled={saving} onClick={onCancel}>
            {tr('Huỷ')}
          </Button>
          <Button variant={n ? 'secondary' : 'primary'} disabled={saving} onClick={() => onSave(false)}>
            {tr('Chỉ đổi project')}
          </Button>
          {n > 0 && (
            <Button variant="primary" disabled={saving} onClick={() => onSave(true)}>
              {tr('Đổi project + {n} task', { n })}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
        {n > 0 ? (
          <>
            <p>
              {tr('Có {n} task chưa chạy ({detail}) đang dùng mức quyền khác. Đổi các task này sang {to}?', { n, detail: byStatus, to })}
            </p>
            <ul className="max-h-40 overflow-y-auto rounded-lg border border-slate-200 px-3 py-1.5 dark:border-slate-700">{plan.apply.map((t) => row(t))}</ul>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {tr('Chọn "Chỉ đổi project" thì các task này giữ mức quyền cũ; task tạo sau sẽ dùng mức mới. Task đang chạy, chờ duyệt hoặc đã xong không bị đổi.')}
            </p>
          </>
        ) : (
          <p>{tr('Không có task chưa chạy nào đổi được sang {to}.', { to })}</p>
        )}
        {plan.mode === 'auto' && n > 0 && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            {tr('Auto: agent tự sửa file và chạy lệnh, không cần bạn duyệt (trừ lệnh rủi ro cao). Chỉ áp dụng nếu bạn tin nội dung các task này.')}
          </p>
        )}
        {plan.skippedPlan.length > 0 && (
          <div>
            <p className="font-medium text-slate-700 dark:text-slate-200">
              {tr('Giữ nguyên {n} task ở mode Plan (chỉ phân tích, không tự chuyển thành task được sửa code):', { n: plan.skippedPlan.length })}
            </p>
            <ul className="mt-1 max-h-28 overflow-y-auto">{plan.skippedPlan.map((t) => row(t))}</ul>
          </div>
        )}
        {plan.skippedAgent.length > 0 && (
          <div>
            <p className="font-medium text-slate-700 dark:text-slate-200">
              {tr('Giữ nguyên {n} task vì agent của task không chạy được ở mức quyền mới:', { n: plan.skippedAgent.length })}
            </p>
            <ul className="mt-1 max-h-28 overflow-y-auto">{plan.skippedAgent.map((t) => row(t, t.reason))}</ul>
          </div>
        )}
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
      // không chặn trang Projects khi lỗi tải gợi ý
      .catch(() => alive && setList([]))
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
    if (err) toast({ kind: 'error', title: tr('Không thêm được rule'), body: err })
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
        <Lightbulb size={13} /> {tr('Gợi ý thêm vào allowlist')}
      </p>
      <ul className="space-y-1.5">
        {list.map((s) => (
          <li key={s.rule} className="flex items-center gap-2 text-xs">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono font-medium">{s.rule}</span>
                <span className="text-slate-500">{tr('đã cho phép {n} lần', { n: s.count })}</span>
              </p>
              <p className="truncate font-mono text-[11px] text-slate-500" title={s.example}>
                {s.example}
              </p>
            </div>
            <Button size="sm" disabled={busy === s.rule} onClick={() => add(s.rule)}>
              {tr('Thêm')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy === s.rule} onClick={() => dismiss(s.rule)}>
              {tr('Bỏ qua')}
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
        {tr('Thêm từ preset ▾')}
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {error ? (
            <p className="px-3 py-2 text-xs text-rose-600">{error}</p>
          ) : !presets ? (
            <p className="px-3 py-2 text-xs text-slate-500">{tr('Đang tải…')}</p>
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
