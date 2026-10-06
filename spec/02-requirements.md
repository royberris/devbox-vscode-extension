# Requirements

## Basics

- **R1. One app, one UI.** Editor, terminal and agents all live in VS Code, connected to the dev box.
- **R2. Agents run on the server, with the server's configuration.** Native `claude` and `codex`, with the server's deny rules, sandbox and logins. Nothing runs locally.
- **R3. Keep running while you're away.** If the laptop is closed or the connection drops, the agent keeps working, with no time limit.
- **R4. Come back to where you were.** After reconnecting you see the running session live again, including what happened in the meantime.

## Sessions and worktrees

- **R5. Every agent session gets its own git worktree,** e.g. a new session for repository *X* runs in its own worktree of *X*.
- **R6. The file system follows your focus.** When you focus a session, the explorer and editor show that session's worktree.
- **R7. Several agents at once,** Claude and Codex mixed, each in its own session and worktree.
- **R8. Start a new session in one action:** choose the agent. The name is generated, the base branch defaults to `main`, and the repository to the last one used; all three can be changed in the same view.
- **R9. Clean up when done:** remove the worktree, but only when it has no uncommitted changes. Otherwise refuse and say why.

## Overview and history

- **R10. Overview of all running agents:** PID, start time, working directory and origin (which session, or orphaned).
- **R11. Find hanging or orphaned processes, but never kill them automatically.**
- **R12. History of chats, including past sessions, and the ability to resume them.**
- **R13. Notify the user when an agent waits for them** (permission or question), so nothing silently stalls while they are away.

## Hygiene

- **R14. No tool files in the repositories.** The extension keeps its state outside the repository, or in files that are ignored globally (e.g. `~/.config/git/ignore`).
- **R15. See the agent's diffs in the editor,** via Claude Code's `/ide` connection from the CLI session.

## Repositories

- **R16. Repository overview** with branch, uncommitted changes and missing dependencies, from which an agent can be started directly on the main checkout (no worktree), e.g. to install dependencies.
- **R17. Add a repository from the UI:** clone it on the server, optionally with an alias for session names.
