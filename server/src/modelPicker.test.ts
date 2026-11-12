// P5-04: bộ chọn model Lớp 1 (D4).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_RULES, countFiles, foldVi, suggestModel, type PickInput } from './modelPicker.ts'

const MID = 'x'.repeat(200) // độ dài trung tính: không "ngắn", không "dài"
const inp = (o: Partial<PickInput>): PickInput => ({ title: '', prompt: '', tags: [], permissionMode: 'acceptEdits', ...o })

// ---------------------------------------------------------------- tiêu chí nghiệm thu

test('nghiệm thu: "Sửa typo trong README", prompt ngắn, không tag → haiku', () => {
  const s = suggestModel(inp({ title: 'Sửa typo trong README', prompt: 'Chữ "recieve" viết sai.' }))
  assert.equal(s.model, 'haiku')
  assert.deepEqual(s.reasons, ['prompt có "typo" (−2)', 'prompt ngắn (−1)'])
  assert.equal(s.score, -3)
})

test('nghiệm thu: "Thêm nút Export CSV ở trang Stats", prompt ~300 ký tự, tag feature → sonnet', () => {
  const prompt =
    'Ở trang Stats, thêm một nút "Export CSV" cạnh bộ lọc khoảng thời gian. Khi bấm, tải về file CSV gồm các cột: ngày, ' +
    'project, số task hoàn thành, số run, tổng chi phí. Tên file theo dạng stats-YYYY-MM-DD.csv. Dùng dữ liệu đang hiển thị ' +
    'trên trang, không gọi thêm API mới. Nút dùng component Button có sẵn, có icon Download của lucide-react.'
  assert.ok(prompt.length >= 280 && prompt.length <= 400, String(prompt.length))
  const s = suggestModel(inp({ title: 'Thêm nút Export CSV ở trang Stats', prompt, tags: ['feature'] }))
  assert.equal(s.model, 'sonnet')
  assert.deepEqual(s.reasons, ['tag "feature" (+1)'])
})

test('nghiệm thu: "Refactor runner.ts … race condition", tag refactor → opus', () => {
  const s = suggestModel(inp({ title: 'Refactor runner.ts tách quản lý process, tránh race condition', prompt: MID, tags: ['refactor'] }))
  assert.equal(s.model, 'opus')
  assert.equal(s.score, 5)
  assert.deepEqual(s.reasons, ['tag "refactor" (+3)', 'prompt có "refactor" (+2)'])
})

test('nghiệm thu: permissionMode plan, prompt bình thường → opus', () => {
  const s = suggestModel(inp({ title: 'Thêm trang lịch sử', prompt: MID, permissionMode: 'plan' }))
  assert.equal(s.model, 'opus')
  assert.deepEqual(s.reasons, ['chế độ Plan (+3)'])
})

test('nghiệm thu: "sua chinh ta trang Settings" (không dấu) → haiku', () => {
  const s = suggestModel(inp({ title: 'sua chinh ta trang Settings' }))
  assert.equal(s.model, 'haiku')
  assert.deepEqual(s.reasons, ['prompt có "sửa chính tả" (−2)', 'prompt ngắn (−1)'])
})

test('nghiệm thu: tag "Docs" viết hoa được tính là tag dễ', () => {
  const s = suggestModel(inp({ title: 't', prompt: MID, tags: ['Docs'] }))
  assert.deepEqual(s.reasons, ['tag "Docs" (−3)'])
  assert.equal(s.model, 'haiku')
})

// ---------------------------------------------------------------- từng tín hiệu

test('không khớp gì → mặc định Sonnet', () => {
  const s = suggestModel(inp({ title: 'Thêm trang', prompt: MID }))
  assert.deepEqual(s, { model: 'sonnet', score: 0, reasons: ['Không có tín hiệu đặc biệt → mặc định Sonnet'] })
})

test('mỗi nhóm tag chỉ cộng 1 lần', () => {
  assert.equal(suggestModel(inp({ prompt: MID, tags: ['docs', 'typo', 'readme', 'format'] })).score, -3)
  assert.equal(suggestModel(inp({ prompt: MID, tags: ['refactor', 'security', 'perf'] })).score, 3)
  assert.equal(suggestModel(inp({ prompt: MID, tags: ['bug', 'bugfix', 'feature'] })).score, 1)
  // Các nhóm khác nhau thì cộng dồn
  const s = suggestModel(inp({ prompt: MID, tags: ['docs', 'security', 'bug', 'khác'] }))
  assert.equal(s.score, 1)
  assert.deepEqual(s.reasons, ['tag "docs" (−3)', 'tag "security" (+3)', 'tag "bug" (+1)'])
})

