// Extension VS Code: chạy Task Board ngay trong VS Code, không cần cài Node hay chạy lệnh.
// - Server Task Board (đã bundle) chạy nền bằng chính file thực thi của VS Code, dùng chung cho mọi cửa sổ.
// - Giao diện web hiện trong một tab (webview chứa iframe trỏ tới server cục bộ).
// - Tự kiểm tra Claude Code (đã cài, đã đăng nhập) và đề xuất thêm workspace đang mở làm project.
import * as vscode from 'vscode'
import { execFile } from 'node:child_process'
import { boardHash, claudeBinInExtension, parseAuthStatus, pickMainBranch, samePath, webviewHtml, type ServerInfo } from './core'
import { ServerManager, type Health } from './serverManager'
import { startClaudeLimitWatch } from './claudeLimitWatch'

// Chuỗi hiển thị viết bằng tiếng Anh; bản dịch tiếng Việt ở l10n/bundle.l10n.vi.json (VS Code tự chọn theo ngôn ngữ).
const t = vscode.l10n.t

const VIEW_TYPE = 'agentTaskBoard.board'
const DECLINED_KEY = 'agentTaskBoard.declinedProject'
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code'

let manager: ServerManager
let output: vscode.OutputChannel
let panel: vscode.WebviewPanel | undefined

const cfg = () => vscode.workspace.getConfiguration('agentTaskBoard')

export function activate(ctx: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Agent Task Board')
  ctx.subscriptions.push(output)

  if (!sqliteAvailable()) {
    void vscode.window.showErrorMessage(
      t('Agent Task Board requires VS Code 1.101 or later (Node with node:sqlite). This version uses Node {0}.', process.versions.node),
    )
    return
  }

  manager = new ServerManager({
    storageDir: ctx.globalStorageUri.fsPath,
    extensionDir: ctx.extensionUri.fsPath,
    version: String(ctx.extension.packageJSON.version ?? '0.0.0'),
    idleMinutes: () => cfg().get<number>('idleShutdownMinutes', 30),
    // Không có cài đặt: lấy CLI đi kèm extension Claude Code (server trong extension không tự quét thư mục editor)
    claudePath: () =>
      cfg().get<string>('claudePath') || claudeBinInExtension(vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)?.extensionPath),
    log: (l) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${l}`),
  })

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  status.text = '$(checklist) Task Board'
  status.tooltip = t('Open Agent Task Board')
  status.command = 'agentTaskBoard.open'
  status.show()
  // Gói Claude hết lượt: thanh trạng thái + thông báo VS Code (cả khi chưa mở tab Task Board)
  ctx.subscriptions.push(startClaudeLimitWatch({ ctx, status, readInfo: () => manager.readInfo(), openBoard: () => openBoard(ctx) }))

  // Khung "Bắt đầu" ở thanh bên: nội dung là viewsWelcome (package.json); mở khung thì mở luôn bảng công việc.
  const home = vscode.window.createTreeView('agentTaskBoard.home', { treeDataProvider: new EmptyTree() })
  let autoOpened = false
  home.onDidChangeVisibility((e) => {
    if (e.visible && !autoOpened) {
      autoOpened = true
      void openBoard(ctx)
    }
  })

  ctx.subscriptions.push(
    status,
    home,
    vscode.commands.registerCommand('agentTaskBoard.open', () => openBoard(ctx)),
    vscode.commands.registerCommand('agentTaskBoard.openSettings', () => openBoard(ctx, 'settings')),
    vscode.commands.registerCommand('agentTaskBoard.openInBrowser', openInBrowser),
    vscode.commands.registerCommand('agentTaskBoard.addWorkspace', () => addWorkspace(ctx)),
    vscode.commands.registerCommand('agentTaskBoard.loginClaude', loginClaude),
    vscode.commands.registerCommand('agentTaskBoard.restartServer', () => restartServer(ctx)),
    vscode.commands.registerCommand('agentTaskBoard.showLogs', () => vscode.window.showTextDocument(vscode.Uri.file(manager.logFile))),
  )
}

export function deactivate() {
  // Cố ý không dừng server: task đang chạy tiếp tục khi đóng cửa sổ; server tự tắt khi rảnh.
}

function sqliteAvailable() {
  try {
    require('node:sqlite')
    return true
  } catch {
    return false
  }
}

class EmptyTree implements vscode.TreeDataProvider<never> {
  getTreeItem(): vscode.TreeItem {
    throw new Error('no items')
  }
  getChildren() {
    return []
  }
}

/** Khởi động (hoặc dùng lại) server, có thông báo tiến trình; lỗi thì báo và trả undefined. */
async function ensureServer(): Promise<ServerInfo | undefined> {
  try {
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: t('Starting Task Board…') },
      () => manager.ensure(),
    )
  } catch (e) {
    const msg = (e as Error).message
    output.appendLine(msg)
    const pick = await vscode.window.showErrorMessage(t('Could not start Task Board: {0}', msg.split('\n')[0]), t('Show log'))
    if (pick) output.show()
    return undefined
  }
}

async function api<T>(info: ServerInfo, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

/** URL giao diện; `lang` theo ngôn ngữ hiển thị của VS Code để giao diện web dùng cùng ngôn ngữ. */
async function boardUrl(info: ServerInfo, hash: string) {
  const base = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${info.port}/`))
  return `${base.toString(true).replace(/#.*$/, '')}?lang=${encodeURIComponent(vscode.env.language)}${hash}`
}

