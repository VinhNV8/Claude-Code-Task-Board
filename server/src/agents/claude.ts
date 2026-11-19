// Adapter Claude Code CLI: chuyển nguyên phần riêng của Claude từ runner sang (SPEC-MULTI-AGENT M1, không đổi hành vi).
import { claudeEnv, findClaudeBin } from '../claude.ts'
import { nodeCommand } from '../runtime.ts'
import { issueKeyToken } from '../apiKeyBroker.ts'
import { DATA_DIR, claudeApiKey, settings } from '../db.ts'
import { authFailureHint, resolveCredentials } from '../claudeAuth.ts'
import { StreamParser, type ResultInfo } from '../stream.ts'
import { INTERNAL_TOKEN, PORT } from '../config.ts'
import { buildClaudeArgs, permissionToolEnabled, removeMcpConfig, writeMcpConfig } from '../permissionTool.ts'
import { removeHookSettings, writeHookSettings } from '../hookSettings.ts'
import { detectRateLimit } from '../rateLimit.ts'
import { buildClaudeLimit, clearClaudeLimit, setClaudeLimit } from '../claudeLimit.ts'
import { fallbackModelFor } from '../model.ts'
import { runBudgetCap } from '../budgetService.ts'
import { BLOCKED_BY_INSTRUCTION } from '../../../web/src/lib/deps.ts'
import type { AgentAdapter, PreparedRun, RunInput } from './types.ts'

/** Xoá các file cấu hình tạm của một run (MCP config, settings hooks). */
function removeTempFiles(f: { mcpConfig?: string; hookSettings?: string }) {
  removeMcpConfig(f.mcpConfig)
  removeHookSettings(f.hookSettings)
}

/** CLI báo không tìm thấy phiên khi chạy `--resume <sessionId>` (file phiên đã mất hoặc chưa từng được lưu). */
export function isMissingSession(o: { result?: Pick<ResultInfo, 'text' | 'isError'>; stderr?: string }) {
  const re = /no conversation found/i
  return re.test(o.stderr ?? '') || (!!o.result?.isError && re.test(o.result.text ?? ''))
}

function prepare(o: RunInput): PreparedRun {
  const { task, project, sessionId, resume, runLogDir } = o

  // Xác thực: chế độ API key mà chưa có key thì dừng, không lặng lẽ chạy bằng gói đăng nhập.
  const auth = settings.get().auth
  const creds = resolveCredentials(auth.mode, auth.mode === 'apiKey' ? claudeApiKey.effective() : undefined)
  if (!creds.ok) return { ok: false, error: creds.reason }
  // Chế độ API key: trần chi phí của run gồm cả phần budget tháng còn lại của project (giới hạn cứng).
  const maxBudgetUsd = runBudgetCap(project.id, task.maxCostUsd)
  if (maxBudgetUsd === 0) return { ok: false, error: 'Project đã dùng hết budget tháng (chế độ API key: budget là giới hạn cứng).' }

  // P3 (PLAN 3.2): file MCP config tạm cho permission prompt tool; tắt bằng TASKBOARD_PERMISSION_TOOL=off.
  let mcpConfig: string | undefined
  if (permissionToolEnabled()) {
    try {
      mcpConfig = writeMcpConfig(runLogDir, o.runId, {
        taskId: task.id,
        port: PORT,
        token: INTERNAL_TOKEN,
        // Dài hơn hạn của backend (permissionTimeoutMin) để backend luôn là nơi quyết định timeout;
        // tối thiểu 24 giờ để việc tăng permissionTimeoutMin giữa chừng không bị MCP cắt sớm.
        timeoutMs: Math.max(settings.get().permissionTimeoutMin * 60_000 + 5 * 60_000, 24 * 60 * 60_000),
      })
    } catch (err) {
      return { ok: false, error: `Không ghi được cấu hình MCP xin quyền: ${(err as Error).message}` }
    }
  }
  // P3 (PLAN 3.6): file settings tạm khai báo hook Notification gọi về /api/hooks/notification.
  let hookSettings: string | undefined
  try {
    hookSettings = writeHookSettings(runLogDir, o.runId, {
      taskId: task.id,
      port: PORT,
      token: INTERNAL_TOKEN,
      nodePath: nodeCommand(DATA_DIR),
      // Chế độ API key: CLI lấy key qua apiKeyHelper, key không nằm trong môi trường mà lệnh Bash thừa hưởng
      apiKeyToken: creds.apiKey ? issueKeyToken(task.id) : undefined,
    })
  } catch (err) {
    removeTempFiles({ mcpConfig })
    return { ok: false, error: `Không ghi được cấu hình hook: ${(err as Error).message}` }
  }
  const args = buildClaudeArgs({
    sessionId,
    resume,
    permissionMode: task.permissionMode,
    allowedTools: project.allowedTools,
    mcpConfigPath: mcpConfig,
    settingsPath: hookSettings,
    model: o.model,
    fallbackModel: fallbackModelFor(o.model),
    maxBudgetUsd,
    appendSystemPrompt: BLOCKED_BY_INSTRUCTION,
  })
  return {
    ok: true,
    args,
    env: claudeEnv({ TASKBOARD_TASK_ID: String(task.id) }),
    // Prompt qua stdin để tránh lỗi quote trên Windows (P0-SPIKE S4)
    stdin: o.prompt,
    cleanup: () => removeTempFiles({ mcpConfig, hookSettings }),
  }
}

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  name: 'Claude',
  label: 'Claude Code',
  capabilities: {
    interactivePermission: true,
    askUser: true,
    resume: true,
    costUsd: true,
    hardBudget: true,
    permissionModes: ['manual', 'acceptEdits', 'auto', 'plan'],
  },
  findBin: (refresh) => findClaudeBin(refresh),
  missingBinReason:
    'Không tìm thấy Claude Code CLI. Cả chế độ đăng nhập lẫn API key đều chạy task bằng CLI: cài extension Claude Code (có sẵn CLI), hoặc chỉ định đường dẫn (cài đặt agentTaskBoard.claudePath của extension, hoặc biến môi trường CLAUDE_BIN).',
  prepare,
  createParser: (cwd) => new StreamParser(cwd),
  isMissingSession,
  detectRateLimit: (o) => detectRateLimit(o),
  // Claude đã chạy được: gói có lượt lại, bỏ banner hết lượt.
  onSuccess: () => clearClaudeLimit(),
  onRateLimit(hit, o) {
    // Banner "gói Claude hết lượt" trên mọi trang của web
    const text = (o.result?.isError ? o.result.text : undefined) ?? o.stderr
    setClaudeLimit(buildClaudeLimit({ hit, event: o.rateLimitEvent, text }))
  },
  // Chế độ API key: thêm gợi ý cho lỗi key sai / hết credit.
  failureHint: (o) =>
    settings.get().auth.mode === 'apiKey' ? authFailureHint(`${o.result?.text ?? ''} ${o.stderr ?? ''}`) : undefined,
}
