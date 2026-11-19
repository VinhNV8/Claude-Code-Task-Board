// Spike M0 (Codex): app-server qua stdio, duyệt quyền, resume.
// node spike.mjs <codex.exe> <workdir> <outdir> <A|B> [threadId]
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'

const [bin, workdir, outdir, scenario, resumeId] = process.argv.slice(2)
mkdirSync(outdir, { recursive: true })
const log = createWriteStream(join(outdir, `scenario-${scenario}.jsonl`))
const t0 = Date.now()
const rec = (dir, msg) => log.write(JSON.stringify({ t: Date.now() - t0, dir, msg }) + '\n')

const child = spawn(bin, ['app-server'], { cwd: workdir, windowsHide: true, env: { ...process.env, ANTHROPIC_API_KEY: '' } })
let stderr = ''
child.stderr.on('data', (d) => (stderr += d))
let nextId = 1
const pending = new Map()
const send = (msg) => { rec('out', msg); child.stdin.write(JSON.stringify(msg) + '\n') }
const request = (method, params) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); send({ id, method, params }) })

const summary = { scenario, approvals: [], items: [], turn: null, tokenUsage: null, errors: [], rateLimits: null }
let turnDone
const turnFinished = new Promise((r) => (turnDone = r))

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { rec('in-raw', line); return }
  rec('in', msg)
  if (msg.id !== undefined && !msg.method) { // response
    const p = pending.get(msg.id); pending.delete(msg.id)
    msg.error ? p?.rej(msg.error) : p?.res(msg.result)
    return
  }
  if (msg.id !== undefined && msg.method) { // server request
    const p = msg.params ?? {}
    let result
    if (msg.method === 'item/commandExecution/requestApproval') {
      const decision = scenario === 'A' ? 'decline' : 'accept'
      summary.approvals.push({ method: msg.method, kind: p.kind, command: p.command, cwd: p.cwd, reason: p.reason, decision })
      result = { decision }
    } else if (msg.method === 'item/fileChange/requestApproval') {
      summary.approvals.push({ method: msg.method, reason: p.reason, grantRoot: p.grantRoot, decision: 'accept' })
      result = { decision: 'accept' }
    } else {
      summary.approvals.push({ method: msg.method, params: p, decision: 'unhandled→error' })
      send({ id: msg.id, error: { code: -32601, message: 'not supported by spike' } })
      return
    }
    send({ id: msg.id, result })
    return
  }
  // notification
  const p = msg.params ?? {}
  if (msg.method === 'item/completed') summary.items.push({ type: p.item?.type, text: p.item?.text?.slice?.(0, 300), command: p.item?.command, status: p.item?.status, changes: p.item?.changes?.map?.((c) => c.path) })
  if (msg.method === 'thread/tokenUsage/updated') summary.tokenUsage = p.tokenUsage
  if (msg.method === 'account/rateLimits/updated') summary.rateLimits = p
  if (msg.method === 'error') summary.errors.push(p)
  if (msg.method === 'turn/completed') { summary.turn = { status: p.turn?.status, error: p.turn?.error, durationMs: p.turn?.durationMs }; turnDone() }
})

const timer = setTimeout(() => { summary.errors.push('TIMEOUT 240s'); turnDone() }, 240_000)
try {
  summary.initialize = await request('initialize', { clientInfo: { name: 'taskboard-spike', title: null, version: '0.0.1' }, capabilities: { experimentalApi: false, requestAttestation: false } })
  send({ method: 'initialized' })
  const ml = await request('model/list', {})
  const models = ml.data ?? ml.models ?? ml.items ?? []
  summary.models = models.map((m) => ({ id: m.id ?? m.model ?? m.slug, isDefault: m.isDefault, displayName: m.displayName }))
  const model = process.env.SPIKE_MODEL || (models.find((m) => m.isDefault) ?? models[0])?.id || (models[0]?.model)
  const common = { cwd: workdir, model, approvalPolicy: process.env.SPIKE_POLICY || 'untrusted', sandbox: process.env.SPIKE_SANDBOX || 'workspace-write', developerInstructions: 'SPIKE: follow the user exactly.' }
  const th = scenario === 'B'
    ? await request('thread/resume', { threadId: resumeId, ...common, excludeTurns: true })
    : await request('thread/start', common)
  summary.thread = { id: th.thread?.id, model: th.model, approvalPolicy: th.approvalPolicy, sandbox: th.sandbox }
  const text = process.env.SPIKE_PROMPT ? process.env.SPIKE_PROMPT : scenario === 'A'
    ? 'Step 1: run exactly this shell command: `echo taskboard-gate-check` and tell me whether it ran. Step 2: create a file named hello.txt containing the single word hi. Do nothing else. Answer in one short sentence.'
    : 'Without running any command: what was the name of the file you created earlier in this conversation, and was the echo command allowed? Answer in one short sentence.'
  summary.turnStart = await request('turn/start', { threadId: th.thread.id, input: [{ type: 'text', text, text_elements: [] }] })
  await turnFinished
} catch (e) {
  summary.errors.push({ fatal: String(e?.message ?? JSON.stringify(e)) })
}
clearTimeout(timer)
summary.elapsedMs = Date.now() - t0
summary.stderrTail = stderr.split('\n').slice(-8).join('\n')
console.log(JSON.stringify(summary, null, 2))
child.stdin.end(); child.kill(); log.end()
setTimeout(() => process.exit(0), 500)
