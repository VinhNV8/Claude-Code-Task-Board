// Đa ngôn ngữ giao diện (web/src/lib/i18n.ts + web/src/i18n/en.ts).
// - Hàm thuần: chọn ngôn ngữ, dịch, điền tham số.
// - Độ phủ: mọi chuỗi tr('…') trong web/src đều có bản tiếng Anh, tham số {…} khớp nhau.
// - File trong TRANSLATED không còn chuỗi tiếng Việt hiển thị nằm ngoài tr() (thêm file vào khi dịch xong).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format, normalizeLang, resolveLang, translate } from '../../web/src/lib/i18n.ts'
import { EN } from '../../web/src/i18n/en.ts'

const WEB_SRC = join(import.meta.dirname, '..', '..', 'web', 'src')

/** File giao diện đã dịch hết. Dịch xong file nào thì thêm vào đây. */
const TRANSLATED = ['components/Layout.tsx']

test('normalizeLang / resolveLang: lựa chọn đã lưu → URL → trình duyệt', () => {
  assert.equal(normalizeLang('vi-VN'), 'vi')
  assert.equal(normalizeLang('en-US'), 'en')
  assert.equal(normalizeLang('fr'), 'en') // ngôn ngữ chưa hỗ trợ: tiếng Anh
  assert.equal(normalizeLang(''), undefined)
  assert.equal(resolveLang({ stored: 'vi', search: '?lang=en', navigator: 'en-US' }), 'vi')
  assert.equal(resolveLang({ stored: null, search: '?lang=en', navigator: 'vi' }), 'en')
  assert.equal(resolveLang({ search: '', navigator: 'vi-VN' }), 'vi')
  assert.equal(resolveLang({}), 'vi')
})

test('translate / format: thiếu bản dịch thì giữ tiếng Việt; điền tham số', () => {
  const dict = { 'Xin chào {name}': 'Hello {name}' }
  assert.equal(translate('en', 'Xin chào {name}', { name: 'An' }, dict), 'Hello An')
  assert.equal(translate('vi', 'Xin chào {name}', { name: 'An' }, dict), 'Xin chào An')
  assert.equal(translate('en', 'Chưa dịch', undefined, dict), 'Chưa dịch')
  assert.equal(format('{a} và {b}', { a: 1 }), '1 và {b}')
})

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return sourceFiles(p)
    return /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts') ? [p] : []
  })
}

/** Chuỗi literal trong tr('…') / tr("…"). */
function trKeys(code: string) {
  const keys: string[] = []
  for (const m of code.matchAll(/\btr\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) keys.push(m[2].replace(/\\(['"\\])/g, '$1'))
  return keys
}

const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

test('mọi chuỗi tr() đều có bản tiếng Anh, tham số khớp', () => {
  const missing: string[] = []
  const badParams: string[] = []
  // Bỏ chính module i18n và từ điển (chỉ có tr('…') trong chú thích ví dụ)
  const files = sourceFiles(WEB_SRC).filter((f) => !/[\\/](lib[\\/]i18n\.ts|i18n[\\/])/.test(f.slice(WEB_SRC.length)))
  for (const file of files) {
    for (const k of trKeys(readFileSync(file, 'utf8'))) {
      if (!(k in EN)) missing.push(`${file.slice(WEB_SRC.length + 1)}: ${k}`)
      else if (params(k).join() !== params(EN[k]).join()) badParams.push(k)
    }
  }
  assert.deepEqual(missing, [], 'Thiếu bản dịch trong web/src/i18n/en.ts')
  assert.deepEqual(badParams, [], 'Tham số {…} của bản dịch không khớp chuỗi gốc')
})

const VI = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i

test('file đã dịch không còn chuỗi tiếng Việt hiển thị ngoài tr()', () => {
  for (const f of TRANSLATED) {
    const leftovers = readFileSync(join(WEB_SRC, f), 'utf8')
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => VI.test(line))
      // Bỏ chú thích và phần đã nằm trong tr()
      .filter(({ line }) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line))
      .filter(({ line }) => VI.test(line.replace(/\btr\(\s*(['"])(?:\\.|(?!\1).)*\1/g, '')))
      .map(({ line, n }) => `${f}:${n}: ${line.trim()}`)
    assert.deepEqual(leftovers, [], 'Còn chuỗi tiếng Việt chưa bọc tr()')
  }
})
