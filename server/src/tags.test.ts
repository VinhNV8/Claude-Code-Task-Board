import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_TAGS, TagError, validateTags } from './tags.ts'

test('validateTags: trim, gộp khoảng trắng, bỏ rỗng và bỏ trùng không phân biệt hoa thường', () => {
  assert.deepEqual(validateTags([' bug ', '', 'Bug', 'ui  fix', 'UI fix', 'p3']), ['bug', 'ui fix', 'p3'])
  assert.deepEqual(validateTags([]), [])
})

test('validateTags: báo lỗi tiếng Việt khi dữ liệu sai', () => {
  const bad = (v: unknown, re: RegExp) => assert.throws(() => validateTags(v), (e: unknown) => e instanceof TagError && re.test(e.message))
  bad('bug', /danh sách/)
  bad([1], /chuỗi/)
  bad(['a'.repeat(41)], /dài quá 40/)
  bad(['a,b'], /dấu phẩy/)
  bad(Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`), /tối đa 20/)
})
