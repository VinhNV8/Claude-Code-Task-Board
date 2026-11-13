# Changelog

## Unreleased

- Reviewing a task now means accepting its output; merging is a separate, optional action. Rejecting no longer deletes the output.
- New projects write output straight into the project folder (no git required). The previous per-task branch mode is still available on the Projects page; existing projects keep it.
- Adding the open workspace as a project no longer requires a git repository.
- The extension finds the Claude Code CLI through VS Code's extension API instead of scanning editor folders in your home directory.
- Testing an API key now makes one direct HTTPS request to the Anthropic API; the Anthropic SDK is no longer bundled (smaller download).

## 0.1.0

- First release: run the Task Board inside VS Code (no Node install needed).
- Finds Claude Code automatically (the Claude Code extension or `claude` on PATH) and checks that you are signed in.
- Offers to add the open workspace as a project.
- One server shared by all windows; tasks keep running when you close a window; the server stops itself when idle.
- English and Vietnamese extension UI (follows VS Code's display language).
