// Bản nháp review của một task: nhận xét chưa gửi và các file đã đánh dấu "Đã xem".
// Lưu trong localStorage của trình duyệt (tải lại trang không mất); lỗi storage thì chỉ giữ trong bộ nhớ.
import { useCallback, useEffect, useState } from 'react'
import type { ReviewComment } from '../types'

export interface ReviewDraft {
  comments: ReviewComment[]
  /** path → chữ ký nội dung diff lúc đánh dấu (file đổi thì không còn tính là đã xem) */
  viewed: Record<string, string>
}

const EMPTY: ReviewDraft = { comments: [], viewed: {} }
const key = (taskId: number) => `taskboard.reviewDraft.${taskId}`

function load(taskId: number): ReviewDraft {
  try {
    const raw = localStorage.getItem(key(taskId))
    if (!raw) return EMPTY
    const d = JSON.parse(raw) as Partial<ReviewDraft>
    return { comments: Array.isArray(d.comments) ? d.comments : [], viewed: d.viewed && typeof d.viewed === 'object' ? d.viewed : {} }
  } catch {
    return EMPTY
  }
}

function save(taskId: number, d: ReviewDraft) {
  try {
    if (!d.comments.length && !Object.keys(d.viewed).length) localStorage.removeItem(key(taskId))
    else localStorage.setItem(key(taskId), JSON.stringify(d))
  } catch {
    /* storage bị chặn: bỏ qua */
  }
}

const newId = () => Math.random().toString(36).slice(2, 10)

export function useReviewDraft(taskId: number | undefined) {
  const [draft, setDraft] = useState<ReviewDraft>(() => (taskId === undefined ? EMPTY : load(taskId)))
  useEffect(() => setDraft(taskId === undefined ? EMPTY : load(taskId)), [taskId])

  const update = useCallback(
    (fn: (d: ReviewDraft) => ReviewDraft) =>
      setDraft((d) => {
        const next = fn(d)
        if (taskId !== undefined) save(taskId, next)
        return next
      }),
    [taskId],
  )

  return {
    comments: draft.comments,
    viewed: draft.viewed,
    addComment: (c: Omit<ReviewComment, 'id'>) => update((d) => ({ ...d, comments: [...d.comments, { ...c, id: newId() }] })),
    editComment: (id: string, text: string) =>
      update((d) => ({ ...d, comments: d.comments.map((c) => (c.id === id ? { ...c, text } : c)) })),
    removeComment: (id: string) => update((d) => ({ ...d, comments: d.comments.filter((c) => c.id !== id) })),
    setViewed: (path: string, sig: string | null) =>
      update((d) => {
        const viewed = { ...d.viewed }
        if (sig === null) delete viewed[path]
        else viewed[path] = sig
        return { ...d, viewed }
      }),
    clear: () => update(() => EMPTY),
  }
}

export type ReviewDraftApi = ReturnType<typeof useReviewDraft>
