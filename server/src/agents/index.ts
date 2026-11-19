// Danh sách adapter. Hiện có Claude; Codex (M3), Antigravity (M5), Cursor (M6) thêm sau.
import { claudeAdapter } from './claude.ts'
import { codexAdapter } from './codex.ts'
import { antigravityAdapter } from './antigravity.ts'
import { agentLimitedUntil } from './limits.ts'
import { AGENT_IDS, AGENT_NAMES, DEFAULT_AGENT, agentModeProblem, failoverChain, pickFallback } from '../../../web/src/lib/agent.ts'
import { settings } from '../db.ts'
import type { AgentInfo, PermissionMode, Project, Task } from '../types.ts'
import type { AgentAdapter, AgentId } from './types.ts'

export type { AgentAdapter, AgentId } from './types.ts'
export { DEFAULT_AGENT } from '../../../web/src/lib/agent.ts'

const adapters: Partial<Record<AgentId, AgentAdapter>> = { claude: claudeAdapter, codex: codexAdapter, antigravity: antigravityAdapter }
const REAL: Partial<Record<AgentId, AgentAdapter>> = { ...adapters }

/** Tên đầy đủ của agent chưa có adapter (hiện trong dropdown nhưng bị khoá). */
const LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
  antigravity: 'Google Antigravity',
  cursor: 'Cursor',
}

/** Adapter của agent; agent chưa có adapter thì trả undefined để runner báo lỗi rõ ràng. */
export const getAdapter = (id: AgentId = DEFAULT_AGENT): AgentAdapter | undefined => adapters[id]

/** Chỉ dùng trong test: thay adapter (ví dụ agent giả). Không truyền adapter thì khôi phục bản thật. */
export function setAdapterForTest(id: AgentId, adapter?: AgentAdapter) {
  if (adapter) adapters[id] = adapter
  else if (REAL[id]) adapters[id] = REAL[id]
  else delete adapters[id]
}

/** Chỉ dùng trong test: gỡ hẳn adapter (mô phỏng agent chưa được hỗ trợ). */
export function removeAdapterForTest(id: AgentId) {
  delete adapters[id]
}

/** Trạng thái một agent (GET /api/agents). `refresh`: dò lại CLI (người dùng vừa cài). */
export function agentInfo(id: AgentId, refresh = false): AgentInfo {
  const a = adapters[id]
  if (!a) return { id, name: AGENT_NAMES[id], label: LABELS[id], supported: false, installed: false, permissionModes: [], costUsd: false, hardBudget: false }
  const bin = a.findBin(refresh)
  const limitedUntil = agentLimitedUntil(id)
  return {
    id,
    name: a.name,
    label: a.label,
    supported: true,
    installed: !!bin,
    version: bin?.version,
    source: bin?.source,
    permissionModes: [...a.capabilities.permissionModes],
    costUsd: a.capabilities.costUsd,
    hardBudget: a.capabilities.hardBudget,
    ...(limitedUntil !== undefined ? { limitedUntil } : {}),
  }
}

export const listAgents = (refresh = false): AgentInfo[] => AGENT_IDS.map((id) => agentInfo(id, refresh))

/**
 * Agent dự phòng cho task khi `current` hết hạn mức (FR-99, SPEC-MULTI-AGENT 3.6a); undefined = không có / failover tắt.
 * Project dùng budget cứng (chế độ API key + budget tháng) chỉ nhận agent có giới hạn chi phí cứng.
 */
export function chooseFallback(o: { current: AgentId; task: Pick<Task, 'permissionMode'>; project: Project; now?: number }): AgentId | undefined {
  const s = settings.get()
  const chain = failoverChain(o.project, s)
  if (!chain) return undefined
  return pickFallback({
    current: o.current,
    chain,
    mode: o.task.permissionMode,
    candidates: chain.map((id) => agentInfo(id)),
    needHardBudget: s.auth.mode === 'apiKey' && o.project.monthlyBudgetUsd != null,
    now: o.now ?? Date.now(),
  })
}

/** Lý do agent không dùng được với mức quyền (tiếng Việt, cho lỗi 400 và lý do task Failed); undefined = được. */
export function agentProblem(id: AgentId, mode: PermissionMode): string | undefined {
  const a = adapters[id]
  const name = a?.name ?? AGENT_NAMES[id]
  const problem = agentModeProblem(a && { supported: true, permissionModes: [...a.capabilities.permissionModes] }, mode)
  if (!a || problem === 'unsupported') return `Task Board chưa hỗ trợ chạy task bằng ${name}.`
  if (problem === 'mode') return `${name} không hỗ trợ mức quyền "${mode}".`
  return undefined
}
