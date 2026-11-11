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

test('dòng không phải JSON được giữ lại dạng system', () => {
  const p = new StreamParser('.')
  const r = p.parseLine('some warning text')
  assert.equal(r.events[0].type, 'system')
})
