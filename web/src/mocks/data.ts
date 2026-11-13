// Dữ liệu giả cho prototype. Không có backend, không gọi Claude.
import { parsePatch } from '../lib/diff'
import type {
  FileDiff,
  LogEvent,
  LogEventInput,
  PermissionRequest,
  Project,
  PromptTemplate,
  ReviewAction,
  Run,
  Settings,
  Task,
} from '../types'

const MIN = 60_000
const now = Date.now()

export const seedProjects: Project[] = [
  {
    id: 'p-shop',
    name: 'shop-web',
    repoPath: 'D:\\Projects\\shop-web',
    mainBranch: 'main',
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(npm test:*)', 'Bash(git status)'],
    maxParallel: 2,
    testCommand: 'npm test',
    budgetAction: 'warn',
  },
  {
    id: 'p-api',
    name: 'expense-api',
    repoPath: 'D:\\Projects\\AI Project\\06-Expanse-Declaration-Project-03',
    mainBranch: 'develop',
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Edit', 'Glob', 'Grep', 'Bash(dotnet test:*)'],
    maxParallel: 1,
    testCommand: 'dotnet test',
    budgetAction: 'warn',
  },
  {
    id: 'p-docs',
    name: 'internal-docs',
    repoPath: 'D:\\Projects\\internal-docs',
    mainBranch: 'main',
    permissionMode: 'manual',
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxParallel: 1,
    budgetAction: 'warn',
  },
]

export const defaultSettings: Settings = {
  maxParallel: 2,
  browserNotifications: false,
  notifyOn: { review: true, needsInput: true, failed: true },
  permissionTimeoutMin: 30,
  defaultModel: 'auto',
  autoEscalate: true,
  telegram: { enabled: false, chatId: '', appUrl: '', hasToken: false },
  auth: { mode: 'subscription', hasApiKey: false, envApiKey: false },
}

// ---------------------------------------------------------------- Diff mẫu

const patchLogin = `
@@ -12,14 +12,22 @@ export function LoginForm() {
   const [email, setEmail] = useState('')
   const [password, setPassword] = useState('')
+  const [error, setError] = useState<string | null>(null)
+  const [loading, setLoading] = useState(false)

   async function onSubmit(e: FormEvent) {
     e.preventDefault()
-    await login(email, password)
-    navigate('/')
+    setError(null)
+    setLoading(true)
+    try {
+      await login(email, password)
+      navigate('/')
+    } catch (err) {
+      setError('Email hoặc mật khẩu không đúng')
+    } finally {
+      setLoading(false)
+    }
   }

   return (
     <form onSubmit={onSubmit}>
@@ -40,7 +48,8 @@ export function LoginForm() {
         onChange={(e) => setPassword(e.target.value)}
       />
-      <button type="submit">Đăng nhập</button>
+      {error && <p className="text-red-600 text-sm">{error}</p>}
+      <button type="submit" disabled={loading}>{loading ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>
     </form>
   )
 }`

const patchLoginTest = `
@@ -0,0 +1,18 @@
+import { render, screen, fireEvent } from '@testing-library/react'
+import { LoginForm } from './LoginForm'
+import * as auth from '../lib/auth'
+
+describe('LoginForm', () => {
+  it('hiển thị lỗi khi đăng nhập thất bại', async () => {
+    vi.spyOn(auth, 'login').mockRejectedValue(new Error('401'))
+    render(<LoginForm />)
+    fireEvent.click(screen.getByRole('button'))
+    expect(await screen.findByText('Email hoặc mật khẩu không đúng')).toBeInTheDocument()
+  })
+
+  it('vô hiệu hoá nút khi đang gửi', () => {
+    render(<LoginForm />)
+    fireEvent.click(screen.getByRole('button'))
+    expect(screen.getByRole('button')).toBeDisabled()
+  })
+})`

const patchPrice = `
@@ -1,9 +1,12 @@
-export function formatPrice(value: number) {
-  return value + ' đ'
+const formatter = new Intl.NumberFormat('vi-VN', {
+  style: 'currency',
+  currency: 'VND',
+  maximumFractionDigits: 0,
+})
+
+export function formatPrice(value: number) {
+  return formatter.format(value)
 }

 export function sumCart(items: CartItem[]) {
   return items.reduce((s, i) => s + i.price * i.qty, 0)
 }`

