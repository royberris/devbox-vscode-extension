# Constraints and findings

## The agent must not run in the extension host

A process started by the extension itself stops after `remote.SSH.reconnectionGraceTime` (3 hours by default) without a connection. A pending permission prompt is lost then, and it is not asked again on resume. Only processes in tmux (or another terminal multiplexer) survive indefinitely.

**Consequence:** the extension is a **UI over tmux sessions** (R3, R4).

## Terminals must not land in the shared session

If the default terminal profile attaches every terminal to one shared tmux session, any terminal the extension creates would end up there too. The extension must pass its own `shellPath`/`shellArgs`, e.g. `tmux attach -t <session>`.

For the same reason, the Claude Code extension's *Use Terminal* option (`claudeCode.useTerminal`) is not suitable. It types `claude` into a new default terminal, which then lands in the shared session, possibly inside a Claude session that is already running there.

## Leftover processes after reconnecting

The Claude Code VS Code extension sometimes leaves old `claude` processes behind after a reconnect. The process overview (R10) must make these visible.

Codex deliberately starts a detached background process (`codex app-server --managed-daemon`, with systemd as parent). It is not an orphan and must not be reported as one.

## Where worktrees go

- **Not inside the repository** (e.g. under `.git/` or `.claude/`). Tools that search upwards, such as `Directory.Build.props` in .NET solutions, `tsconfig.json` and `pnpm-workspace.yaml`, would then find the main repository's files.
- **Not below a repo root,** or a workspace generator that scans the roots treats it as a repository. If it has to be there, those tools must skip that folder.

## Agents create placeholder folders

Agents sometimes create empty folders in their working directory (`.agents`, `.aws`, `.codex`, `.git/config.worktree`). So always start agents in a repository or worktree, never in a repo root.

## Worktrees the agents create themselves

Both CLIs can create a worktree on their own. Measured with Claude Code 2.1 and current Codex:

| | Command | Location | Branch | Notes |
|---|---|---|---|---|
| Claude Code | `claude -w [name]` (optionally `--tmux`) | `<repo>/.claude/worktrees/<name>` | `worktree-<name>` | Locked while in use. Shows up as untracked `.claude/` in the main repository unless ignored. `claude rm <id>` removes it "when that is safe". |
| Codex | `codex --worktree` | `<CODEX_HOME>/worktrees/<id>/<repo>` | detached HEAD | Outside the repository. |

Claude's location conflicts with the rule above (inside the repository), and with R14 if `.claude/` is not globally ignored.

## Agent sandbox and worktrees

A commit in a worktree writes to the *main* repository's `.git` directory. A sandbox that only allows writes below the working directory blocks this, unless the repositories' `.git` directories are writable.

## Rejected alternative: Zed

Zed (1.22, ACP agents) starts agents over its own SSH channel from the laptop, so they stop when the connection drops (fails R3). Its worktree-per-thread UX, where clicking a thread opens its worktree, is the reference for R5 and R6.
