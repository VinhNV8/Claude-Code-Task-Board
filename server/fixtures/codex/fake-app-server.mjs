// `codex app-server` giả cho test (server/src/agents/codex.test.ts): nói đúng giao thức đã ghi ở P0-SPIKE (Codex C2–C11),
// mỗi dòng một JSON qua stdio. Kịch bản chọn bằng biến môi trường FAKE_CODEX:
//   ok        : xin chạy `npm install` (bọc PowerShell như Codex trên Windows) → in kết quả theo quyết định, rồi xin sửa file
//   ratelimit : lượt chạy thất bại với codexErrorInfo usageLimitExceeded, kèm giờ reset
//   question  : hỏi lại người dùng (item/tool/requestUserInput) rồi trả lời theo đáp án
//   stall     : sửa file được duyệt nhưng không bao giờ xong (lỗi treo P0-SPIKE C6); turn/interrupt → interrupted;
//               turn/start lần sau trả lời 'recovered'
// thread/resume chỉ nhận thread `th-1`; thread khác trả lỗi JSON-RPC (mất phiên).
// Ghi mọi lệnh nhận được ra stderr dạng `RECV <method> <json params>` để test kiểm tra tham số.
import readline from 'node:readline'

const scenario = process.env.FAKE_CODEX || 'ok'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const notify = (method, params) => send({ method, params })
let serverReqId = 100
const waiting = new Map()
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = serverReqId++
    waiting.set(id, resolve)
    send({ id, method, params })
  })

const T = 'th-1'
const TURN = 'turn-1'
const item = (o) => ({ threadId: T, turnId: TURN, item: o })

let turns = 0
async function runTurn(text) {
  turns++
  if (scenario === 'stall' && turns > 1) {
    notify('item/completed', item({ type: 'agentMessage', id: 'm-r', text: `recovered: ${text.slice(0, 30)}`, phase: 'final_answer' }))
    notify('turn/completed', { threadId: T, turn: { id: TURN, status: 'completed', error: null } })
    return
  }
  if (scenario === 'stall') {
    const file = `${process.cwd()}/hello.txt`
    notify('item/started', item({ type: 'fileChange', id: 'f-s', status: 'inProgress', changes: [{ path: file, kind: { type: 'add' } }] }))
    await ask('item/fileChange/requestApproval', { threadId: T, turnId: TURN, itemId: 'f-s', reason: null })
    return // treo: không bao giờ gửi item/completed
  }
  notify('turn/started', { threadId: T, turn: { id: TURN, status: 'inProgress' } })
  if (scenario === 'ratelimit') {
    notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600 } } })
    notify('error', { error: { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded' }, willRetry: false })
    notify('turn/completed', { threadId: T, turn: { id: TURN, status: 'failed', error: { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded' } } })
    return
  }
  if (scenario === 'question') {
    const res = await ask('item/tool/requestUserInput', {
      threadId: T,
      turnId: TURN,
      itemId: 'q-1',
      isBlocking: true,
      questions: [{ id: 'db', header: 'Database', question: 'Dùng database nào?', isOther: true, isSecret: false, options: [{ label: 'SQLite', description: 'nhẹ' }, { label: 'Postgres', description: 'mạnh' }] }],
    })
    const a = res?.answers?.db?.answers?.[0] ?? '(không trả lời)'
    notify('item/completed', item({ type: 'agentMessage', id: 'm-q', text: `Chọn: ${a}`, phase: 'final_answer' }))
    notify('turn/completed', { threadId: T, turn: { id: TURN, status: 'completed', error: null } })
    return
  }
  // ok
  const cmd = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'npm install\''
  notify('item/started', item({ type: 'commandExecution', id: 'c-1', command: cmd, status: 'inProgress' }))
  const r1 = await ask('item/commandExecution/requestApproval', { kind: 'command', threadId: T, turnId: TURN, itemId: 'c-1', command: cmd, cwd: process.cwd() })
  const ran = r1?.decision === 'accept'
  notify('item/completed', item({ type: 'commandExecution', id: 'c-1', command: cmd, status: ran ? 'completed' : 'declined', aggregatedOutput: ran ? 'added 1 package' : null, exitCode: ran ? 0 : null }))
  const file = `${process.cwd()}${process.platform === 'win32' ? '\\' : '/'}hello.txt`
  notify('item/started', item({ type: 'fileChange', id: 'f-1', status: 'inProgress', changes: [{ path: file, kind: { type: 'add' }, diff: 'hi\n' }] }))
  const r2 = await ask('item/fileChange/requestApproval', { threadId: T, turnId: TURN, itemId: 'f-1', reason: null })
  notify('item/completed', item({ type: 'fileChange', id: 'f-1', status: r2?.decision === 'accept' ? 'completed' : 'declined', changes: [{ path: file, kind: { type: 'add' } }] }))
  notify('thread/tokenUsage/updated', { threadId: T, turnId: TURN, tokenUsage: { last: { totalTokens: 1234 }, total: { totalTokens: 5678 } } })
  notify('item/completed', item({ type: 'agentMessage', id: 'm-1', text: `done: ${r1?.decision}/${r2?.decision} | ${text.slice(0, 40)}`, phase: 'final_answer' }))
  notify('turn/completed', { threadId: T, turn: { id: TURN, status: 'completed', error: null } })
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
      return send({ id: m.id, result: { userAgent: 'fake', platformOs: process.platform } })
    case 'initialized':
      return
    case 'model/list':
      return send({ id: m.id, result: { data: [{ id: 'gpt-fake', isDefault: true }, { id: 'gpt-fake-mini', isDefault: false }] } })
    case 'thread/start':
      return send({ id: m.id, result: { thread: { id: T }, model: m.params.model ?? 'gpt-fake' } })
    case 'thread/resume':
      if (m.params.threadId !== T) return send({ id: m.id, error: { code: -32600, message: `thread not found: ${m.params.threadId}` } })
      return send({ id: m.id, result: { thread: { id: T }, model: m.params.model ?? 'gpt-fake' } })
    case 'turn/interrupt':
      send({ id: m.id, result: {} })
      return notify('turn/completed', { threadId: T, turn: { id: TURN, status: 'interrupted', error: null } })
    case 'turn/start':
      send({ id: m.id, result: { turn: { id: TURN, status: 'inProgress' } } })
      return void runTurn(m.params.input?.[0]?.text ?? '')
    default:
      return send({ id: m.id, error: { code: -32601, message: 'unknown' } })
  }
})