async function openBoard(ctx: vscode.ExtensionContext, page?: 'settings') {
  const info = await ensureServer()
  if (!info) return
  const projectId = page ? undefined : await workspaceProject(ctx, info, false)
  const url = await boardUrl(info, boardHash(projectId, page))
  if (panel) {
    panel.webview.html = webviewHtml(url)
    panel.reveal()
  } else {
    panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Task Board', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    })
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'activity.svg')
    panel.webview.html = webviewHtml(url)
    panel.onDidDispose(() => (panel = undefined))
  }
  void checkClaude(ctx, info)
}

async function openInBrowser() {
  const info = await ensureServer()
  if (info) await vscode.env.openExternal(vscode.Uri.parse(await boardUrl(info, '#/')))
}

async function restartServer(ctx: vscode.ExtensionContext) {
  const ok = await vscode.window.showWarningMessage(
    t('Restart the Task Board server? Running tasks will be stopped (you can resume them later).'),
    { modal: true },
    t('Restart'),
  )
  if (!ok) return
  await manager.stop()
  if (panel) await openBoard(ctx)
  else await ensureServer()
}

// ------------------------------------------------------------------ Claude Code

function run(file: string, args: string[], cwd?: string) {
  // File .cmd (Claude cài bằng npm trên Windows) phải chạy qua cmd.exe
  const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
  const [f, a] = viaCmd ? ['cmd.exe', ['/d', '/s', '/c', `"${[`"${file}"`, ...args].join(' ')}"`]] : [file, args]
  return new Promise<string>((res, rej) =>
    execFile(f, a, { cwd, timeout: 20_000, windowsHide: true, encoding: 'utf8', windowsVerbatimArguments: viaCmd }, (err, stdout) =>
      err ? rej(err) : res(stdout),
    ),
  )
}

let claudeChecked = false

/** Kiểm tra một lần mỗi phiên: có Claude Code chưa, đã đăng nhập chưa (bỏ qua nếu đang dùng API key). */
async function checkClaude(ctx: vscode.ExtensionContext, info: ServerInfo) {
  if (claudeChecked) return
  claudeChecked = true
  const h: Health | undefined = await manager.health(info)
  if (!h || h.authMode === 'apiKey') return
  if (!h.claude?.found || !h.claude.path) {
    const install = t('Install Claude Code')
    const useKey = t('Use API key')
    const pick = await vscode.window.showWarningMessage(
      t('Claude Code was not found on this machine. Install the Claude Code extension (it includes the CLI), or use an Anthropic API key.'),
      install,
      useKey,
    )
    if (pick === install) await vscode.commands.executeCommand('workbench.extensions.search', CLAUDE_EXTENSION_ID)
    if (pick === useKey) await openBoard(ctx, 'settings')
    claudeChecked = false // kiểm tra lại lần mở sau
    return
  }
  let status
  try {
    status = parseAuthStatus(await run(h.claude.path, ['auth', 'status']))
  } catch (e) {
    // `claude auth status` trả mã lỗi khi chưa đăng nhập; vẫn đọc JSON trong stdout nếu có
    status = parseAuthStatus(String((e as { stdout?: string }).stdout ?? ''))
  }
  if (!status || status.loggedIn) return
  const signIn = t('Sign in')
  const useKey = t('Use API key')
  const pick = await vscode.window.showWarningMessage(
    t('Claude Code is not signed in. Sign in with your Claude account (Pro/Max), or use an API key.'),
    signIn,
    useKey,
  )
  if (pick === signIn) await loginClaude()
  if (pick === useKey) await openBoard(ctx, 'settings')
  claudeChecked = false
}

