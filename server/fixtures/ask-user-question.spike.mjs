// Spike FR-40: MCP stdio server tối giản đóng vai permission prompt tool.
// Ghi mọi lời gọi vào calls.jsonl. AskUserQuestion → allow + answers giả lập (biến ANSWER_MODE).
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOG = join(dirname(fileURLToPath(import.meta.url)), 'calls.jsonl')
const MODE = process.env.ANSWER_MODE || 'answers' // answers | deny
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const log = (o) => appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...o }) + '\n')

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.method === 'initialize')
    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'spike', version: '0.0.1' } } })
  if (m.method === 'tools/list')
    return send({
      jsonrpc: '2.0', id: m.id,
      result: { tools: [{ name: 'approve', description: 'permission prompt', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } }] },
    })
  if (m.method === 'tools/call') {
    const { tool_name, input } = m.params.arguments
    log({ tool_name, input })
    let decision
    if (tool_name === 'AskUserQuestion') {
      if (MODE === 'deny') decision = { behavior: 'deny', message: 'Người dùng trả lời: Màu xanh lá. (gửi qua lý do từ chối)' }
      else if (MODE === 'noanswer') decision = { behavior: 'allow', updatedInput: input }
      else {
        const answers = {}
        for (const q of input.questions ?? []) answers[q.question] = MODE === 'custom' ? 'Màu tím (không có trong danh sách)' : 'Xanh lá'
        decision = { behavior: 'allow', updatedInput: { ...input, answers } }
      }
    } else decision = { behavior: 'allow', updatedInput: input }
    log({ reply: decision })
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } })
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} })
})
