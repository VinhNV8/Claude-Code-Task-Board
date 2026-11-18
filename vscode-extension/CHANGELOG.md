# Changelog

## 0.1.1

- Security: the local server now rejects requests from other websites. Requests with an unexpected `Host` header (DNS rebinding) are refused. Write requests and WebSocket connections whose `Origin` is not the server itself are refused too.
- When Claude Code is missing, the warning now says that API key mode also needs the Claude Code CLI. It offers to install Claude Code or set the CLI path, instead of suggesting an API key.
- The board's name is now "Agent Task Board" everywhere (page title, logo label).
- Security: in API key mode, the key is no longer passed to Claude in an environment variable, so commands Claude runs (Bash, npm scripts, hooks) can't read it with `env`. Claude Code fetches the key through `apiKeyHelper` instead, with a token that works only while that task is running.
- Security: review and HTML preview no longer follow symlinks or junctions that point outside the task folder. Before this, a repository could link a file to something like `~/.ssh/id_rsa` and expose it.

- Reviewing a task now means accepting its output; merging is a separate, optional action. Rejecting no longer deletes the output.
- New projects write output straight into the project folder (no git required). The previous per-task branch mode is still available on the Projects page; existing projects keep it.
- Adding the open workspace as a project no longer requires a git repository.
- The extension finds the Claude Code CLI through VS Code's extension API instead of scanning editor folders in your home directory.
- Delete tasks that have not run yet (Backlog, Queued) or that failed or were stopped, from the task view.
- Removed the "Test key" button: the Task Board no longer calls the Anthropic API itself. An invalid key is reported on the first task run. The Anthropic SDK is no longer bundled (smaller download).
- New default prompt templates: "Improve", "Code review", "Explore code", and six requirement templates (clarify, user stories, spec, task breakdown, impact analysis, requirement vs. code check).
- The new/edit task form is wider and lays its fields out in three columns, so it needs less scrolling. Prompt templates sit on their own line under the description label, so many templates no longer break the layout. New default templates are added to existing installs too; defaults you deleted are not brought back.

## 0.1.0

- First release: run the Task Board inside VS Code (no Node install needed).
- Finds Claude Code automatically (the Claude Code extension or `claude` on PATH) and checks that you are signed in.
- Offers to add the open workspace as a project.
- One server shared by all windows; tasks keep running when you close a window; the server stops itself when idle.
- English and Vietnamese extension UI (follows VS Code's display language).
