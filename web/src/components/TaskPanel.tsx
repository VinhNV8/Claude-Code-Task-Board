import { TaskView } from './TaskView'

/**
 * Khung chi tiết task trên trang Công việc.
 * - `float`: trượt ra từ bên phải, không che phần còn lại (bấm thẻ khác để đổi task). Điện thoại: toàn màn hình.
 * - `dock`: gắn cố định cạnh danh sách (view Phân luồng).
 */
export function TaskPanel({
  taskId,
  variant,
  onClose,
  taskLink,
}: {
  taskId: number
  variant: 'float' | 'dock'
  onClose: () => void
  taskLink: (id: number) => string
}) {
  const view = <TaskView key={taskId} taskId={taskId} mode="panel" onClose={onClose} taskLink={taskLink} />
  if (variant === 'dock')
    return (
      <section aria-label="Chi tiết task" className="min-w-0 flex-1 overflow-y-auto bg-white px-5 py-4 dark:bg-slate-900">
        {view}
      </section>
    )
  return (
    <aside
      aria-label="Chi tiết task"
      className="fixed inset-0 z-40 overflow-y-auto bg-white px-4 py-3 shadow-2xl motion-safe:animate-[panel-in_.18s_ease-out] md:inset-y-0 md:left-auto md:right-0 md:w-[min(600px,92vw)] md:border-l md:border-slate-200 md:px-5 dark:bg-slate-900 md:dark:border-slate-800"
    >
      {view}
    </aside>
  )
}
