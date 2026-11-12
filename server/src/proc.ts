// Tiện ích tiến trình dùng chung (runner Claude, chạy test).
import { execFile } from 'node:child_process'

/** Dừng tiến trình và toàn bộ tiến trình con (Windows: taskkill /T /F). */
export function killTree(pid: number) {
  return new Promise<void>((res) => {
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => res())
    else {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* đã thoát */
      }
      res()
    }
  })
}
