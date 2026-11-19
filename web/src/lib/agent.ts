// Chọn agent chạy task (SPEC-MULTI-AGENT FR-91): Task → Project → Settings, lấy giá trị đầu tiên khác rỗng.
// Dùng chung cho web (hiển thị "kế thừa…") và server (runner, kiểm tra dữ liệu).
import type { AgentId, AgentInfo, FailoverSettings, PermissionMode, Project, RunKind, Settings, Task } from '../types.ts'

export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'antigravity', 'cursor']
export const DEFAULT_AGENT: AgentId = 'claude'

/** Tên hiển thị khi chưa có danh sách từ server (GET /api/agents). */
export const AGENT_NAMES: Record<AgentId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
}

export const isAgentId = (v: unknown): v is AgentId => typeof v === 'string' && (AGENT_IDS as readonly string[]).includes(v)

/** Giá trị gửi lên: '' / null = kế thừa (undefined); giá trị lạ → null (báo lỗi ở tầng gọi). */
export function parseAgent(v: unknown): AgentId | undefined | null {
  if (v === undefined || v === null || v === '') return undefined
  return isAgentId(v) ? v : null
}

export function resolveAgent(
  task: Pick<Task, 'agent'> | undefined,
  project: Pick<Project, 'defaultAgent'> | undefined,
  settings: Pick<Settings, 'defaultAgent'> | undefined,
): AgentId {
  return task?.agent ?? project?.defaultAgent ?? settings?.defaultAgent ?? DEFAULT_AGENT
}

/**
 * Agent chạy run này (FR-99, QA7): Request changes / Tiếp tục giữ agent dự phòng đang dùng (`activeAgent`);
 * lần chạy mới / Retry quay về agent theo cấu hình.
 */
export function agentForRun(
  task: Pick<Task, 'agent' | 'activeAgent'>,
  project: Pick<Project, 'defaultAgent'> | undefined,
  settings: Pick<Settings, 'defaultAgent'> | undefined,
  kind: RunKind,
): AgentId {
  if ((kind === 'resume' || kind === 'continue') && task.activeAgent) return task.activeAgent
  return resolveAgent(task, project, settings)
}

/** Agent hiển thị cho task: agent dự phòng đang dùng, không có thì agent theo cấu hình. */
export const effectiveAgent = (
  task: Pick<Task, 'agent' | 'activeAgent'>,
  project: Pick<Project, 'defaultAgent'> | undefined,
  settings: Pick<Settings, 'defaultAgent'> | undefined,
): AgentId => task.activeAgent ?? resolveAgent(task, project, settings)

export const DEFAULT_FAILOVER: FailoverSettings = { enabled: false, chain: ['claude', 'codex'] }

/**
 * Chuỗi dự phòng có hiệu lực cho project (QA6): `off` → undefined; `custom` → chuỗi của project;
 * `inherit` (mặc định) → chuỗi hệ thống nếu hệ thống bật failover.
 */
export function failoverChain(
  project: Pick<Project, 'failoverMode' | 'failoverChain'> | undefined,
  settings: Pick<Settings, 'failover'> | undefined,
): AgentId[] | undefined {
  const mode = project?.failoverMode ?? 'inherit'
  if (mode === 'off') return undefined
  if (mode === 'custom') return project?.failoverChain?.length ? project.failoverChain : undefined
  const f = settings?.failover
  return f?.enabled && f.chain.length ? f.chain : undefined
}

export interface FallbackCandidate {
  id: AgentId
  supported: boolean
  installed: boolean
  permissionModes: readonly PermissionMode[]
  /** CLI tự dừng khi vượt budget (chế độ API key). */
  hardBudget: boolean
  /** Đang hết hạn mức đến mốc này (epoch ms); không có = còn lượt. */
  limitedUntil?: number
}

/**
 * Agent dự phòng (SPEC-MULTI-AGENT 3.6a): agent đầu tiên trong chuỗi, khác agent hiện tại, đã hỗ trợ + đã cài,
 * không đang hết hạn mức, hỗ trợ mức quyền của task (không bao giờ hạ mức quyền), và có giới hạn chi phí cứng
 * nếu project đang dùng budget cứng. Không có → undefined (giữ hành vi cũ: chờ giờ reset).
 */
export function pickFallback(o: {
  current: AgentId
  chain: readonly AgentId[]
  mode: PermissionMode
  candidates: readonly FallbackCandidate[]
  needHardBudget: boolean
  now: number
}): AgentId | undefined {
  for (const id of o.chain) {
    if (id === o.current) continue
    const c = o.candidates.find((x) => x.id === id)
    if (!c || !c.supported || !c.installed) continue
    if (c.limitedUntil !== undefined && c.limitedUntil > o.now) continue
    if (!c.permissionModes.includes(o.mode)) continue
    if (o.needHardBudget && !c.hardBudget) continue
    return id
  }
  return undefined
}

/** Chuỗi agent gửi lên (Settings / Project): danh sách id hợp lệ, không trùng. null = không hợp lệ. */
export function parseChain(v: unknown): AgentId[] | null {
  if (!Array.isArray(v)) return null
  const out: AgentId[] = []
  for (const x of v) {
    if (!isAgentId(x)) return null
    if (!out.includes(x)) out.push(x)
  }
  return out
}

/** Tên agent cho run (run cũ chưa lưu agent = Claude). */
export const runAgent = (r: { agent?: AgentId }): AgentId => r.agent ?? DEFAULT_AGENT

/**
 * Agent có chạy được với mức quyền này không: undefined = được; 'unsupported' = Task Board chưa có adapter;
 * 'mode' = agent không hỗ trợ mức quyền. Không có thông tin agent (danh sách chưa tải): không chặn, server kiểm tra lại.
 */
export function agentModeProblem(
  info: Pick<AgentInfo, 'supported' | 'permissionModes'> | undefined,
  mode: PermissionMode,
): 'unsupported' | 'mode' | undefined {
  if (!info) return undefined
  if (!info.supported) return 'unsupported'
  if (!info.permissionModes.includes(mode)) return 'mode'
  return undefined
}
