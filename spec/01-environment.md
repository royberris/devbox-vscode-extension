# Environment

The extension targets the following setup. Every path and command in it is configurable, so the names below are examples, not requirements.

## The dev box

- A Linux machine (e.g. a cloud VM) that you reach over SSH, for example `ssh devbox`.
- Repositories are checked out below one or more roots, for example `~/repos/<org>/<repo>`.
- The user has **no passwordless sudo**. The extension must not need anything that requires root.
- The box may be provisioned by an idempotent setup script that also manages the agents' configuration files. Changes the extension makes to those files may be overwritten on the next run.

## Agents

- **Claude Code** and/or **Codex** are installed natively on the server and logged in there.
- Both run with server-side guardrails, for example deny rules and a sandbox in `~/.claude/settings.json`, and a permission profile in `~/.codex/config.toml`. The extension must use these and never bypass them.
- The agents store their own chat history:
  - Claude Code: `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd as path>/<session-id>.jsonl`
  - Codex: `<CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-*.jsonl`, with thread names in `session_index.jsonl`

## Editor

- VS Code on the laptop, connected to the dev box with **Remote-SSH**. The same applies to WSL, Dev Containers and Codespaces.
- The default terminal profile may attach every integrated terminal to one shared tmux session (e.g. `tmux new -A -s main`).

## Optional helpers

Users may already have shell helpers for this workflow. The extension should make them unnecessary, but must not conflict with them:

- a command that creates or attaches a named tmux session in a repository;
- a command that lists running `claude`/`codex` processes with PID, start time, working directory and origin (`tmux:<session>`, `ssh`, `orphan`, `daemon`), without killing anything;
- a generator for a multi-root `.code-workspace` file containing every repository below the repo roots.
