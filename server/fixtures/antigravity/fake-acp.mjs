// `agy acp` giả cho test (server/src/agents/antigravity.test.ts): JSON-RPC 2.0, mỗi dòng một JSON, đúng hành vi đã thấy ở
// P0-SPIKE (Antigravity G2–G10): request_permission với toolCall { title, kind, rawInput }, options allow_once/reject_once;
// bị từ chối là kết thúc lượt ngay (end_turn, không nói gì). Kịch bản chọn bằng FAKE_AGY:
//   ok    : xin chạy `npm install` → nếu được thì xin ghi hello.txt → end_turn
//   quota : session/prompt trả lỗi RESOURCE_EXHAUSTED
// session/load chỉ nhận `sess-1`. Prompt nối tiếp (gửi lý do từ chối) được trả lời bằng "followup: <đoạn đầu prompt>".
import readline from 'node:readline'

const scenario = process.env.FAKE_AGY || 'ok'
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
const S = 'sess-1'
const update = (u) => send({ method: 'session/update', params: { sessionId: S, update: u } })
let reqId = 500
const waiting = new Map()
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = reqId++
    waiting.set(id, resolve)
    send({ id, method, params })
  })
const say = (text) => {
  // gửi thành nhiều mảnh như agy
  for (const part of text.match(/.{1,8}/gs) ?? []) update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } })
}
const options = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
]
let prompts = 0

async function onPrompt(id, text) {
  prompts++
  if (scenario === 'quota') return send({ id, error: { code: 429, message: 'RESOURCE_EXHAUSTED: quota exceeded for model' } })
  if (prompts > 1) {
    say(`followup: ${text.slice(0, 60)}`)
    return send({ id, result: { stopReason: 'end_turn', usage: { totalTokens: 10 } } })
  }
  // Bước 1: lệnh shell
  update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'npm install', kind: 'execute', status: 'pending', rawInput: { CommandLine: 'npm install', toolSummary: 'Cài gói' } })
  const r1 = await ask('session/request_permission', { sessionId: S, toolCall: { toolCallId: 'c1', title: 'npm install', kind: 'execute', rawInput: { CommandLine: 'npm install', toolSummary: 'Cài gói' } }, options })
  if (r1?.outcome?.optionId !== 'allow') {
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed' })
    return send({ id, result: { stopReason: 'end_turn', usage: { totalTokens: 20 } } })
  }
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'added 1 package' } }] })
  // Bước 2: ghi file
  const file = `${process.cwd()}${process.platform === 'win32' ? '\\' : '/'}hello.txt`
  update({ sessionUpdate: 'tool_call', toolCallId: 'e1', title: 'File hello.txt', kind: 'edit', status: 'pending', rawInput: { Path: file, Content: 'hi' } })
  const r2 = await ask('session/request_permission', { sessionId: S, toolCall: { toolCallId: 'e1', title: 'File hello.txt', kind: 'edit', rawInput: { Path: file, Content: 'hi' } }, options })
  if (r2?.outcome?.optionId !== 'allow') {
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'failed' })
    return send({ id, result: { stopReason: 'end_turn', usage: { totalTokens: 30 } } })
  }
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'completed' })
  update({ sessionUpdate: 'usage_update', used: 4321, size: 1048576 })
  say(`done | ${text.slice(-40)}`)
  send({ id, result: { stopReason: 'end_turn', usage: { totalTokens: 40 } } })
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method) process.stderr.write(`RECV ${m.method} ${JSON.stringify(m.params ?? {})}\n`)
  if (m.id !== undefined && !m.method) {
    const w = waiting.get(m.id)
    waiting.delete(m.id)
    w?.(m.result)
    return
  }
  switch (m.method) {
    case 'initialize':
      return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'Fake ACP', version: '0' } } })
    case 'session/new':
      return send({ id: m.id, result: { sessionId: S, models: { currentModelId: 'gemini-fake', availableModels: [{ modelId: 'gemini-fake' }, { modelId: 'gemini-fake-pro' }] } } })
    case 'session/load':
      if (m.params.sessionId !== S) return send({ id: m.id, error: { code: -32602, message: `session not found: ${m.params.sessionId}` } })
      return send({ id: m.id, result: { models: { currentModelId: 'gemini-fake', availableModels: [{ modelId: 'gemini-fake' }] } } })
    case 'session/set_model':
      return send({ id: m.id, result: {} })
    case 'session/prompt':
      return void onPrompt(m.id, m.params.prompt?.[0]?.text ?? '')
    default:
      return send({ id: m.id, error: { code: -32601, message: 'unknown' } })
  }
})
