import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  buildClaudeArgs,
  buildMcpConfig,
  cleanupMcpConfigs,
  effectivePermissionMode,
  mcpConfigPath,
  PERMISSION_PROMPT_TOOL,
  PERMISSION_SCRIPT,
  permissionToolEnabled,
  removeMcpConfig,
  writeMcpConfig,
} from './permissionTool.ts'

const base = { sessionId: 's1', resume: false, permissionMode: 'acceptEdits', allowedTools: [] as string[] }

test('permissionToolEnabled: bật mặc định, tắt bằng TASKBOARD_PERMISSION_TOOL', () => {
  assert.equal(permissionToolEnabled({}), true)
  assert.equal(permissionToolEnabled({ TASKBOARD_PERMISSION_TOOL: 'on' }), true)
  for (const v of ['off', 'OFF', ' 0 ', 'false', 'no', 'disabled']) assert.equal(permissionToolEnabled({ TASKBOARD_PERMISSION_TOOL: v }), false, v)
})

test('buildMcpConfig: server taskboard, đường dẫn tuyệt đối, env đủ task/port/token', () => {
  const cfg = buildMcpConfig({ taskId: 12, port: 3001, token: 'tok', timeoutMs: 1500.4 })
  const s = cfg.mcpServers.taskboard
  assert.equal(s.type, 'stdio')
  assert.equal(s.command, process.execPath)
  assert.equal(s.args[0], '--import')
  assert.match(s.args[1], /^file:\/\//) // loader tsx dạng URL tuyệt đối, không phụ thuộc cwd
  assert.equal(s.args[2], PERMISSION_SCRIPT)
  assert.ok(isAbsolute(PERMISSION_SCRIPT) && existsSync(PERMISSION_SCRIPT))
  assert.deepEqual(s.env, {
    TASKBOARD_TASK_ID: '12',
    TASKBOARD_PORT: '3001',
    TASKBOARD_TOKEN: 'tok',
    TASKBOARD_PERMISSION_TIMEOUT_MS: '1500',
  })
  assert.equal('TASKBOARD_PERMISSION_TIMEOUT_MS' in buildMcpConfig({ taskId: 1, port: 1, token: 't' }).mcpServers.taskboard.env, false)
})

test('writeMcpConfig / removeMcpConfig / cleanupMcpConfigs: ghi data/runs/<runId>.mcp.json và dọn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-mcp-'))
  try {
    const file = writeMcpConfig(dir, 'run-a', { taskId: 3, port: 3001, token: 't' })
    assert.equal(file, mcpConfigPath(dir, 'run-a'))
    assert.ok(file.endsWith('run-a.mcp.json'))
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).mcpServers.taskboard.env.TASKBOARD_TASK_ID, '3')
    removeMcpConfig(file)
    assert.equal(existsSync(file), false)
    removeMcpConfig(file) // xoá lần hai không lỗi
    removeMcpConfig(undefined)

    writeMcpConfig(dir, 'run-b', { taskId: 1, port: 1, token: 't' })
    writeMcpConfig(dir, 'run-c', { taskId: 1, port: 1, token: 't' })
    writeFileSync(join(dir, 'run-b.jsonl'), '')
    assert.equal(cleanupMcpConfigs(dir), 2)
    assert.equal(existsSync(join(dir, 'run-b.jsonl')), true) // log run không bị xoá
    assert.equal(cleanupMcpConfigs(join(dir, 'khong-co')), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildClaudeArgs: có MCP config → prompt tool, không có --permission-prompts none', () => {
  const args = buildClaudeArgs({ ...base, permissionMode: 'manual', mcpConfigPath: 'C:\\Data Dir\\runs\\r.mcp.json', allowedTools: ['Bash(git *)'] })
  const i = args.indexOf('--mcp-config')
  assert.equal(args[i + 1], 'C:\\Data Dir\\runs\\r.mcp.json') // đường dẫn có dấu cách là một phần tử
  assert.equal(args[i + 2], '--permission-prompt-tool')
  assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], PERMISSION_PROMPT_TOOL)
  assert.equal(PERMISSION_PROMPT_TOOL, 'mcp__taskboard__approve')
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'host')
  assert.equal(args.includes('none'), false)
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'manual') // có người duyệt nên giữ manual
  assert.deepEqual(args.slice(-2), ['--allowedTools', 'Bash(git *)'])
})

test('buildClaudeArgs: dự phòng (không MCP) → --permission-prompts none + acceptEdits + whitelist', () => {
  const args = buildClaudeArgs({ ...base, permissionMode: 'manual', allowedTools: ['Read', 'Bash(npm test)'] })
  assert.equal(args.includes('--mcp-config'), false)
  assert.equal(args.includes('--permission-prompt-tool'), false)
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none')
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits')
  assert.deepEqual(args.slice(-3), ['--allowedTools', 'Read', 'Bash(npm test)'])
})

test('buildClaudeArgs: resume dùng --resume, phiên mới dùng --session-id', () => {
  assert.deepEqual(buildClaudeArgs({ ...base, resume: true }).slice(4, 6), ['--resume', 's1'])
  assert.deepEqual(buildClaudeArgs(base).slice(4, 6), ['--session-id', 's1'])
})

// P5-03: --model
test('buildClaudeArgs: không có model → không truyền --model / --fallback-model (giữ hành vi cũ)', () => {
  const args = buildClaudeArgs({ ...base, allowedTools: ['Read'] })
  assert.ok(!args.includes('--model'))
  assert.ok(!args.includes('--fallback-model'))
})

test('buildClaudeArgs: có model → --model trước --allowedTools, --allowedTools vẫn nằm cuối', () => {
  const args = buildClaudeArgs({
    ...base,
    model: 'haiku',
    mcpConfigPath: 'C:\\x\\r.mcp.json',
    settingsPath: 'C:\\x\\s.json',
    allowedTools: ['Read', 'Bash(git *)'],
  })
  const i = args.indexOf('--model')
  assert.equal(args[i + 1], 'haiku')
  assert.ok(!args.includes('--fallback-model'))
  assert.ok(i < args.indexOf('--allowedTools'))
  assert.deepEqual(args.slice(-3), ['--allowedTools', 'Read', 'Bash(git *)'])
})

test('buildClaudeArgs: opus kèm --fallback-model sonnet; fallback trùng model chính thì bỏ', () => {
  const args = buildClaudeArgs({ ...base, model: 'opus', fallbackModel: 'sonnet', allowedTools: ['Read'] })
  const i = args.indexOf('--model')
  assert.deepEqual(args.slice(i, i + 4), ['--model', 'opus', '--fallback-model', 'sonnet'])
  assert.deepEqual(args.slice(-2), ['--allowedTools', 'Read'])
  assert.ok(!buildClaudeArgs({ ...base, model: 'sonnet', fallbackModel: 'sonnet' }).includes('--fallback-model'))
  // Không có model thì fallback cũng không truyền
  assert.ok(!buildClaudeArgs({ ...base, fallbackModel: 'sonnet' }).includes('--fallback-model'))
})

test('effectivePermissionMode: chỉ đổi manual khi không có prompt tool', () => {
  assert.equal(effectivePermissionMode('manual', false), 'acceptEdits')
  assert.equal(effectivePermissionMode('manual', true), 'manual')
  assert.equal(effectivePermissionMode('plan', false), 'plan')
  assert.equal(effectivePermissionMode('acceptEdits', false), 'acceptEdits')
})
