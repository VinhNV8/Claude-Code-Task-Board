// MCP stdio server tối giản: tool "approve" luôn cho phép, ghi log yêu cầu.
import readline from 'node:readline'
import { appendFileSync } from 'node:fs'
const LOG = process.argv[2]
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'taskboard', version: '0.0.1' } } })
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'approve', description: 'Permission prompt', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } } } }] } })
  else if (m.method === 'tools/call') {
    appendFileSync(LOG, JSON.stringify(m.params.arguments) + '\n')
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ behavior: 'allow', updatedInput: m.params.arguments.input }) }] } })
  } else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} })
})
