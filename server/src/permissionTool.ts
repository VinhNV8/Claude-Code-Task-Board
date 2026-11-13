// Nối MCP permission server vào lệnh Claude CLI (PLAN 3.2).
// Mỗi run ghi một file MCP config tạm `data/runs/<runId>.mcp.json` khai báo server `taskboard`,
// rồi chạy Claude với `--mcp-config <file> --permission-prompt-tool mcp__taskboard__approve`.
//
// Phương án dự phòng (PLAN, rủi ro P3): đặt TASKBOARD_PERMISSION_TOOL=off để tắt prompt tool,
// quay về chế độ P1: `--permission-prompts none` + whitelist `--allowedTools`
// (lệnh ngoài whitelist bị từ chối và ghi vào permission_denials).
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MCP_SERVER_NAME = 'taskboard'
export const PERMISSION_PROMPT_TOOL = `mcp__${MCP_SERVER_NAME}__approve`
export const MCP_CONFIG_SUFFIX = '.mcp.json'

/** Prompt tool bật mặc định; tắt bằng TASKBOARD_PERMISSION_TOOL=off|0|false|no. */
export function permissionToolEnabled(env: NodeJS.ProcessEnv = process.env) {
  const v = env.TASKBOARD_PERMISSION_TOOL?.trim().toLowerCase()
  return !(v && ['off', '0', 'false', 'no', 'disabled'].includes(v))
}

export interface McpServerOptions {
  taskId: number
  port: number
  token: string
  /**
   * Hạn chờ phía MCP server (TASKBOARD_PERMISSION_TIMEOUT_MS). Backend tự từ chối theo permissionTimeoutMin,
   * nên giá trị này chỉ là lưới an toàn và phải dài hơn hạn của backend.
   */
  timeoutMs?: number
  /** File thực thi node (mặc định process.execPath). */
  nodePath?: string
  /** URL file của loader tsx (mặc định resolve từ node_modules của server). */
  tsxLoader?: string
  /** Đường dẫn tuyệt đối tới server/src/mcp/permission.ts. */
  scriptPath?: string
}

export const PERMISSION_SCRIPT = join(import.meta.dirname, 'mcp', 'permission.ts')

/**
 * Loader tsx dạng file URL tuyệt đối: Claude chạy MCP server với cwd là repo của project
 * (không có tsx), nên không thể dùng `--import tsx` dạng tên gói.
 */
export function resolveTsxLoader() {
  return import.meta.resolve('tsx')
}

/** Nội dung file cấu hình MCP (định dạng `--mcp-config`). Mọi đường dẫn đều tuyệt đối, đi qua mảng args. */
export function buildMcpConfig(o: McpServerOptions) {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        command: o.nodePath ?? process.execPath,
        args: ['--import', o.tsxLoader ?? resolveTsxLoader(), o.scriptPath ?? PERMISSION_SCRIPT],
        env: {
          TASKBOARD_TASK_ID: String(o.taskId),
          TASKBOARD_PORT: String(o.port),
          TASKBOARD_TOKEN: o.token,
          ...(o.timeoutMs ? { TASKBOARD_PERMISSION_TIMEOUT_MS: String(Math.round(o.timeoutMs)) } : {}),
        },
      },
    },
  }
}

export const mcpConfigPath = (dir: string, runId: string) => join(dir, `${runId}${MCP_CONFIG_SUFFIX}`)

export function writeMcpConfig(dir: string, runId: string, o: McpServerOptions) {
  const file = mcpConfigPath(dir, runId)
  writeFileSync(file, JSON.stringify(buildMcpConfig(o), null, 2), { encoding: 'utf8', mode: 0o600 })
  return file
}

export function removeMcpConfig(file: string | undefined) {
  if (!file) return
  try {
    rmSync(file, { force: true })
  } catch {
    /* file đang bị khóa hoặc đã xóa: bỏ qua, lần khởi động sau sẽ dọn */
  }
}

/** Dọn file MCP config còn sót (server tắt đột ngột khi task đang chạy). */
export function cleanupMcpConfigs(dir: string) {
  let n = 0
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(MCP_CONFIG_SUFFIX)) continue
      removeMcpConfig(join(dir, f))
      n++
    }
  } catch {
    /* thư mục chưa tồn tại */
  }
  return n
}

export interface ClaudeArgsOptions {
  sessionId: string
  resume: boolean
  permissionMode: string
  allowedTools: string[]
  /** Có file MCP config → dùng permission prompt tool; không có → phương án dự phòng. */
  mcpConfigPath?: string
  /** File settings tạm chứa hooks (PLAN 3.6). */
  settingsPath?: string
  /** Giá trị `--model` (alias hoặc ID, PLAN P5 D1). Không có: dùng mặc định của CLI. */
  model?: string
  /** Model dự phòng khi model chính quá tải (`--fallback-model`). */
  fallbackModel?: string
  /** Giới hạn chi phí của lần chạy (`--max-budget-usd`, P6). */
  maxBudgetUsd?: number
  /** Nối thêm vào system prompt (`--append-system-prompt`), dùng cho quy ước BLOCKED_BY (FR-08). */
  appendSystemPrompt?: string
}

/**
 * Mode quyền thực tế truyền cho CLI. Dự phòng (không có prompt tool): `manual` sẽ bị từ chối cả việc sửa file,
 * nên quay về `acceptEdits` + whitelist như PLAN (rủi ro P3). `plan` giữ nguyên vì không sửa gì.
 */
export function effectivePermissionMode(mode: string, promptTool: boolean) {
  return !promptTool && mode === 'manual' ? 'acceptEdits' : mode
}

export function buildClaudeArgs(o: ClaudeArgsOptions) {
  const promptTool = !!o.mcpConfigPath
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    ...(o.resume ? ['--resume', o.sessionId] : ['--session-id', o.sessionId]),
    '--permission-mode', effectivePermissionMode(o.permissionMode, promptTool),
  ]
  if (o.mcpConfigPath) {
    // P3: lệnh ngoài whitelist được hỏi qua MCP tool, task chuyển Needs Input chờ duyệt trên web.
    // `--mcp-config` nhận nhiều giá trị: flag ngay sau nó kết thúc danh sách.
    args.push(
      '--mcp-config', o.mcpConfigPath,
      '--permission-prompt-tool', PERMISSION_PROMPT_TOOL,
      '--permission-prompts', 'host',
    )
  } else {
    // Dự phòng: không ai trả lời prompt quyền → bị từ chối và ghi vào permission_denials.
    args.push('--permission-prompts', 'none')
  }
  if (o.settingsPath) args.push('--settings', o.settingsPath)
  if (o.model) {
    args.push('--model', o.model)
    // CLI từ chối fallback trùng model chính
    if (o.fallbackModel && o.fallbackModel !== o.model) args.push('--fallback-model', o.fallbackModel)
  }
  if (o.maxBudgetUsd !== undefined && o.maxBudgetUsd > 0) args.push('--max-budget-usd', String(o.maxBudgetUsd))
  // FR-08 (R6): quy ước BLOCKED_BY. Một dòng, không có dấu nháy kép, để an toàn khi truyền tham số trên Windows.
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt)
  // --allowedTools nhận nhiều giá trị nên để cuối, tránh nuốt các flag phía sau.
  if (o.allowedTools.length) args.push('--allowedTools', ...o.allowedTools)
  return args
}
