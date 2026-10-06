# Architecture

## One tmux session per agent session

Starting a session takes one picker: a random, editable name, the agents as choices, and the repository and base branch (default `origin/main`) as defaults that can be changed. Then the extension:

1. Create a worktree: `<worktreesRoot>/<repo>/<name>` on a new branch `<branchPrefix><name>`, with `--no-track` so it never pushes to the base branch.
2. Create a detached tmux session in it, named `<repo-alias>-<name>`.
3. Run `claude` or `codex` in it, in a login shell. When the agent exits, the shell stays open.

The extension tags the session with tmux user options (`@devbox_agent`, `@devbox_repo`, `@devbox_worktree`, `@devbox_branch`, `@devbox_base`). It sets `DEVBOX_AGENTS_SESSION=<name>` in the session's environment, so hooks can tell which session they belong to.

This covers R2, R3, R5, R7 and R8.

## State is read from the server, not stored by the extension

On every refresh the extension reads:

- `tmux list-sessions` / `list-panes`: sessions, their tags, pane PIDs and working directories;
- `git worktree list` for each repository;
- the process tree from `/proc`. Each `claude`/`codex` process is classified by its executable, and its origin is found by walking up its parents: tmux pane, sshd, VS Code server, init/systemd (orphan) or the Codex daemon.

Because nothing is kept in the extension, reconnecting shows exactly what is running (R4, R10, R11, R14).

## Focusing a session

Focusing a session does three things:

- It opens a terminal with `tmux attach -t =<session>`, using an explicit `shellPath`, so the default profile is bypassed.
- It shows the worktree in the explorer: it replaces the previous agent worktree folder, adds a folder, or opens a new window, depending on a setting. It never touches workspace folder 0, because changing that restarts the extension host.
- Optionally it types `/ide` into a Claude session, so diffs show in the editor (R15).

This covers R6 and R15.

## Cleaning up

Cleaning up runs `git status --porcelain` on the worktree; any output means refusal. After confirmation it kills the tmux session and runs `git worktree remove` without `--force`, so git refuses as well if something changed in between. The branch is kept. This covers R9.

## History

The extension reads the agents' own transcript files: the head and tail of each file, for the ID, working directory and title. Titles are taken from Claude's `ai-title`/`custom-title`, Codex's `session_index.jsonl`, or else the first real prompt. Chats are grouped by repository or worktree.

Resuming a chat runs `claude --resume <id>` / `codex resume <id>` in a new tmux session in the chat's original directory. If the chat is already running, that session is focused instead. This covers R12.

## Waiting agents

A hook script, which needs only bash, writes the raw hook payload to `~/.local/state/devbox-agents/status/<key>.json`. The extension watches that directory and works out the state:

| Source | Event | State |
|---|---|---|
| Claude Code hooks | `Notification` (permission) | waiting |
| Claude Code hooks | `Notification` (idle), `Stop` | idle |
| Claude Code hooks | `UserPromptSubmit`, `PostToolUse` | running |
| Codex `notify` | `agent-turn-complete` | idle |

A waiting agent gives a notification, a badge and a status bar counter. On reconnect the user gets one summary. The hooks are installed on request, merged into the existing configuration, with a backup. This covers R13.

## Code layout

- `src/core/`: tmux, git, `/proc`, history and status. Plain Node, no `vscode` import, unit tested.
- `src/`: the VS Code layer, with views, commands and notifications.
