// Thông báo khi task cần người dùng (PLAN 3.7–3.9). Phần logic thuần (không đụng DOM) được test ở
// server/src/notifyUi.test.ts; các hàm chạm tới Notification/document đều kiểm tra môi trường trước.
import type { PermissionRequest, Settings, Task, TaskStatus, Toast } from '../types.ts'

export type Notice = Omit<Toast, 'id'>

/** Thông báo khi task chuyển trạng thái; null nếu không đổi trạng thái hoặc loại đó bị tắt trong `notifyOn`. */
export function transitionNotice(prev: TaskStatus | undefined, task: Pick<Task, 'id' | 'title' | 'status' | 'failReason'>, notifyOn: Settings['notifyOn']): Notice | null {
  if (!prev || prev === task.status) return null
  if (task.status === 'review' && notifyOn.review) return { kind: 'info', title: `Cần review: #${task.id}`, body: task.title, taskId: task.id }
  if (task.status === 'needs_input' && notifyOn.needsInput) return { kind: 'warning', title: `Claude cần bạn: #${task.id}`, body: task.title, taskId: task.id }
  if (task.status === 'failed' && notifyOn.failed) return { kind: 'error', title: `Task lỗi: #${task.id}`, body: task.failReason || task.title, taskId: task.id }
  return null
}

/** Đường dẫn (HashRouter) mở trang chi tiết task. */
export const taskHash = (taskId: number) => `#/tasks/${taskId}`

/** Chỉ tự hỏi quyền khi trình duyệt chưa từng được hỏi và trình duyệt này chưa hỏi lần nào. */
export function shouldAskPermission(permission: NotificationPermission | 'unsupported', alreadyAsked: boolean): boolean {
  return permission === 'default' && !alreadyAsked
}

/** Dòng lệnh hiển thị trên thẻ xin quyền: lệnh shell có dấu `$`, tool khác hiện nguyên mô tả input. */
export function permissionDisplay(req: Pick<PermissionRequest, 'tool' | 'input'>): string {
  const text = req.input.trim() || '(không có tham số)'
  return /^(Bash|PowerShell)$/.test(req.tool) ? `$ ${text}` : text
}

/** Số ms còn lại trước khi server tự từ chối; 0 khi đã quá hạn. */
export const permissionTimeLeft = (timeoutAt: number, now: number) => Math.max(0, timeoutAt - now)

// ------------------------------------------------------------ trình duyệt

const ASKED_KEY = 'notifyPermissionAsked'

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(key: string, v: string) {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* bỏ qua */
  }
}

/**
 * Xin quyền thông báo một lần cho mỗi trình duyệt (gọi trong thao tác của người dùng).
 * Trả về kết quả nếu vừa hỏi, null nếu không hỏi.
 */
export async function askPermissionOnce(): Promise<NotificationPermission | null> {
  if (!shouldAskPermission(notificationPermission(), storageGet(ASKED_KEY) === '1')) return null
  storageSet(ASKED_KEY, '1')
  try {
    return await Notification.requestPermission()
  } catch {
    return null
  }
}

/**
 * Hiện thông báo của hệ điều hành. Mặc định chỉ hiện khi tab không được nhìn thấy/không focus
 * (đang xem tab thì toast trong trang là đủ). Bấm vào thông báo: focus tab và mở đúng task.
 */
export function showBrowserNotification(n: Notice, opts: { force?: boolean } = {}) {
  if (notificationPermission() !== 'granted') return
  if (!opts.force && !document.hidden && document.hasFocus()) return
  try {
    const notif = new Notification(n.title, { body: n.body, tag: n.taskId != null ? `task-${n.taskId}` : undefined })
    notif.onclick = () => {
      window.focus()
      if (n.taskId != null) location.hash = taskHash(n.taskId)
      notif.close()
    }
  } catch {
    /* một số trình duyệt (Android) không cho tạo Notification trực tiếp: bỏ qua */
  }
}
