# Installing Agent Task Board

Agent Task Board is a VS Code extension for handing work to Claude Code from a task board. It is distributed as a **`.vsix`** file (for example `agent-task-board-0.1.1.vsix`) on the [Releases](https://github.com/VinhNV8/Claude-Code-Task-Board/releases) page. It is not on the VS Code Marketplace.

[Tiếng Việt](INSTALL.vi.md)

## 1. Before you start

- **VS Code 1.101 or later.** Check with **Help → About** (macOS: **Code → About Visual Studio Code**). If yours is older, use **Help → Check for Updates**.
- **Claude Code, signed in.** The easiest way:
  1. In VS Code, open **Extensions** (`Ctrl+Shift+X`, macOS: `Cmd+Shift+X`).
  2. Search for **Claude Code**, pick the one published by **Anthropic**, and click **Install**.
  3. Open Claude Code and sign in with your Claude account (Pro or Max plan).

  If you use an Anthropic API key instead of a Claude account, you still need Claude Code installed (steps 1–2), but you don't need to sign in. Enter the key after installing (see section 3).
- **Git** (optional): only needed if you want each task to run on its own branch. By default, tasks write straight into your project folder. Get it from https://git-scm.com.

## 2. Install the `.vsix` file

### Download
Open [Releases](https://github.com/VinhNV8/Claude-Code-Task-Board/releases), pick the latest release, and download `agent-task-board-<version>.vsix` under **Assets**.

To check that the file wasn't altered, compare its SHA-256 with the `.vsix.sha256` file next to it. Windows: `certutil -hashfile agent-task-board-0.1.1.vsix SHA256`. macOS/Linux: `shasum -a 256 agent-task-board-0.1.1.vsix`.

### Option 1: From the VS Code UI (recommended)
1. Save the `.vsix` file, for example in **Downloads**.
2. Open VS Code.
3. Open **Extensions** (`Ctrl+Shift+X`, macOS: `Cmd+Shift+X`).
4. Click **`…`** (Views and More Actions) at the top right of the Extensions view.
5. Choose **Install from VSIX…**.
6. Select the `.vsix` file and click **Install**.
7. Click **Reload** if VS Code asks.

You can also drag the `.vsix` file onto the Extensions view.

### Option 2: From the command line
Open a terminal in the folder that holds the file and run:
```
code --install-extension agent-task-board-0.1.1.vsix
```
If `code` isn't found: in VS Code press `Ctrl+Shift+P` (macOS: `Cmd+Shift+P`), run **Shell Command: Install 'code' command in PATH**, then try again. On Windows, `code` is usually available already.

## 3. Getting started

1. Open your project folder in VS Code (**File → Open Folder…**).
2. Click the **Agent Task Board** icon (three columns) in the Activity Bar. The board opens in a tab.
3. The extension offers to add the open folder as a project. Choose **Add**.
4. Click **New task**, describe what you want done, and run it.
5. When Claude needs permission to run a command, the task waits. Review the request and allow or deny it.
6. When the task is done, review the changes and accept them.

**Using an API key instead of a Claude account:** press `Ctrl+Shift+P`, run **Agent Task Board: Settings**, open **Claude authentication**, paste the key and click **Save**. An invalid key is reported on the first task run. API usage is billed to your Anthropic account.

**Language:** the extension follows VS Code's display language. Change the board's language under **Settings → Language** on the board.

## 4. Updating

Extensions installed from a file **don't update automatically**. Watch the [Releases](https://github.com/VinhNV8/Claude-Code-Task-Board/releases) page (on GitHub: **Watch → Custom → Releases**), download the new `.vsix`, and install it as in section 2. The new version replaces the old one; your tasks and projects are kept. Reload or restart VS Code afterwards.

## 5. Uninstalling

Open **Extensions**, find **Agent Task Board**, click the gear icon and choose **Uninstall**.

Or from the command line:
```
code --uninstall-extension vinhnguyen.agent-task-board
```

## 6. Troubleshooting

| Problem | What to do |
|---|---|
| "requires VS Code 1.101 or later", or the install fails | Update VS Code (**Help → Check for Updates**) |
| "Claude Code was not found" | Install Anthropic's **Claude Code** extension (section 1), then run **Agent Task Board: Restart server** |
| "Claude Code is not signed in" | Click **Sign in** in the notification, or `Ctrl+Shift+P` → **Agent Task Board: Sign in to Claude Code** |
| The board is blank or won't open | `Ctrl+Shift+P` → **Agent Task Board: Restart server**. If that doesn't help, run **Agent Task Board: Show server log** and include the log when you [report the problem](https://github.com/VinhNV8/Claude-Code-Task-Board/issues) |
| Copy/paste doesn't work in the board | `Ctrl+Shift+P` → **Agent Task Board: Open in browser** to use the board in your browser |

**Cursor, Windsurf and other editors based on VS Code:** install with Option 1 in section 2. The editor must be based on VS Code 1.101 or later.

## Notes
- This is an independent extension. It is not made, sponsored or endorsed by Anthropic.
- Claude Code sends your code to Anthropic under your own account or API key. The extension sends data nowhere else, except Telegram notifications if you turn them on.
- Only install `.vsix` files from the official [Releases](https://github.com/VinhNV8/Claude-Code-Task-Board/releases) page or another source you trust.
