import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OutputNormalizer,
  OutputTail,
  TestCommandError,
  buildSpawn,
  escapeCmdArg,
  launch,
  parseCommand,
  resolveExecutable,
} from './testCommand.ts'

test('parseCommand: tách theo khoảng trắng và giữ nguyên tham số trong ngoặc', () => {
  assert.deepEqual(parseCommand('npm test'), ['npm', 'test'])
  assert.deepEqual(parseCommand('  npm   run  test:ci  '), ['npm', 'run', 'test:ci'])
  assert.deepEqual(parseCommand('"C:\\Program Files\\nodejs\\node.exe" --test "src/a b.test.ts"'), [
    'C:\\Program Files\\nodejs\\node.exe',
    '--test',
    'src/a b.test.ts',
  ])
  assert.deepEqual(parseCommand(`node -e 'console.log("x; y")'`), ['node', '-e', 'console.log("x; y")'])
  assert.deepEqual(parseCommand('vitest --reporter=""'), ['vitest', '--reporter='])
})

test('parseCommand: từ chối toán tử shell, lệnh trống, ngoặc không đóng', () => {
  for (const bad of ['npm i && npm test', 'npm test | tee out', 'npm test > log.txt', 'a; b', 'echo `x`'])
    assert.throws(() => parseCommand(bad), TestCommandError, bad)
  assert.throws(() => parseCommand('   '), /trống/)
  assert.throws(() => parseCommand('npm "test'), /đóng ngoặc/)
})

test('resolveExecutable (Windows): tìm theo PATH + PATHEXT, không tìm trong thư mục làm việc', () => {
  const files = new Set(['C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Program Files\\nodejs\\node.exe', 'D:\\repo\\npm.cmd', 'D:\\repo\\tools\\run.bat'])
  const o = {
    cwd: 'D:\\repo',
    platform: 'win32' as const,
    env: { Path: 'C:\\Windows;"C:\\Program Files\\nodejs"', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    isFile: (p: string) => files.has(p),
  }
  assert.equal(resolveExecutable('npm', o), 'C:\\Program Files\\nodejs\\npm.cmd')
  assert.equal(resolveExecutable('node', o), 'C:\\Program Files\\nodejs\\node.exe')
  assert.equal(resolveExecutable('node.exe', o), 'C:\\Program Files\\nodejs\\node.exe')
  assert.equal(resolveExecutable('tools\\run', o), 'D:\\repo\\tools\\run.bat')
  assert.equal(resolveExecutable('yarn', o), null)
})

test('buildSpawn: .cmd đi qua cmd.exe với tham số đã escape, .exe chạy trực tiếp', () => {
  assert.deepEqual(buildSpawn(['node', '--test'], 'C:\\Program Files\\nodejs\\node.exe', 'win32'), {
    file: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['--test'],
  })
  const s = buildSpawn(['npm', 'run', 'test:ci'], 'C:\\Program Files\\nodejs\\npm.cmd', 'win32', 'C:\\Windows\\system32\\cmd.exe')
  assert.equal(s.file, 'C:\\Windows\\system32\\cmd.exe')
  assert.equal(s.windowsVerbatimArguments, true)
  assert.deepEqual(s.args, ['/d', '/s', '/c', '"C:\\Program^ Files\\nodejs\\npm.cmd ^"run^" ^"test:ci^""'])
  assert.deepEqual(buildSpawn(['npm', 'test'], 'npm', 'linux'), { file: 'npm', args: ['test'] })
})

test('escapeCmdArg: escape dấu ngoặc kép, ký tự đặc biệt của cmd và dấu \\ cuối', () => {
  assert.equal(escapeCmdArg('a&b'), '^"a^&b^"')
  assert.equal(escapeCmdArg('say "hi"'), '^"say^ \\^"hi\\^"^"')
  assert.equal(escapeCmdArg('C:\\dir\\'), '^"C:\\dir\\\\^"')
  assert.equal(escapeCmdArg('%PATH%'), '^"^%PATH^%^"')
})

test('OutputNormalizer: bỏ mã màu, đổi CRLF, ghép phần bị cắt giữa hai chunk', () => {
  const n = new OutputNormalizer()
  assert.equal(n.push('\x1b[32m✓ pass\x1b[0m\r'), '✓ pass')
  assert.equal(n.push('\nnext\x1b['), '\nnext')
  assert.equal(n.push('31mred\x1b[0m line\r\n'), 'red line\n')
  assert.equal(n.push('progress\r'), 'progress')
  assert.equal(n.flush(), '\n')
})

test('OutputTail: giữ phần cuối, end là tổng số ký tự', () => {
  const t = new OutputTail(5)
  t.push('abc')
  t.push('defg')
  assert.deepEqual(t.snapshot(), { text: 'cdefg', end: 7 })
})

function run(command: string, cwd: string) {
  return new Promise<{ code: number | null; out: string; error?: string }>((res, rej) => {
    let out = ''
    try {
      launch(command, { cwd }, (s) => (out += s), (code, error) => res({ code, out, error }))
    } catch (e) {
      rej(e)
    }
  })
}

test('launch: chạy lệnh thật, gom stdout + stderr và trả exit code', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'taskboard test cmd '))
  const r = await run(`"${process.execPath}" -e "console.log('xin chào'); console.error('lỗi'); process.exit(3)"`, cwd)
  assert.equal(r.code, 3)
  assert.match(r.out, /xin chào\n/)
  assert.match(r.out, /lỗi\n/)
  assert.equal(r.error, undefined)
})

test('launch: không tìm thấy lệnh thì ném lỗi tiếng Việt trước khi spawn', () => {
  assert.throws(() => launch('khong-co-lenh-nay-xyz', { cwd: tmpdir() }, () => {}, () => {}), /Không tìm thấy lệnh/)
})

test('launch (Windows): file .cmd trong thư mục có dấu cách, tham số có dấu cách và ký tự đặc biệt', { skip: process.platform !== 'win32' }, async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'taskboard-')), 'thư mục có dấu cách')
  mkdirSync(dir)
  writeFileSync(join(dir, 'show args.cmd'), '@echo off\r\necho "%~1|%~2"\r\nexit /b 0\r\n')
  const r = await run(`"${join(dir, 'show args.cmd')}" "hello world" "a&b(1)"`, dir)
  assert.equal(r.code, 0)
  assert.equal(r.out.trim(), '"hello world|a&b(1)"')
})
