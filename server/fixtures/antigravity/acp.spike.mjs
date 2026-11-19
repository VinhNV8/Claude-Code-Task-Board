// Spike M0 (Antigravity): `agy acp` (Agent Client Protocol, JSON-RPC 2.0 qua stdio), duyệt quyền, resume.
// node spike.mjs <agy.exe> <workdir> <outdir> <scenario> [sessionId]
// Env: SPIKE_DECISION_SHELL=allow|reject (mặc định reject), SPIKE_DECISION_EDIT=allow|reject (mặc định allow),
//      SPIKE_PROMPT, SPIKE_MODE (id mode muốn đặt), SPIKE_MODEL
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'

const [bin, workdir, outdir, scenario, resumeId] = process.argv.slice(2)
mkdirSync(outdir, { recursive: true })
const log = createWriteStream(join(outdir, `scenario-${scenario}.jsonl`))
const t0 = Date.now()
const rec = (dir, msg) => log.write(JSON.stringify({ t: Date.now() - t0, dir, msg }) + '\n')

const child = spawn(bin, ['acp', ...(process.env.SPIKE_ARGS ? JSON.parse(process.env.SPIKE_ARGS) : [])], { cwd: workdir, windowsHide: true, env: { ...process.env, ANTHROPIC_API_KEY: '' } })
let stderr = ''
child.stderr.on('data', (d) => (stderr += d))
let nextId = 1
const pending = new Map()
const send = (msg) => { msg = { jsonrpc: '2.0', ...msg }; rec('out', msg); child.stdin.write(JSON.stringify(msg) + '\n') }
const request = (method, params) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); send({ id, method, params }) })

const summary = { scenario, permissions: [], updates: {}, toolCalls: [], text: '', errors: [] }

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { rec('in-raw', line); return }
  rec('in', msg)
  if (msg.id !== undefined && !msg.method) {
    const p = pending.get(msg.id); pending.delete(msg.id)
    msg.error ? p?.rej(msg.error) : p?.res(msg.result)
    return
  }
  if (msg.id !== undefined && msg.method) {
    const p = msg.params ?? {}
    if (msg.method === 'session/request_permission') {
      const tc = p.toolCall ?? {}
      const isEdit = tc.kind === 'edit' || /write|edit|patch|file/i.test(`${tc.kind} ${tc.title}`)
      const want = isEdit ? (process.env.SPIKE_DECISION_EDIT || 'allow') : (process.env.SPIKE_DECISION_SHELL || 'reject')
      const opt = (p.options ?? []).find((o) => o.kind === (want === 'allow' ? 'allow_once' : 'reject_once')) ?? (p.options ?? []).find((o) => o.kind?.startsWith(want))
      summary.permissions.push({ title: tc.title, kind: tc.kind, rawInput: tc.rawInput, options: (p.options ?? []).map((o) => `${o.optionId}:${o.kind}`), chose: opt?.optionId })
      send({ id: msg.id, result: opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } } })
      return
    }
    summary.errors.push({ unhandledRequest: msg.method })
    send({ id: msg.id, error: { code: -32601, message: 'not supported by spike' } })
    return
  }
  if (msg.method === 'session/update') {
    const u = msg.params?.update ?? {}
    const k = u.sessionUpdate
    summary.updates[k] = (summary.updates[k] ?? 0) + 1
    if (k === 'agent_message_chunk' && u.content?.type === 'text') summary.text += u.content.text
    if (k === 'tool_call') summary.toolCalls.push({ id: u.toolCallId, title: u.title, kind: u.kind, status: u.status })
    if (k === 'tool_call_update') { const t = summary.toolCalls.find((x) => x.id === u.toolCallId); if (t && u.status) t.status = u.status }
    if (!['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(k)) summary[`last_${k}`] = u
  }
})

const timer = setTimeout(() => { summary.errors.push('TIMEOUT 240s'); finish() }, 240_000)
let done = false
function finish() {
  if (done) return; done = true
  clearTimeout(timer)
  summary.elapsedMs = Date.now() - t0
  summary.stderrTail = stderr.split('\n').slice(-8).join('\n')
  console.log(JSON.stringify(summary, null, 2))
  child.stdin.end(); child.kill(); log.end()
  setTimeout(() => process.exit(0), 500)
}

try {
  summary.initialize = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'taskboard-spike', version: '0.0.1' },
  })
  const sess = resumeId
    ? await request('session/load', { sessionId: resumeId, cwd: workdir, mcpServers: [] }).then((r) => ({ ...r, sessionId: resumeId }))
    : await request('session/new', { cwd: workdir, mcpServers: [] })
  summary.session = { id: sess.sessionId, modes: sess.modes, models: sess.models && { current: sess.models.currentModelId, available: sess.models.availableModels?.map((m) => m.modelId) } }
  if (process.env.SPIKE_MODE) summary.setMode = await request('session/set_mode', { sessionId: sess.sessionId, modeId: process.env.SPIKE_MODE }).catch((e) => ({ error: e }))
  if (process.env.SPIKE_MODEL) summary.setModel = await request('session/set_model', { sessionId: sess.sessionId, modelId: process.env.SPIKE_MODEL }).catch((e) => ({ error: e }))
  const text = process.env.SPIKE_PROMPT || 'Step 1: run exactly this shell command: `echo taskboard-gate-check` and tell me whether it ran. Step 2: create a file named hello.txt containing the single word hi. Do nothing else. Answer in one short sentence.'
  summary.promptResult = await request('session/prompt', { sessionId: sess.sessionId, prompt: [{ type: 'text', text }] })
} catch (e) {
  summary.errors.push({ fatal: e?.message ?? JSON.stringify(e) })
}
finish()