/** Mở terminal chạy `claude auth login` bằng file CLI mà server tìm thấy. */
async function loginClaude() {
  const info = await ensureServer()
  if (!info) return
  const h = await manager.health(info)
  if (!h?.claude?.found || !h.claude.path) {
    void vscode.window.showWarningMessage(t('Claude Code was not found. Install the Claude Code extension first.'))
    return
  }
  const term = vscode.window.createTerminal({ name: t('Claude Code: sign in'), shellPath: h.claude.path, shellArgs: ['auth', 'login'] })
  term.show()
}

// ------------------------------------------------------------------ project theo workspace

interface ProjectLite {
  id: string
  name: string
  repoPath: string
}

async function gitToplevel(dir: string) {
  try {
    return (await run('git', ['rev-parse', '--show-toplevel'], dir)).trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Project ứng với workspace đang mở. Chưa có: hỏi người dùng có thêm không (trừ khi đã từ chối với workspace này,
 * hoặc `force` từ lệnh "Thêm workspace").
 */
async function workspaceProject(ctx: vscode.ExtensionContext, info: ServerInfo, force: boolean): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? []
  if (!folders.length) {
    if (force) void vscode.window.showInformationMessage(t('Open a folder in VS Code first.'))
    return undefined
  }
  let projects: ProjectLite[]
  try {
    projects = (await api<{ projects: ProjectLite[] }>(info, '/api/state')).projects
  } catch (e) {
    output.appendLine(`Could not read the project list: ${(e as Error).message}`)
    return undefined
  }
  // Git không bắt buộc: project mới ghi output thẳng vào thư mục (deliveryMode 'direct').
  // Thư mục nằm trong git repo thì dùng gốc repo; không thì dùng chính thư mục workspace.
  const roots: { name: string; top: string; git: boolean }[] = []
  for (const f of folders) {
    const gitTop = await gitToplevel(f.uri.fsPath)
    const top = gitTop ?? f.uri.fsPath
    const existing = projects.find((p) => samePath(p.repoPath, top))
    if (existing) {
      if (force) void vscode.window.showInformationMessage(t('"{0}" is already on the Task Board.', existing.name))
      return existing.id
    }
    roots.push({ name: f.name, top, git: !!gitTop })
  }
  if (!roots.length) return undefined
  const target = roots[0]
  if (!force && ctx.workspaceState.get<string>(DECLINED_KEY) === target.top) return undefined
  if (!force) {
    const add = t('Add')
    const no = t('No')
    const pick = await vscode.window.showInformationMessage(
      t('Add "{0}" to the Task Board so you can assign work to Claude?', target.name),
      add,
      no,
    )
    if (pick !== add) {
      if (pick === no) await ctx.workspaceState.update(DECLINED_KEY, target.top)
      return undefined
    }
  }
  try {
    let mainBranch = 'main'
    if (target.git) {
      const branches = (await run('git', ['branch', '--format=%(refname:short)'], target.top)).split(/\r?\n/)
      const current = await run('git', ['branch', '--show-current'], target.top).catch(() => '')
      mainBranch = pickMainBranch(branches, current)
    }
    const p = await api<ProjectLite>(info, '/api/projects', {
      method: 'POST',
      // Output ghi thẳng vào thư mục workspace; đổi sang nhánh riêng cho từng task ở trang Projects nếu cần
      body: JSON.stringify({ name: target.name, repoPath: target.top, mainBranch, deliveryMode: 'direct' }),
    })
    await ctx.workspaceState.update(DECLINED_KEY, undefined)
    void vscode.window.showInformationMessage(t('Added project "{0}". You can adjust permissions and budget on the Projects page.', p.name))
    return p.id
  } catch (e) {
    void vscode.window.showErrorMessage(t('Could not add the project: {0}', (e as Error).message))
    return undefined
  }
}

async function addWorkspace(ctx: vscode.ExtensionContext) {
  const info = await ensureServer()
  if (!info) return
  const id = await workspaceProject(ctx, info, true)
  if (id) {
    const url = await boardUrl(info, boardHash(id))
    if (panel) panel.webview.html = webviewHtml(url)
    else await openBoard(ctx)
  }
}
