# Agent Task Board

A task board inside VS Code for handing work to **Claude Code**. By default Claude writes its output straight into your project folder (no git needed); you review the changes, then accept the output or ask for changes. Projects can instead give each task its own local git branch (worktree) and run several tasks in parallel; merging stays with you and your own process. You approve permissions when Claude wants to run a command and track spending per project.

> This is an independent extension. It is **not made, sponsored or endorsed by Anthropic**. "Claude" and "Claude Code" are trademarks of Anthropic and are used here only to say which tool the extension works with. The extension runs the Claude Code you installed and signed in to yourself, or uses your own Anthropic API key.

[Tiếng Việt](https://github.com/VinhNV8/Claude-Code-Task-Board/blob/main/vscode-extension/README.vi.md)

## Getting started

1. Install the extension.
2. Click the **Agent Task Board** icon in the Activity Bar.
3. If the open workspace is a git repository, the extension offers to add it as a project. Choose **Add**.
4. Create a task, describe what you want done, and run it.

You don't need to install Node or run any commands. The extension runs its server with VS Code itself.

## Requirements

- VS Code 1.101 or later.
- **git**.
- One of these ways to authenticate:
  - **Claude Code, signed in** (Pro/Max plan). Install the [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code), which includes the CLI, or install the `claude` CLI, then sign in. The extension finds the CLI automatically and tells you if you aren't signed in. You can also run **Agent Task Board: Sign in to Claude Code**.
  - **An Anthropic API key** (billed per token). Open **Settings → Claude authentication**, paste the key and click Test. In this mode each project's monthly budget is a hard limit.

## Commands

| Command | What it does |
|---|---|
| Agent Task Board: Open Task Board | Opens the board, filtered to the workspace's project |
| Agent Task Board: Add this workspace as a project | Adds the open git repository |
| Agent Task Board: Settings | Claude authentication, notifications, defaults |
| Agent Task Board: Open in browser | Opens the same board in your browser |
| Agent Task Board: Sign in to Claude Code | Opens a terminal running `claude auth login` |
| Agent Task Board: Restart server | Stops and restarts the server (running tasks are stopped) |
| Agent Task Board: Show server log | Opens the log file |

## Settings

| Key | Default | Meaning |
|---|---|---|
| `agentTaskBoard.claudePath` | (detected) | Path to the Claude Code CLI executable |
| `agentTaskBoard.idleShutdownMinutes` | `30` | Minutes of inactivity before the server stops; `0` keeps it running |

## How it works

- A background server listens on `127.0.0.1` on a random port. All VS Code windows share it, so closing a window doesn't stop running tasks.
- The server stops by itself when no window has the board open and nothing is running, waiting or scheduled.
- Data (database, snapshots, worktrees, logs) lives in the extension's own storage folder. Task output goes to your project folder (default) or to local `claude/task-<id>` branches (worktree mode); the Task Board never merges unless you click Merge.
- Your code is sent to Anthropic by Claude Code, under your own account or API key. The extension sends data nowhere else. Telegram notifications are sent only if you turn them on.

## Language

The extension follows VS Code's display language (English and Vietnamese). The board itself is being translated to English; parts of it may still be in Vietnamese in this version.

## Known limitations

- Inside the VS Code panel, some copy/paste shortcuts may not work in the board (a limitation of iframes inside webviews). Use **Open in browser** if you need them.
- With Remote (SSH/WSL), the server runs on the remote machine; the HTML preview uses an extra port that isn't forwarded yet.

## Feedback

Report bugs and ideas at [GitHub Issues](https://github.com/VinhNV8/Claude-Code-Task-Board/issues).
