// Chọn agent chạy task (SPEC-MULTI-AGENT FR-91) và badge agent (FR-95).
// Agent chưa có adapter / không hỗ trợ mức quyền đang chọn: vẫn hiện nhưng bị khoá, kèm lý do.
import { useStore } from '../store/store'
import { AGENT_IDS, AGENT_NAMES, agentModeProblem } from '../lib/agent'
import type { AgentId, AgentInfo, PermissionMode } from '../types'
import { inputCls } from './ui'
import { tr } from '../lib/i18n'

/** Thông tin agent từ server; chưa tải xong thì dựng tạm từ tên (không chặn chọn). */
export function useAgents(): AgentInfo[] {
  const { agents } = useStore()
  if (agents.length) return agents
  return AGENT_IDS.map((id) => ({
    id,
    name: AGENT_NAMES[id],
    label: AGENT_NAMES[id],
    supported: id === 'claude',
    installed: true,
    permissionModes: [],
    costUsd: id === 'claude',
    hardBudget: id === 'claude',
  }))
}

const nameOf = (agents: AgentInfo[], id: AgentId) => agents.find((a) => a.id === id)?.name ?? AGENT_NAMES[id]

/** Lý do không chọn được agent (hiện sau tên trong dropdown); undefined = chọn được. */
function optionNote(a: AgentInfo, mode: PermissionMode | undefined): string | undefined {
  // Danh sách tạm (chưa tải): permissionModes rỗng, không chặn theo mức quyền
  const problem = a.permissionModes.length || !a.supported ? agentModeProblem(a, mode ?? 'acceptEdits') : undefined
  if (problem === 'unsupported') return tr('{agent} (sắp có)', { agent: a.label })
  if (problem === 'mode' && mode) return tr('{agent} (không hỗ trợ mức quyền này)', { agent: a.label })
  return undefined
}

export function AgentSelect({
  value,
  onChange,
  inherit,
  emptyLabel,
  mode,
  className = inputCls,
}: {
  value: AgentId | ''
  onChange: (v: AgentId | '') => void
  /** Có: thêm lựa chọn "Kế thừa" (giá trị '') với agent kế thừa này. */
  inherit?: AgentId
  /** Không có `inherit`: nhãn cho lựa chọn trống (giá trị ''), VD "Theo project". */
  emptyLabel?: string
  /** Mức quyền đang chọn: khoá agent không hỗ trợ. */
  mode?: PermissionMode
  className?: string
}) {
  const agents = useAgents()
  return (
    <select className={className} value={value} onChange={(e) => onChange(e.target.value as AgentId | '')}>
      {inherit && <option value="">{tr('Kế thừa: {agent}', { agent: nameOf(agents, inherit) })}</option>}
      {!inherit && emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {agents.map((a) => {
        const note = optionNote(a, mode)
        // Đang chọn sẵn (dữ liệu cũ) thì vẫn hiện được, không khoá để không mất giá trị khi sửa
        return (
          <option key={a.id} value={a.id} disabled={!!note && a.id !== value}>
            {note ?? (a.installed ? a.label : tr('{agent} (chưa cài)', { agent: a.label }))}
          </option>
        )
      })}
    </select>
  )
}

/** Gợi ý dưới ô chọn: agent sẽ dùng, phiên bản, cảnh báo chưa cài / không hỗ trợ mức quyền. */
export function agentHint(agents: AgentInfo[], id: AgentId, mode?: PermissionMode): string {
  const a = agents.find((x) => x.id === id)
  if (!a) return AGENT_NAMES[id]
  if (!a.supported) return tr('Task Board chưa hỗ trợ chạy task bằng {agent}.', { agent: a.name })
  if (mode && a.permissionModes.length && !a.permissionModes.includes(mode)) return tr('{agent} không hỗ trợ mức quyền đang chọn.', { agent: a.name })
  if (!a.installed) return tr('Chưa tìm thấy CLI của {agent} trên máy. Task chạy bằng agent này sẽ báo lỗi cho tới khi cài.', { agent: a.name })
  return a.version ? `${a.label} · ${a.version}` : a.label
}

/**
 * Badge tên agent (task, lịch sử run). `quiet`: không hiện khi là Claude (mặc định), để thẻ task gọn.
 * `switched`: task đang chạy bằng agent dự phòng sau khi tự chuyển (FR-99), luôn hiện kèm mũi tên.
 */
export function AgentBadge({ agent, quiet = false, switched = false }: { agent: AgentId | undefined; quiet?: boolean; switched?: boolean }) {
  const id = agent ?? 'claude'
  if (quiet && id === 'claude' && !switched) return null
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${
        switched ? 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300' : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
      }`}
      title={switched ? tr('Đã tự chuyển sang agent dự phòng') : 'Agent'}
    >
      {switched ? `↪ ${AGENT_NAMES[id]}` : AGENT_NAMES[id]}
    </span>
  )
}

/** Sửa chuỗi dự phòng (FR-99): thứ tự agent, lên/xuống, bỏ, thêm agent chưa có trong chuỗi. */
export function ChainEditor({ value, onChange }: { value: AgentId[]; onChange: (v: AgentId[]) => void }) {
  const agents = useAgents()
  const move = (i: number, d: -1 | 1) => {
    const next = [...value]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const rest = agents.filter((a) => !value.includes(a.id))
  const btn = 'rounded px-1.5 text-xs text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800'
  return (
    <div className="space-y-1">
      <ol className="space-y-1">
        {value.map((id, i) => {
          const a = agents.find((x) => x.id === id)
          return (
            <li key={id} className="flex items-center gap-2 text-sm">
              <span className="w-5 text-right text-xs text-slate-400">{i + 1}.</span>
              <span className="w-40">{a?.label ?? AGENT_NAMES[id]}</span>
              {a && !a.supported && <span className="text-xs text-slate-500">{tr('Sắp có')}</span>}
              {a?.supported && !a.installed && <span className="text-xs text-amber-600">{tr('Chưa cài')}</span>}
              <button type="button" className={btn} disabled={i === 0} onClick={() => move(i, -1)} title={tr('Lên')}>
                ↑
              </button>
              <button type="button" className={btn} disabled={i === value.length - 1} onClick={() => move(i, 1)} title={tr('Xuống')}>
                ↓
              </button>
              <button type="button" className={btn} onClick={() => onChange(value.filter((x) => x !== id))} title={tr('Bỏ')}>
                ✕
              </button>
            </li>
          )
        })}
      </ol>
      {rest.length > 0 && (
        <select className={`${inputCls} w-56 py-1 text-xs`} value="" onChange={(e) => e.target.value && onChange([...value, e.target.value as AgentId])}>
          <option value="">{tr('+ Thêm agent')}</option>
          {rest.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
