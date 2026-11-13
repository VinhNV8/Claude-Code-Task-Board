import { Component, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'

/** Bắt lỗi hiển thị của một trang: hiện thông báo thay vì để cả ứng dụng trắng trơn. Đổi `resetKey` (chuyển trang) thì thử lại. */
export class ErrorBoundary extends Component<{ resetKey?: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('Lỗi hiển thị trang:', error)
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-2 px-6 py-12 text-center">
        <TriangleAlert size={40} className="text-amber-500" />
        <p className="font-medium text-slate-700 dark:text-slate-200">Trang này gặp lỗi khi hiển thị</p>
        <p className="text-sm text-slate-500 dark:text-slate-400">Dữ liệu của bạn vẫn an toàn. Thử tải lại trang, nếu vẫn lỗi hãy gửi nội dung bên dưới cho người phát triển.</p>
        <pre className="mt-1 max-w-full overflow-x-auto rounded bg-slate-100 px-3 py-2 text-left text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">{error.message}</pre>
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => this.setState({ error: null })}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Thử lại
          </button>
          <button onClick={() => window.location.reload()} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">
            Tải lại trang
          </button>
        </div>
      </div>
    )
  }
}
