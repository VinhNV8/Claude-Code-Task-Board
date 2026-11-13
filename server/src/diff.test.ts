import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageMime, isImagePath, parseGitDiff, parsePatch, unquoteGitPath } from '../../web/src/lib/diff.ts'

// Patch mẫu dạng output của `git diff --no-color --no-ext-diff -M main...claude/task-1`
const SAMPLE = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const a = 1
+export const b = 2
diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,4 @@
 import x from 'x'
-const port = 3000
+const port = 8080
 
 start(port)
@@ -10,2 +10,3 @@ function start() {
   run()
+  log()
 }
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 3333333..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
\\ No newline at end of file
diff --git a/docs/a b.md b/docs/c d.md
similarity index 80%
rename from docs/a b.md
rename to docs/c d.md
index 4444444..5555555 100644
--- a/docs/a b.md\t
+++ b/docs/c d.md\t
@@ -3 +3 @@ title
-cũ
+mới
diff --git a/same.txt b/moved/same.txt
similarity index 100%
rename from same.txt
rename to moved/same.txt
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..6666666
Binary files /dev/null and b/logo.png differ
diff --git "a/t\\303\\251st \\"q\\".txt" "b/t\\303\\251st \\"q\\".txt"
index 7777777..8888888 100644
--- "a/t\\303\\251st \\"q\\".txt"
+++ "b/t\\303\\251st \\"q\\".txt"
@@ -1 +1 @@
-x
+y
`

test('parseGitDiff: thêm, sửa, xoá, đổi tên, nhị phân, tên file có quote', () => {
  const files = parseGitDiff(SAMPLE)
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.additions, f.deletions, f.oldPath]),
    [
      ['src/new.ts', 'added', 2, 0, undefined],
      ['src/app.ts', 'modified', 2, 1, undefined],
      ['old.txt', 'deleted', 0, 2, undefined],
      ['docs/c d.md', 'modified', 1, 1, 'docs/a b.md'],
      ['moved/same.txt', 'modified', 0, 0, 'same.txt'],
      ['logo.png', 'added', 0, 0, undefined],
      ['tést "q".txt', 'modified', 1, 1, undefined],
    ],
  )

  const added = files[0]
  assert.deepEqual(added.hunks[0].lines, [
    { type: 'add', newNo: 1, text: 'export const a = 1' },
    { type: 'add', newNo: 2, text: 'export const b = 2' },
  ])

  const app = files[1]
  assert.equal(app.hunks.length, 2)
  assert.equal(app.hunks[0].header, '@@ -1,4 +1,4 @@')
  assert.deepEqual(app.hunks[0].lines, [
    { type: 'ctx', oldNo: 1, newNo: 1, text: "import x from 'x'" },
    { type: 'del', oldNo: 2, text: 'const port = 3000' },
    { type: 'add', newNo: 2, text: 'const port = 8080' },
    { type: 'ctx', oldNo: 3, newNo: 3, text: '' },
    { type: 'ctx', oldNo: 4, newNo: 4, text: 'start(port)' },
  ])
  assert.deepEqual(app.hunks[1].lines.map((l) => [l.type, l.oldNo, l.newNo]), [
    ['ctx', 10, 10],
    ['add', undefined, 11],
    ['ctx', 11, 12],
  ])

  // "\ No newline at end of file" không thành dòng diff
  assert.deepEqual(files[2].hunks[0].lines.map((l) => l.text), ['one', 'two'])
  // Hunk header không có số đếm ("@@ -3 +3 @@") → 1 dòng mỗi bên
  assert.deepEqual(files[3].hunks[0].lines, [
    { type: 'del', oldNo: 3, text: 'cũ' },
    { type: 'add', newNo: 3, text: 'mới' },
  ])
  assert.deepEqual(files[4].hunks, [])
  assert.deepEqual(files[5].hunks, [])
  // Đánh dấu nhị phân để giao diện xem trước ảnh thay vì diff trống
  assert.equal(files[5].binary, true)
  assert.equal(files[4].binary, undefined, 'đổi tên thuần không phải nhị phân')
  assert.equal(files[1].binary, undefined)
})

test('imageMime / isImagePath: theo đuôi file, không phân biệt hoa thường', () => {
  assert.equal(imageMime('a/logo.PNG'), 'image/png')
  assert.equal(imageMime('icon.svg'), 'image/svg+xml')
  assert.equal(imageMime('photo.jpeg'), 'image/jpeg')
  assert.equal(imageMime('README.md'), undefined)
  assert.equal(imageMime('svg'), undefined)
  assert.equal(isImagePath('x.webp'), true)
  assert.equal(isImagePath('x.ts'), false)
})

test('parseGitDiff: chuỗi rỗng → [] và chịu được CRLF', () => {
  assert.deepEqual(parseGitDiff(''), [])
  const files = parseGitDiff(SAMPLE.split('\n').slice(8, 21).join('\r\n'))
  assert.equal(files.length, 1)
  assert.equal(files[0].path, 'src/app.ts')
  assert.equal(files[0].hunks[0].lines[1].text, 'const port = 3000')
})

test('parsePatch: dòng trống cuối patch không bị đếm thành context', () => {
  const fd = parsePatch('a.txt', 'modified', '\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n\n')
  assert.equal(fd.hunks[0].lines.length, 3)
})

test('unquoteGitPath giải mã escape kiểu C', () => {
  assert.equal(unquoteGitPath('"a/t\\303\\251st\\tx\\\\y"'), 'a/tést\tx\\y')
  assert.equal(unquoteGitPath('plain'), 'plain')
})
