// Khởi động / dùng lại server Task Board chạy nền (một server cho mọi cửa sổ VS Code).
// Server chạy tách rời (detached) để task vẫn chạy khi đóng cửa sổ; tự tắt khi rảnh (TASKBOARD_IDLE_EXIT_MIN).
import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freePort, parseServerInfo, serverEnv, tail, type ServerInfo } from './core'

export interface ManagerOptions {
  storageDir: string
  /** Thư mục cài extension (chứa dist/server, dist/web). */
  extensionDir: string
  version: string
  idleMinutes: () => number
  claudePath: () => string | undefined
  log: (line: string) => void
}

export interface Health {
  ok: boolean
  pid?: number
  version?: string
  authMode?: 'subscription' | 'apiKey'
  claude?: { found: boolean; path?: string; source?: string; version?: string }
}

const START_TIMEOUT_MS = 30_000
const LOG_MAX_BYTES = 5 * 1024 * 1024

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class ServerManager {
  private starting: Promise<ServerInfo> | undefined
  constructor(private o: ManagerOptions) {
    mkdirSync(o.storageDir, { recursive: true })
  }

  get infoFile() {
    return join(this.o.storageDir, 'server.json')
  }
  get logFile() {
    return join(this.o.storageDir, 'server.log')
  }
  private get lockFile() {
    return join(this.o.storageDir, 'server.lock')
  }

  readInfo() {
    try {
      return parseServerInfo(readFileSync(this.infoFile, 'utf8'))
    } catch {
      return undefined
    }
  }

  async health(info: Pick<ServerInfo, 'port'>, timeoutMs = 2000): Promise<Health | undefined> {
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return undefined
      return (await res.json()) as Health
    } catch {
      return undefined
    }
  }

  /** Server đang chạy và đúng là server mình ghi trong server.json (cùng pid). */
  private async alive(info: ServerInfo) {
    const h = await this.health(info)
    return !!h?.ok && h.pid === info.pid
  }

  /** Trả server đang chạy (dùng lại nếu được), hoặc khởi động mới. Gọi đồng thời chỉ khởi động một lần. */
  ensure(): Promise<ServerInfo> {
    this.starting ??= this.ensureInner().finally(() => (this.starting = undefined))
    return this.starting
  }

  private async ensureInner(): Promise<ServerInfo> {
    const cur = this.readInfo()
    if (cur && (await this.alive(cur))) {
      if (cur.version === this.o.version) return cur
      this.o.log(`Server version ${cur.version} differs from extension ${this.o.version}: restarting.`)
      await this.kill(cur.pid)
    }
    // Cửa sổ khác đang khởi động: chờ nó xong rồi dùng chung
    if (!this.takeLock()) {
      const deadline = Date.now() + START_TIMEOUT_MS
      while (Date.now() < deadline) {
        await sleep(500)
        const info = this.readInfo()
        if (info && info.version === this.o.version && (await this.alive(info))) return info
        if (!existsSync(this.lockFile)) break
      }
      rmSync(this.lockFile, { force: true })
      if (!this.takeLock()) throw new Error('Could not start the server: another VS Code window holds the startup lock.')
    }
    try {
      return await this.start()
    } finally {
      rmSync(this.lockFile, { force: true })
    }
  }

  /** Khoá khởi động (file tạo độc quyền). Khoá cũ quá 60 giây coi như bị bỏ dở. */
  private takeLock() {
    try {
      if (existsSync(this.lockFile) && Date.now() - statSync(this.lockFile).mtimeMs > 60_000) rmSync(this.lockFile, { force: true })
      writeFileSync(this.lockFile, String(process.pid), { flag: 'wx' })
      return true
    } catch {
      return false
    }
  }

  private async start(): Promise<ServerInfo> {
    const dist = join(this.o.extensionDir, 'dist')
    const entry = join(dist, 'server', 'index.mjs')
    if (!existsSync(entry)) throw new Error(`Missing ${entry}. Build the extension first (npm run build).`)
    const port = await freePort()
    let previewPort = await freePort()
    if (previewPort === port) previewPort = await freePort()

    // Log mới mỗi lần khởi động nếu file đã quá lớn
    const big = existsSync(this.logFile) && statSync(this.logFile).size > LOG_MAX_BYTES
    const fd = openSync(this.logFile, big ? 'w' : 'a')
    const env = serverEnv(process.env, {
      port,
      previewPort,
      dataDir: this.o.storageDir,
      webDist: join(dist, 'web'),
      bundleDir: join(dist, 'server'),
      version: this.o.version,
      idleMinutes: this.o.idleMinutes(),
      claudePath: this.o.claudePath(),
      electron: !!process.versions.electron,
    })
    this.o.log(`Starting server: port ${port}, data ${this.o.storageDir}`)
    const child = spawn(process.execPath, [entry], {
      cwd: this.o.storageDir,
      env,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    })
    closeSync(fd)
    let exited: number | null | undefined
    child.once('exit', (code) => (exited = code))
    child.unref()
    if (!child.pid) throw new Error('Could not create the server process.')
    const info: ServerInfo = { pid: child.pid, port, previewPort, version: this.o.version, startedAt: Date.now() }

    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (exited !== undefined) break
      if (await this.alive(info)) {
        writeFileSync(this.infoFile, JSON.stringify(info, null, 2))
        this.o.log(`Server ready (pid ${info.pid}).`)
        return info
      }
      await sleep(300)
    }
    if (exited === undefined) await this.kill(info.pid)
    let log = ''
    try {
      log = tail(readFileSync(this.logFile, 'utf8'))
    } catch {
      /* không có log */
    }
    throw new Error(`Server failed to start${exited != null ? ` (exit code ${exited})` : ' (timed out)'}.\n${log}`)
  }

  /** Dừng server đang chạy (cả tiến trình Claude con). */
  async stop() {
    const info = this.readInfo()
    if (info && (await this.alive(info))) await this.kill(info.pid)
    rmSync(this.infoFile, { force: true })
  }

  private kill(pid: number) {
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
    }).then(() => sleep(300))
  }
}