const patchReadme = `
@@ -3,6 +3,14 @@
 Ứng dụng bán hàng nội bộ.

+## Cài đặt
+
+\`\`\`bash
+npm install
+npm run dev
+\`\`\`
+
+Mở http://localhost:5173
+
 ## Cấu trúc thư mục

 - \`src/components\`: các component dùng chung`

const patchApi = `
@@ -21,10 +21,19 @@ public class ExpenseController : ControllerBase
     [HttpPost]
     public async Task<IActionResult> Create(CreateExpenseRequest req)
     {
+        if (req.Amount <= 0)
+            return BadRequest(new { error = "Số tiền phải lớn hơn 0" });
+        if (string.IsNullOrWhiteSpace(req.Category))
+            return BadRequest(new { error = "Thiếu loại chi phí" });
+
         var expense = await _service.CreateAsync(req);
         return CreatedAtAction(nameof(Get), new { id = expense.Id }, expense);
     }
-
-    // TODO: validate
+
+    [HttpGet("{id}")]
+    public async Task<IActionResult> Get(int id)
+    {
+        var e = await _service.GetAsync(id);
+        return e is null ? NotFound() : Ok(e);
+    }
 }`

const patchOldUtil = `
@@ -1,6 +0,0 @@
-// Không còn dùng từ v2
-export function legacyFormat(d: Date) {
-  return d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear()
-}
-
-export const LEGACY = true`

const patchFeedback = `
@@ -48,6 +48,7 @@ export function LoginForm() {
         onChange={(e) => setPassword(e.target.value)}
       />
-      {error && <p className="text-red-600 text-sm">{error}</p>}
+      {error && <p role="alert" className="text-red-600 text-sm mt-2">{error}</p>}
       <button type="submit" disabled={loading}>{loading ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>`

/** Bộ diff dùng cho task mới chạy xong trong giả lập. */
export const diffPool: FileDiff[][] = [
  [
    parsePatch('src/components/LoginForm.tsx', 'modified', patchLogin),
    parsePatch('src/components/LoginForm.test.tsx', 'added', patchLoginTest),
  ],
  [parsePatch('src/lib/price.ts', 'modified', patchPrice), parsePatch('src/lib/legacy.ts', 'deleted', patchOldUtil)],
  [parsePatch('README.md', 'modified', patchReadme)],
  [parsePatch('src/Controllers/ExpenseController.cs', 'modified', patchApi)],
]

/** Diff thêm vào sau khi Request changes. */
export const feedbackDiff = parsePatch('src/components/LoginForm.tsx', 'modified', patchFeedback)

// ---------------------------------------------------------------- Task mẫu

let n = 100
const t = (p: Partial<Task> & Pick<Task, 'title' | 'projectId' | 'status'>): Task => ({
  id: ++n,
  prompt: p.prompt ?? p.title,
  priority: 'normal',
  permissionMode: 'acceptEdits',
  tags: [],
  createdAt: now - 60 * MIN,
  updatedAt: now - 30 * MIN,
  ...p,
})

