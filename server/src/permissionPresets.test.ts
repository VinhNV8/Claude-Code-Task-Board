import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PERMISSION_PRESETS, mergeRules } from './permissionPresets.ts'
import { matchesAllowed, parseRule } from './permissionRules.ts'

const preset = (id: string) => PERMISSION_PRESETS.find((p) => p.id === id)!.rules
const bash = (command: string) => ({ command })

test('preset: có đủ 4 bộ, id không trùng, mọi rule parse được', () => {
  assert.deepEqual(
    PERMISSION_PRESETS.map((p) => p.id),
    ['read', 'git-read', 'node', 'python'],
  )
  for (const p of PERMISSION_PRESETS) {
    assert.ok(p.name && p.description && p.rules.length > 0, p.id)
    for (const r of p.rules) {
      const parsed = parseRule(r)
      assert.match(parsed.tool, /^(Read|Bash)$/, r)
      if (parsed.tool === 'Bash') assert.ok(parsed.pattern?.trim(), r)
    }
  }
})

test('preset: không chứa lệnh có tác dụng phụ', () => {
  const all = PERMISSION_PRESETS.flatMap((p) => p.rules).join('\n')
  for (const bad of ['install', 'push', 'commit', 'pip ', 'rm ', 'reset', 'checkout']) assert.ok(!all.includes(bad), bad)
})

test('preset read: cho tool đọc, không cho ghi', () => {
  assert.ok(matchesAllowed(preset('read'), 'Read', { file_path: '/a' }))
  assert.ok(matchesAllowed(preset('read'), 'Grep', { pattern: 'x' }))
  assert.ok(!matchesAllowed(preset('read'), 'Write', { file_path: '/a' }))
  assert.ok(!matchesAllowed(preset('read'), 'Bash', bash('cat a')))
})

test('preset node: khớp lệnh test/lint/build, không khớp npm install', () => {
  const r = preset('node')
  // `:*` = lệnh trần hoặc thêm tham số sau dấu cách, nên `npm run test:unit` (script khác) KHÔNG khớp.
  assert.ok(!matchesAllowed(r, 'Bash', bash('npm run test:unit')))
  for (const c of ['npm test', 'npm test -- --watch=false', 'npm run test -- --coverage', 'npm run lint', 'npm run build -w web', 'npx tsc --noEmit', 'node --version'])
    assert.ok(matchesAllowed(r, 'Bash', bash(c)), c)
  for (const c of ['npm install', 'npm i lodash', 'npm run deploy', 'npm testing', 'node script.js', 'npm test && npm install'])
    assert.ok(!matchesAllowed(r, 'Bash', bash(c)), c)
})

test('preset git-read: khớp lệnh đọc, không khớp push/commit', () => {
  const r = preset('git-read')
  for (const c of ['git status', 'git status --short', 'git diff HEAD~1', 'git log --oneline -5', 'git show abc', 'git branch', 'git rev-parse HEAD'])
    assert.ok(matchesAllowed(r, 'Bash', bash(c)), c)
  for (const c of ['git push', 'git push origin main', 'git commit -m x', 'git branch -D main', 'git checkout .', 'git status; git push'])
    assert.ok(!matchesAllowed(r, 'Bash', bash(c)), c)
})

test('preset python: khớp pytest/ruff/mypy, không khớp pip install', () => {
  const r = preset('python')
  for (const c of ['pytest', 'pytest -x tests/', 'python -m pytest -q', 'ruff check .', 'mypy src', 'python --version'])
    assert.ok(matchesAllowed(r, 'Bash', bash(c)), c)
  for (const c of ['pip install x', 'ruff format .', 'python script.py', 'python -m pip install x'])
    assert.ok(!matchesAllowed(r, 'Bash', bash(c)), c)
})

test('mergeRules: giữ thứ tự, bỏ trùng sau trim, bỏ rỗng', () => {
  assert.deepEqual(mergeRules(['Read', 'Edit'], [' Read ', 'Bash(git status)', 'Edit', '', 'Bash(git status) ']), [
    'Read',
    'Edit',
    'Bash(git status)',
  ])
  assert.deepEqual(mergeRules([], preset('node')), preset('node'))
  assert.deepEqual(mergeRules(['a', ' a'], []), ['a'])
})