test('mỗi nhóm từ khoá chỉ cộng 1 lần, khớp cả title lẫn prompt', () => {
  const hard = suggestModel(inp({ title: 'Thiết kế kiến trúc', prompt: `${MID} tối ưu, deadlock, memory leak, security` }))
  assert.equal(hard.score, 2)
  assert.deepEqual(hard.reasons, ['prompt có "thiết kế" (+2)'])
  const easy = suggestModel(inp({ title: 'x', prompt: `${MID} typo, rename, format code, định dạng` }))
  assert.equal(easy.score, -2)
  // Dễ + khó cùng lúc
  assert.equal(suggestModel(inp({ title: 'Đổi tên biến', prompt: `${MID} để tránh race condition` })).score, 0)
})

test('so khớp không phân biệt hoa thường và bỏ dấu ở cả hai phía', () => {
  for (const t of ['RÒ RỈ BỘ NHỚ ở worker', 'ro ri bo nho o worker', 'Không Rõ Nguyên Nhân', 'loi ngau nhien', 'INTERMITTENT failure'])
    assert.equal(suggestModel(inp({ title: t, prompt: MID })).score, 2, t)
  assert.equal(suggestModel(inp({ title: 'Cap nhat README', prompt: MID })).score, -2)
  assert.equal(suggestModel(inp({ title: 'dinh dang lai file', prompt: MID })).score, -2)
})

test('foldVi: đ → d, bỏ dấu, lowercase', () => {
  assert.equal(foldVi('Định Dạng ĐƯỜNG'), 'dinh dang duong')
  assert.equal(foldVi('Sửa chính tả'), 'sua chinh ta')
})

test('độ dài: < 150 → −1, > 1500 → +1, ở giữa → 0', () => {
  assert.deepEqual(suggestModel(inp({ title: 'a'.repeat(50), prompt: 'b'.repeat(99) })).reasons, ['prompt ngắn (−1)'])
  assert.equal(suggestModel(inp({ title: 'a'.repeat(50), prompt: 'b'.repeat(100) })).score, 0)
  assert.equal(suggestModel(inp({ prompt: 'b'.repeat(1500) })).score, 0)
  assert.deepEqual(suggestModel(inp({ prompt: 'b'.repeat(1501) })).reasons, ['prompt dài (+1)'])
})

test('≥ 5 file khác nhau trong prompt → +1 (đếm file khác nhau)', () => {
  const four = 'Sửa server/src/a.ts, server/src/b.ts, web/src/C.tsx và docs/PLAN.md. Lại server/src/a.ts.'
  assert.equal(countFiles(four), 4)
  assert.equal(suggestModel(inp({ prompt: four.padEnd(200, ' ') })).score, 0)
  const five = `${four} Thêm config.yml`
  assert.equal(countFiles(five), 5)
  const s = suggestModel(inp({ prompt: five.padEnd(200, ' ') }))
  assert.deepEqual(s.reasons, ['nhắc tới 5 file (+1)'])
  // Đường dẫn Windows và phân biệt hoa thường
  assert.equal(countFiles('server\\src\\a.ts server/src/a.ts SERVER/SRC/A.TS'), 1)
})

test('ngưỡng D4: ≤ −2 haiku, ≥ 3 opus, còn lại sonnet', () => {
  // −2 (easy keyword, độ dài trung tính) → haiku
  assert.equal(suggestModel(inp({ title: 'typo', prompt: MID })).model, 'haiku')
  // −1 → sonnet
  assert.equal(suggestModel(inp({ title: 'x' })).model, 'sonnet')
  // +2 → sonnet
  assert.equal(suggestModel(inp({ title: 'tối ưu', prompt: MID })).model, 'sonnet')
  // +3 → opus
  assert.equal(suggestModel(inp({ title: 'tối ưu', prompt: MID, tags: ['bug'] })).model, 'opus')
})

test('rules tuỳ chỉnh được truyền vào', () => {
  const rules = { ...DEFAULT_RULES, thresholds: { haikuMax: -10, opusMin: 10 } }
  assert.equal(suggestModel(inp({ title: 'typo', tags: ['docs'] }), rules).model, 'sonnet')
})
