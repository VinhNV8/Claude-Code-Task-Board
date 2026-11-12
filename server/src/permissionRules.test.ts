import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeInput, isRiskyShell, matchesAllowed, rulesFor, splitCommand } from './permissionRules.ts'

const bash = (command: string) => ({ command })

test('tool không có ngoặc khớp mọi lần gọi', () => {
  assert.ok(matchesAllowed(['Read'], 'Read', { file_path: '/a' }))
  assert.ok(!matchesAllowed(['Read'], 'Write', { file_path: '/a' }))
})

test('Bash: khớp chính xác và theo tiền tố :*', () => {
  assert.ok(matchesAllowed(['Bash(git status)'], 'Bash', bash('git status')))
  assert.ok(!matchesAllowed(['Bash(git status)'], 'Bash', bash('git status --short')))
  assert.ok(matchesAllowed(['Bash(npm test:*)'], 'Bash', bash('npm test')))
  assert.ok(matchesAllowed(['Bash(npm test:*)'], 'Bash', bash('npm test -- --watch')))
  assert.ok(!matchesAllowed(['Bash(npm test:*)'], 'Bash', bash('npm testing')))
})

test('Bash ghép: mọi lệnh con đều phải khớp', () => {
  const rules = ['Bash(git log:*)', 'Bash(head:*)']
  assert.ok(matchesAllowed(rules, 'Bash', bash('git log --oneline | head -20')))
  assert.ok(!matchesAllowed(rules, 'Bash', bash('git log | head -20 && git --version')))
  assert.ok(!matchesAllowed(['Bash(npm test:*)'], 'Bash', bash('npm test; rm -rf /')))
})

test('Bash: thế lệnh và redirect ghi file không tự cho phép', () => {
  assert.ok(isRiskyShell('echo $(whoami)'))
  assert.ok(isRiskyShell('head a > b'))
  assert.ok(!isRiskyShell('npm test 2>&1'))
  assert.ok(!isRiskyShell('ls 2>/dev/null'))
  assert.ok(!matchesAllowed(['Bash(head:*)'], 'Bash', bash('head a > b')))
  assert.ok(matchesAllowed(['Bash(npm test:*)'], 'Bash', bash('npm test 2>&1')))
})

test('Bash(*) hoặc Bash cho phép mọi lệnh', () => {
  assert.ok(matchesAllowed(['Bash'], 'Bash', bash('anything $(x)')))
})

test('tool khác so khớp theo đường dẫn/URL', () => {
  assert.ok(matchesAllowed(['WebFetch(https://docs.example.com/*)'], 'WebFetch', { url: 'https://docs.example.com/a' }))
  assert.ok(!matchesAllowed(['WebFetch(https://docs.example.com/*)'], 'WebFetch', { url: 'https://evil.test/' }))
})

test('splitCommand tách theo && || ; | và xuống dòng', () => {
  assert.deepEqual(splitCommand('a && b || c; d | e\nf'), ['a', 'b', 'c', 'd', 'e', 'f'])
})

test('rulesFor: lệnh con có subcommand, bỏ cờ', () => {
  assert.deepEqual(rulesFor('Bash', bash('npm install lodash')), ['Bash(npm install:*)'])
  assert.deepEqual(rulesFor('Bash', bash('head -20 file')), ['Bash(head:*)'])
  assert.deepEqual(rulesFor('Bash', bash('git status && git status -s | head -5')), ['Bash(git status:*)', 'Bash(head:*)'])
  assert.deepEqual(rulesFor('WebFetch', { url: 'https://x' }), ['WebFetch'])
  // không sinh quy tắc rộng kiểu Bash(git:*)
  assert.deepEqual(rulesFor('Bash', bash('git --version')), ['Bash(git --version)'])
  assert.deepEqual(rulesFor('Bash', bash('git -C repo push')), ['Bash(git -C repo push)'])
})

test('rulesFor tạo ra quy tắc khớp lại chính lệnh đó', () => {
  const input = bash('git log --oneline | head -20 && git --version')
  assert.ok(matchesAllowed(rulesFor('Bash', input), 'Bash', input))
})

test('describeInput', () => {
  assert.equal(describeInput('Bash', bash('ls')), 'ls')
  assert.equal(describeInput('Edit', { file_path: 'a.ts', old_string: 'x' }), 'a.ts')
  assert.equal(describeInput('Foo', { a: 1 }), '{"a":1}')
})