export function buildSeed() {
  n = 100
  const tasks: Task[] = [
    t({
      projectId: 'p-shop',
      status: 'review',
      title: 'Hiển thị lỗi khi đăng nhập thất bại',
      prompt:
        'Form đăng nhập hiện không báo gì khi sai mật khẩu. Hãy hiển thị thông báo lỗi, vô hiệu hoá nút khi đang gửi và viết test cho LoginForm.',
      priority: 'high',
      tags: ['bug', 'ui'],
      branch: 'claude/task-101',
      sessionId: '6f1c2b0e-0a51-4e7c-9a77-1b2d3c4d5e01',
      createdAt: now - 95 * MIN,
      updatedAt: now - 12 * MIN,
    }),
    t({
      projectId: 'p-api',
      status: 'review',
      title: 'Validate dữ liệu API tạo chi phí',
      prompt: 'Thêm validate cho POST /expenses: số tiền > 0, bắt buộc có category. Thêm endpoint GET /expenses/{id}.',
      tags: ['backend'],
      branch: 'claude/task-102',
      sessionId: '6f1c2b0e-0a51-4e7c-9a77-1b2d3c4d5e02',
      createdAt: now - 80 * MIN,
      updatedAt: now - 5 * MIN,
      reviewWarning: undefined,
    }),
    t({
      projectId: 'p-shop',
      status: 'needs_input',
      title: 'Nâng cấp thư viện định dạng ngày',
      prompt: 'Thay moment.js bằng date-fns trong toàn bộ dự án.',
      tags: ['refactor'],
      branch: 'claude/task-103',
      sessionId: '6f1c2b0e-0a51-4e7c-9a77-1b2d3c4d5e03',
      createdAt: now - 20 * MIN,
      updatedAt: now - 2 * MIN,
      startedAt: now - 6 * MIN,
    }),
    t({
      projectId: 'p-shop',
      status: 'queued',
      title: 'Định dạng giá tiền theo VND',
      prompt: 'Hàm formatPrice đang nối chuỗi thủ công. Dùng Intl.NumberFormat vi-VN. Xoá file legacy.ts không còn dùng.',
      priority: 'normal',
      tags: ['ui'],
      createdAt: now - 10 * MIN,
      updatedAt: now - 10 * MIN,
    }),
    t({
      projectId: 'p-docs',
      status: 'queued',
      title: 'Bổ sung hướng dẫn cài đặt vào README',
      priority: 'low',
      tags: ['docs'],
      createdAt: now - 8 * MIN,
      updatedAt: now - 8 * MIN,
    }),
    t({
      projectId: 'p-shop',
      status: 'backlog',
      title: 'Thêm dark mode cho trang quản trị',
      prompt: 'Thêm chế độ tối cho toàn bộ trang /admin, lưu lựa chọn của người dùng.',
      tags: ['ui', 'feature'],
      createdAt: now - 300 * MIN,
      updatedAt: now - 300 * MIN,
    }),
    t({
      projectId: 'p-api',
      status: 'backlog',
      title: 'Viết unit test cho ExpenseService',
      priority: 'high',
      tags: ['test'],
      createdAt: now - 200 * MIN,
      updatedAt: now - 200 * MIN,
    }),
    t({
      projectId: 'p-shop',
      status: 'done',
      title: 'Sửa lỗi tính tổng giỏ hàng khi số lượng = 0',
      tags: ['bug'],
      createdAt: now - 26 * 60 * MIN,
      updatedAt: now - 24 * 60 * MIN,
    }),
    t({
      projectId: 'p-docs',
      status: 'done',
      title: 'Chuẩn hoá tiêu đề các trang tài liệu',
      tags: ['docs'],
      createdAt: now - 30 * 60 * MIN,
      updatedAt: now - 29 * 60 * MIN,
    }),
    t({
      projectId: 'p-api',
      status: 'failed',
      title: 'Migrate database sang PostgreSQL',
      prompt: 'Chuyển EF Core provider từ SQL Server sang PostgreSQL, cập nhật migrations.',
      tags: ['backend'],
      branch: 'claude/task-110',
      sessionId: '6f1c2b0e-0a51-4e7c-9a77-1b2d3c4d5e10',
      failReason: 'Lệnh `dotnet ef database update` lỗi: không kết nối được tới localhost:5432 (exit code 1)',
      createdAt: now - 180 * MIN,
      updatedAt: now - 150 * MIN,
    }),
  ]

  const runs: Run[] = [
    {
      id: 'r-101-1', taskId: 101, kind: 'initial', startedAt: now - 30 * MIN, endedAt: now - 22 * MIN,
      exitCode: 0, numTurns: 14, costUsd: 0.42,
      summary: 'Đã thêm state error/loading cho LoginForm, hiển thị thông báo lỗi và vô hiệu hoá nút khi gửi. Đã viết 2 test, tất cả đều pass.',
    },
    {
      id: 'r-101-2', taskId: 101, kind: 'resume', feedback: 'Thông báo lỗi cần có role="alert" cho screen reader và cách nút một chút.',
      startedAt: now - 15 * MIN, endedAt: now - 12 * MIN, exitCode: 0, numTurns: 4, costUsd: 0.08,
      summary: 'Đã thêm role="alert" và margin-top cho thông báo lỗi.',
    },
    {
      id: 'r-102-1', taskId: 102, kind: 'initial', startedAt: now - 15 * MIN, endedAt: now - 5 * MIN,
      exitCode: 0, numTurns: 11, costUsd: 0.31,
      summary: 'Đã thêm validate Amount > 0 và Category bắt buộc, thêm endpoint GET /expenses/{id}. `dotnet test`: 24 passed.',
    },
    { id: 'r-103-1', taskId: 103, kind: 'initial', startedAt: now - 6 * MIN },
    {
      id: 'r-108-1', taskId: 108, kind: 'initial', startedAt: now - 25 * 60 * MIN, endedAt: now - 24 * 60 * MIN,
      exitCode: 0, numTurns: 7, costUsd: 0.12, summary: 'Đã sửa sumCart bỏ qua item có qty = 0, thêm test.',
    },
    {
      id: 'r-109-1', taskId: 109, kind: 'initial', startedAt: now - 30 * 60 * MIN, endedAt: now - 29 * 60 * MIN,
      exitCode: 0, numTurns: 5, costUsd: 0.06, summary: 'Đã chuẩn hoá tiêu đề H1 cho 12 trang.',
    },
    {
      id: 'r-110-1', taskId: 110, kind: 'initial', startedAt: now - 160 * MIN, endedAt: now - 150 * MIN,
      exitCode: 1, numTurns: 9, costUsd: 0.27,
      summary: 'Không thể áp dụng migration vì không kết nối được PostgreSQL.',
    },
  ]

  const ev = (runId: string, minsAgo: number, e: LogEventInput, i: number): LogEvent =>
    ({ id: `${runId}-e${i}`, runId, ts: now - minsAgo * MIN, ...e }) as LogEvent

  const events: LogEvent[] = [
    ...[
      { type: 'system', text: 'Khởi tạo phiên • model claude-opus-5-5 • cwd …/worktrees/shop-web/101' },
      { type: 'assistant', text: 'Tôi sẽ xem component LoginForm và hàm login trước.' },
      { type: 'tool_use', tool: 'Read', input: 'src/components/LoginForm.tsx' },
      { type: 'tool_result', tool: 'Read', output: '58 dòng' },
      { type: 'tool_use', tool: 'Read', input: 'src/lib/auth.ts' },
      { type: 'tool_result', tool: 'Read', output: '31 dòng' },
      { type: 'assistant', text: 'Hàm `login` ném lỗi khi 401 nhưng form không bắt lỗi. Tôi sẽ thêm state `error` và `loading`.' },
      { type: 'tool_use', tool: 'Edit', input: 'src/components/LoginForm.tsx' },
      { type: 'tool_result', tool: 'Edit', output: 'Đã sửa (+14 −2)' },
      { type: 'tool_use', tool: 'Write', input: 'src/components/LoginForm.test.tsx' },
      { type: 'tool_result', tool: 'Write', output: 'Đã tạo file (18 dòng)' },
      { type: 'tool_use', tool: 'Bash', input: 'npm test -- LoginForm' },
      { type: 'tool_result', tool: 'Bash', output: 'PASS src/components/LoginForm.test.tsx\n  ✓ hiển thị lỗi khi đăng nhập thất bại (42 ms)\n  ✓ vô hiệu hoá nút khi đang gửi (11 ms)\n\nTests: 2 passed, 2 total' },
      { type: 'result', text: 'Đã thêm state error/loading cho LoginForm, hiển thị thông báo lỗi và vô hiệu hoá nút khi gửi. Đã viết 2 test, tất cả đều pass.' },
    ].map((e, i) => ev('r-101-1', 30 - i * 0.6, e as never, i)),
    ...[
      { type: 'system', text: 'Tiếp tục phiên (resume) với feedback của người dùng' },
      { type: 'assistant', text: 'Tôi sẽ thêm role="alert" và khoảng cách cho thông báo lỗi.' },
      { type: 'tool_use', tool: 'Edit', input: 'src/components/LoginForm.tsx' },
      { type: 'tool_result', tool: 'Edit', output: 'Đã sửa (+1 −1)' },
      { type: 'result', text: 'Đã thêm role="alert" và margin-top cho thông báo lỗi.' },
    ].map((e, i) => ev('r-101-2', 15 - i * 0.7, e as never, i)),
    ...[
      { type: 'system', text: 'Khởi tạo phiên • model claude-opus-5-5 • cwd …/worktrees/expense-api/102' },
      { type: 'assistant', text: 'Tôi sẽ kiểm tra ExpenseController và CreateExpenseRequest.' },
      { type: 'tool_use', tool: 'Grep', input: 'class ExpenseController' },
      { type: 'tool_result', tool: 'Grep', output: 'src/Controllers/ExpenseController.cs:8' },
      { type: 'tool_use', tool: 'Edit', input: 'src/Controllers/ExpenseController.cs' },
      { type: 'tool_result', tool: 'Edit', output: 'Đã sửa (+13 −2)' },
      { type: 'tool_use', tool: 'Bash', input: 'dotnet test' },
      { type: 'tool_result', tool: 'Bash', output: 'Passed!  - Failed: 0, Passed: 24, Skipped: 0, Total: 24' },
      { type: 'result', text: 'Đã thêm validate Amount > 0 và Category bắt buộc, thêm endpoint GET /expenses/{id}. `dotnet test`: 24 passed.' },
    ].map((e, i) => ev('r-102-1', 15 - i * 1.1, e as never, i)),
    ...[
      { type: 'system', text: 'Khởi tạo phiên • model claude-opus-5-5 • cwd …/worktrees/shop-web/103' },
      { type: 'assistant', text: 'Tôi sẽ tìm tất cả chỗ đang import moment.' },
      { type: 'tool_use', tool: 'Grep', input: "from 'moment'" },
      { type: 'tool_result', tool: 'Grep', output: '9 file khớp' },
      { type: 'assistant', text: 'Cần cài date-fns trước khi sửa code.' },
      { type: 'tool_use', tool: 'Bash', input: 'npm install date-fns@4.1.0' },
    ].map((e, i) => ev('r-103-1', 6 - i * 0.8, e as never, i)),
    ...[
      { type: 'system', text: 'Khởi tạo phiên • model claude-opus-5-5 • cwd …/worktrees/expense-api/110' },
      { type: 'assistant', text: 'Tôi sẽ đổi provider sang Npgsql và tạo lại migration.' },
      { type: 'tool_use', tool: 'Edit', input: 'src/Program.cs' },
      { type: 'tool_result', tool: 'Edit', output: 'Đã sửa (+2 −2)' },
      { type: 'tool_use', tool: 'Bash', input: 'dotnet ef database update' },
      { type: 'tool_result', tool: 'Bash', isError: true, output: 'Npgsql.NpgsqlException: Failed to connect to 127.0.0.1:5432\n ---> System.Net.Sockets.SocketException: No connection could be made because the target machine actively refused it.' },
      { type: 'result', isError: true, text: 'Không thể áp dụng migration vì không kết nối được PostgreSQL. Vui lòng khởi động PostgreSQL rồi chạy lại.' },
    ].map((e, i) => ev('r-110-1', 160 - i * 1.5, e as never, i)),
  ]

  const diffs: Record<number, FileDiff[]> = {
    101: [diffPool[0][0], diffPool[0][1]],
    102: diffPool[3],
  }

  const permissions: PermissionRequest[] = [
    {
      id: 'perm-1',
      taskId: 103,
      tool: 'Bash',
      input: 'npm install date-fns@4.1.0',
      createdAt: now - 2 * MIN,
      timeoutAt: now + 28 * MIN,
      status: 'pending',
    },
  ]

  const reviews: ReviewAction[] = [
    {
      id: 'rv-1', taskId: 101, action: 'request_changes', createdAt: now - 16 * MIN,
      feedback: 'Thông báo lỗi cần có role="alert" cho screen reader và cách nút một chút.',
    },
  ]

  return { tasks, runs, events, diffs, permissions, reviews, nextTaskId: 111 }
}

// Giống template mặc định của backend (server/src/templates.ts)
export const promptTemplates: PromptTemplate[] = [
  { id: 'tpl-bug', name: 'Sửa lỗi', title: 'Sửa lỗi: ', tags: ['bug'], prompt: 'Lỗi: <mô tả lỗi>\nCách tái hiện: <các bước>\nKỳ vọng: <hành vi đúng>\n\nHãy tìm nguyên nhân, sửa lỗi và viết test để ngăn tái diễn.' },
  { id: 'tpl-test', name: 'Viết test', title: 'Viết test cho ', tags: ['test'], prompt: 'Viết unit test cho <module/file>. Bao phủ các trường hợp biên. Chạy test và đảm bảo tất cả pass.' },
  { id: 'tpl-refactor', name: 'Refactor', title: 'Refactor ', tags: ['refactor'], prompt: 'Refactor <phần code> để <mục tiêu>. Không thay đổi hành vi. Chạy test sau khi sửa.' },
  { id: 'tpl-feature', name: 'Tính năng mới', title: '', tags: ['feature'], prompt: 'Tính năng: <mô tả>\nYêu cầu:\n- \n- \n\nHãy triển khai, viết test và tóm tắt các thay đổi.' },
]
