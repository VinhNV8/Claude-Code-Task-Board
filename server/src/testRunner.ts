// Chạy lệnh test của project trong worktree của task (PLAN 4.3, FR-34).
// Mỗi task tối đa một lần chạy cùng lúc; output stream qua WS, lần chạy gần nhất lưu ở bảng test_runs.
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { broadcast } from './bus.ts'
import { projects, tasks, testRuns } from './db.ts'
import { killTree } from './proc.ts'
import { launch, OutputTail, TestCommandError } from './testCommand.ts'
import type { TestOutput, TestRun } from './types.ts'

/** Lỗi có mã HTTP (Fastify dùng `statusCode`). */
export class TestRunError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

const TIMEOUT_MIN = Math.max(1, Number(process.env.TASKBOARD_TEST_TIMEOUT_MIN) || 30)
/** Gom output trong khoảng này rồi mới gửi qua WS để không bắn quá nhiều tin nhắn. */
const FLUSH_MS = 100

interface Active {
  child: ChildProcess
  out: OutputTail
  /** Output chưa gửi qua WS, bắt đầu tại vị trí `sentEnd` */
  pending: string
  sentEnd: number
  flushTimer?: NodeJS.Timeout
  timeout: NodeJS.Timeout
  stopReason?: string
  timedOut?: boolean
}

const active = new Map<number, Active>()

export const isTesting = (taskId: number) => active.has(taskId)
export const hasActiveTests = () => active.size > 0

function flush(taskId: number, a: Active) {
  if (a.flushTimer) clearTimeout(a.flushTimer)
  a.flushTimer = undefined
  if (!a.pending) return
  broadcast({ type: 'test_output', taskId, offset: a.sentEnd, chunk: a.pending })
  a.sentEnd += a.pending.length
  a.pending = ''
}

/** Bắt đầu chạy test. Ném TestRunError (kèm mã HTTP, thông báo tiếng Việt) nếu không chạy được. */
export function startTests(taskId: number): TestRun {
  const task = tasks.get(taskId)
  if (!task) throw new TestRunError(404, `Không tìm thấy task #${taskId}`)
  if (active.has(taskId)) throw new TestRunError(409, 'Test của task này đang chạy, hãy đợi xong hoặc bấm Dừng')
  const command = projects.get(task.projectId)?.testCommand?.trim()
  if (!command) throw new TestRunError(400, 'Project chưa cấu hình lệnh test (vào Projects → Sửa để thêm, ví dụ "npm test")')
  if (task.status === 'running' || task.status === 'needs_input')
    throw new TestRunError(409, 'Claude đang làm việc trong worktree, hãy đợi task chạy xong rồi chạy test')
  if (!task.worktreePath || !existsSync(task.worktreePath)) throw new TestRunError(409, 'Task chưa có worktree để chạy test')

  const out = new OutputTail()
  // Khởi tạo trước khi launch: callback chỉ được gọi bất đồng bộ, sau khi `a` đã gán xong.
  const a = { out, pending: '', sentEnd: 0 } as Active
  let child: ChildProcess
  try {
    child = launch(
      command,
      { cwd: task.worktreePath },
      (s) => {
        out.push(s)
        a.pending += s
        a.flushTimer ??= setTimeout(() => flush(taskId, a), FLUSH_MS)
      },
      (code, error) => finish(taskId, a, code, error),
    )
  } catch (e) {
    if (e instanceof TestCommandError) throw new TestRunError(400, e.message)
    throw new TestRunError(500, `Không chạy được lệnh test: ${(e as Error).message}`)
  }
  a.child = child
  a.timeout = setTimeout(() => {
    a.timedOut = true
    void stopTests(taskId, `Quá thời gian ${TIMEOUT_MIN} phút, đã dừng.`)
  }, TIMEOUT_MIN * 60_000)
  active.set(taskId, a)

  const run = testRuns.start({ taskId, command, startedAt: Date.now() })
  broadcast({ type: 'test_run', testRun: run })
  return run
}

function finish(taskId: number, a: Active, code: number | null, error?: string) {
  clearTimeout(a.timeout)
  flush(taskId, a)
  if (active.get(taskId) === a) active.delete(taskId)
  const status: TestRun['status'] = a.stopReason
    ? a.timedOut
      ? 'failed'
      : 'stopped'
    : error
      ? 'error'
      : code === 0
        ? 'passed'
        : 'failed'
  const run = testRuns.finish(
    taskId,
    { status, endedAt: Date.now(), exitCode: code ?? undefined, error: a.stopReason ?? error },
    a.out.snapshot(),
  )
  if (run) broadcast({ type: 'test_run', testRun: run })
}

/** Dừng lần chạy test của task. Trả false nếu không có lần chạy nào. Kết quả ghi khi tiến trình thoát. */
export async function stopTests(taskId: number, reason = 'Đã dừng bởi người dùng.') {
  const a = active.get(taskId)
  if (!a) return false
  a.stopReason ??= reason
  if (a.child.pid) await killTree(a.child.pid)
  return true
}

/** Lần chạy gần nhất kèm output (đang chạy thì lấy output trong bộ nhớ). */
export function testState(taskId: number): { testRun: TestRun | null; output: TestOutput } {
  const a = active.get(taskId)
  return { testRun: testRuns.get(taskId) ?? null, output: a ? a.out.snapshot() : testRuns.output(taskId) }
}

/** Tắt server: dừng mọi lần chạy; lần khởi động sau sẽ đánh dấu lần còn dở là lỗi. */
export async function shutdownTests() {
  for (const [taskId] of active) await stopTests(taskId, 'Server đã tắt trong khi đang chạy test.')
}
