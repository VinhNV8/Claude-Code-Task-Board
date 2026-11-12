import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StreamParser } from './stream.ts'

const fx = (name: string) => readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8').trim().split('\n')

function parseAll(name: string, cwd = 'C:\\nowhere') {
  const p = new StreamParser(cwd)
  const res = fx(name).map((l) => p.parseLine(l))
  return {
    events: res.flatMap((r) => r.events),
    result: res.find((r) => r.result)?.result,
    sessionId: res.find((r) => r.sessionId)?.sessionId,
  }
}

test('simple: init + assistant + result', () => {
  const { events, result, sessionId } = parseAll('simple.jsonl')
  assert.ok(sessionId)
  assert.equal(events[0].type, 'system')
  assert.ok(events.some((e) => e.type === 'assistant'))
  assert.equal(result?.isError, false)
  assert.equal(result?.text, 'hi')
  assert.equal(result?.numTurns, 1)
  assert.equal(typeof result?.costUsd, 'number')
})

test('resume: giữ ngữ cảnh', () => {
  const { result } = parseAll('resume.jsonl')
  assert.equal(result?.text, '42')
})

test('tools: tool_use/tool_result được ghép tên tool, đường dẫn tương đối', () => {
  const cwd = 'C:\\Users\\ADMIN\\AppData\\Local\\Temp\\claude\\f090e469dcca3c32\\9d0784f0-2e63-4639-ba35-6e54b92455b2\\scratchpad\\spike\\repo with space'
  const { events } = parseAll('tools.jsonl', cwd)
  const uses = events.filter((e) => e.type === 'tool_use')
  assert.deepEqual(
    uses.map((e) => e.type === 'tool_use' && e.tool),
    ['Read', 'Bash', 'Write'],
  )
  const read = uses[0]
  assert.equal(read.type === 'tool_use' && read.input, 'note.txt')
  const results = events.filter((e) => e.type === 'tool_result')
  assert.equal(results.length, 3)
  const bash = results[1]
  assert.ok(bash.type === 'tool_result' && bash.tool === 'Bash' && bash.isError)
})

test('permission denied: liệt kê quyền bị từ chối', () => {
  const { result, events } = parseAll('permission-denied.jsonl')
  assert.equal(result?.permissionDenials.length, 1)
  assert.equal(result?.permissionDenials[0].tool, 'Bash')
  assert.ok(events.some((e) => e.type === 'system' && e.text.startsWith('Quyền bị từ chối')))
})

test('P5-01: model từ init, modelUsage theo model, contextTokens của message assistant cuối', () => {
  const p = new StreamParser('C:\\nowhere')
  const res = fx('permission-denied.jsonl').map((l) => p.parseLine(l))
  const models = res.map((r) => r.model).filter(Boolean)
  assert.deepEqual(models, ['claude-opus-5-5'])
  // Dòng log system của init vẫn giữ nguyên
  assert.ok(res.flatMap((r) => r.events).some((e) => e.type === 'system' && e.text.startsWith('Khởi tạo phiên • model claude-opus-5-5')))

  const result = res.find((r) => r.result)!.result!
  assert.deepEqual(Object.keys(result.modelUsage!).sort(), ['claude-haiku-5-5', 'claude-opus-5-5'])
  assert.deepEqual(result.modelUsage!['claude-opus-5-5'], {
    inputTokens: 4,
    outputTokens: 120,
    cacheReadInputTokens: 70227,
    cacheCreationInputTokens: 11952,
    costUsd: 0.1120774,
  })
  assert.equal(result.modelUsage!['claude-haiku-5-5'].costUsd, 0.0002093)
  const sum = Object.values(result.modelUsage!).reduce((s, u) => s + u.costUsd, 0)
  assert.ok(Math.abs(sum - result.costUsd!) < 0.001)
  // Message assistant cuối: input 2 + cache read 40952 + cache creation 275
  assert.equal(result.contextTokens, 41229)
})

test('P5-01: result không có modelUsage thì để undefined; số thiếu thành 0; bỏ qua usage của subagent', () => {
  const p = new StreamParser('.')
  const r1 = p.parseLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }))
  assert.equal(r1.result?.modelUsage, undefined)
  assert.equal(r1.result?.contextTokens, undefined)

  const msg = (usage: object, parent: string | null = null) =>
    JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text: 'x' }], usage } })
  p.parseLine(msg({ input_tokens: 10, cache_read_input_tokens: 100 }))
  p.parseLine(msg({ input_tokens: 999999 }, 'toolu_sub'))
  const r2 = p.parseLine(
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, modelUsage: { 'claude-sonnet-5': { outputTokens: 5, costUSD: 0.01 } } }),
  )
  assert.deepEqual(r2.result?.modelUsage, {
    'claude-sonnet-5': { inputTokens: 0, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0.01 },
  })
  assert.equal(r2.result?.contextTokens, 110)
})

test('P5-08: fixture thật `--model haiku` → model/modelUsage của Haiku', () => {
  const p = new StreamParser('C:\\nowhere')
  const res = fx('model-haiku.jsonl').map((l) => p.parseLine(l))
  assert.deepEqual(res.map((r) => r.model).filter(Boolean), ['claude-haiku-5-5'])
  const result = res.find((r) => r.result)!.result!
  assert.equal(result.isError, false)
  assert.equal(result.text, 'Xin chào')
  // Chỉ có Haiku (không có Opus/Sonnet chạy nền), số liệu lấy từ event result thật
  assert.deepEqual(result.modelUsage, {
    'claude-haiku-5-5': {
      inputTokens: 1182,
      outputTokens: 33,
      cacheReadInputTokens: 27275,
      cacheCreationInputTokens: 14470,
      costUsd: 0.0033014500000000005,
    },
  })
  assert.ok(Math.abs(result.modelUsage!['claude-haiku-5-5'].costUsd - result.costUsd!) < 0.001)
  // Message assistant: input 2 + cache read 27275 + cache creation 14470
  assert.equal(result.contextTokens, 41747)
})

test('dòng không phải JSON được giữ lại dạng system', () => {
  const p = new StreamParser('.')
  const r = p.parseLine('some warning text')
  assert.equal(r.events[0].type, 'system')
})
