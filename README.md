# Devbox Agents

[![CI](https://github.com/royberris/devbox-vscode-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/royberris/devbox-vscode-extension/actions/workflows/ci.yml)

A VS Code extension to start, follow and resume AI coding agents ([Claude Code](https://docs.claude.com/en/docs/claude-code), [Codex](https://github.com/openai/codex)) on a remote dev box, with every agent in its own **git worktree** and **tmux session**.

Agents run on the server, with the server's own configuration, logins and guardrails. They **keep running when your laptop is closed** or the connection drops, with no time limit. When you reconnect you see each session live again, including everything that happened in between.

## At a glance

**What the extension does**

- Starts Claude Code or Codex in its own git worktree, on its own branch, inside a tmux session, from one picker.
- Shows all sessions, worktrees, repositories, running agent processes and past chats in a sidebar.
- Lets you focus a session (terminal + explorer follow), resume old chats, and clean up worktrees safely.
- Notifies you when an agent is waiting for permission or has finished.

**What it does *not* do**

- It installs no software on your server. Outside its own state (`~/.local/state/devbox-agents`, `~/.local/share/devbox-agents`) it only changes your agent config for the optional status hooks, and only after you confirm.
- It does not run agents as its own child process, does not kill processes automatically and stores nothing in your repositories.

**What you install yourself**

| Where | What | Notes |
|---|---|---|
| Your laptop | VS Code + a remote extension | [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) (or WSL, Dev Containers, Codespaces) |
| The server | Linux | Process scanning reads `/proc`; the rest also works on macOS |
| The server | `tmux` ≥ 3.2, `git` ≥ 2.38, `bash` | See the commands below |
| The server | `claude` and/or `codex` | Installed **and logged in** on the server, not on your laptop |
| The server | This extension | Installed from a window connected to the server; VS Code puts it on the remote side |

On Ubuntu/Debian:

```sh
sudo apt update && sudo apt install -y tmux git
# Ubuntu 22.04 ships git 2.34; get a newer one with:
#   sudo add-apt-repository -y ppa:git-core/ppa && sudo apt install -y git

# Claude Code
curl -fsSL https://claude.ai/install.sh | bash
claude            # log in once

# Codex (needs Node.js)
npm install -g @openai/codex
codex login
```

Check with `tmux -V`, `git --version`, `claude --version`, `codex --version`, all in a login shell on the server.

## Getting started

1. Connect VS Code to the server (e.g. *Remote-SSH: Connect to Host…*).
2. In that window, install **Devbox Agents** from the Extensions view. It installs on the remote side. (Or use **… → Install from VSIX…** with a `.vsix` from the [releases](https://github.com/royberris/devbox-vscode-extension/releases).)
3. Run `Devbox Agents: Open Settings` and make sure `repoRoots` (where your repositories are, default `~/repos`) and `worktreesRoot` (default `~/worktrees`) match your server.
4. Run `Devbox Agents: Install Status Hooks…` once to get notifications (see [Status hooks](#status-hooks-notifications)).
5. Click **+** in the *Sessions* view and pick Claude Code or Codex.

The extension declares `"extensionKind": ["workspace"]`, so in a Remote-SSH, WSL, Dev Container or Codespaces window it runs **on the remote side**. It needs no SSH settings of its own; it uses the connection VS Code already has. Every path and command is a setting with *machine* scope, so you can set different values per remote (**Remote [host]** tab in the settings editor).

```
┌ DEVBOX AGENTS ─────────────────────────────┐
│ SESSIONS                          + ⟳      │
│ ▾ my-api            ~/repos/acme           │
│     fix-login    Claude Code · agent/fix-… 🔔 waiting for you
│     bump-deps    Codex · agent/bump-deps   ⟳ working
│     old-spike    agent/old-spike · no session
│ ▸ Other tmux sessions                      │
│ AGENT PROCESSES                 1 orphaned │
│   claude 31801   tmux:main · ~/repos · 2h  │
│ ⚠ claude 28890   ORPHANED · ~/repos/acme   │
│ HISTORY                                    │
│ ▸ my-api › fix-login   3 chats · 5m ago    │
└────────────────────────────────────────────┘
```

## Why tmux, and not a process started by the extension

A process started by a VS Code extension on a remote host stops when VS Code has been disconnected for longer than `remote.SSH.reconnectionGraceTime` (3 hours by default). A pending permission prompt is lost then, and it is not asked again when you resume. Processes in tmux survive indefinitely. So this extension is a **UI over tmux sessions**: it never runs an agent as its own child process, and it reads all state from the server (tmux, `git worktree list`, `/proc`), not from its own storage.

## Features

- **New session in one step:** a single picker with a random, editable session name. Press Enter on *Claude Code* or *Codex* and the extension creates
  - a worktree in `<worktreesRoot>/<repo>/<name>` on a new branch `agent/<name>`, based on `origin/main` (`devboxAgents.defaultBaseBranch`),
  - a tmux session `<repo>-<name>` in that worktree,
  - and starts the agent in a login shell in it.

  The picker also shows the repository (the last one used, or the one open in the window) and the base branch. Select either one to change it. The agent you used last comes first.
- **The explorer follows your focus:** click a session and its worktree becomes a workspace folder (or opens in a new window, see `devboxAgents.focusMode`), and a terminal attaches to the tmux session.
- **Many agents at once,** Claude and Codex mixed, each with its own worktree.
- **Clean up safely:** *Clean Up* stops the session and removes the worktree, but only if it has no uncommitted or untracked changes. Otherwise it refuses and lists the changes. The branch is always kept.
- **Repositories view:** every repository with its branch, ahead/behind, uncommitted changes and a hint when dependencies are missing (`package.json` without `node_modules`). From there you can
  - start Claude Code or Codex **directly on the main checkout**, without a worktree, e.g. to install dependencies or manage the repo;
  - start a new worktree session;
  - **Add Repository**: paste any repository link (clone URL, or a browser link to a repo, branch, PR or file on GitHub, GitLab, Bitbucket or Azure DevOps) and press Enter. It is cloned on the server into `<repoRoot>/<owner>/<repo>` with the server's git credentials, never prompting. An https link that fails on authentication is retried over SSH. Afterwards you can set an alias or let an agent set it up;
  - **Set Alias…**: the short name used in tmux session names (`devboxAgents.repoAliases`, saved in the remote's settings).
- **Process overview:** every `claude`/`codex` process with PID, start time, working directory and origin: `tmux:<session>`, `ssh`, `VS Code server`, `daemon` (Codex's managed app-server) or **orphaned**. Leftover and orphaned processes are highlighted, but **never killed automatically** (you can terminate one by hand, with confirmation).
- **History:** past chats of both agents, grouped by repository/worktree and titled the way the agents name them. *Resume* reopens a chat (`claude --resume` / `codex resume`) in a new tmux session in its original directory. If the chat is already running somewhere, that session is focused instead.
- **Notifications when an agent waits for you** (permission or question) or finishes its turn, with a badge and a status bar counter. On reconnect you get one summary of the agents that are waiting. This needs the status hooks, see below.
- **Diffs in the editor:** *Connect Claude to Editor* types `/ide` into the session, so Claude Code shows its diffs in VS Code. This needs the Claude Code VS Code extension in the same window.
- **Nothing in your repositories:** the extension's state lives in tmux session options and in `~/.local/state/devbox-agents`. Worktrees go outside your repositories by default.

## Settings

| Setting | Default | |
|---|---|---|
| `devboxAgents.repoRoots` | `["~/repos"]` | Directories that contain your repositories |
| `devboxAgents.repoScanDepth` | `2` | Levels to search below each root (`~/repos/<org>/<repo>` → 2) |
| `devboxAgents.extraRepos` | `[]` | Extra repository paths |
| `devboxAgents.worktreesRoot` | `~/worktrees` | Where worktrees are created: `<root>/<repo>/<name>` |
| `devboxAgents.branchPrefix` | `agent/` | Prefix of the branch created per session |
| `devboxAgents.defaultBaseBranch` | `main` | Base for new sessions: `origin/main` if it exists, else `main` |
| `devboxAgents.fetchBeforeNewSession` | `true` | `git fetch` before creating a worktree from a remote branch |
| `devboxAgents.repoAliases` | `{}` | Short names for tmux sessions, e.g. `{"web_BigProject": "big"}` |
| `devboxAgents.claude.command` / `.args` / `.enabled` | `claude` | How to start Claude Code |
| `devboxAgents.claude.configDir` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | History source and hooks target |
| `devboxAgents.codex.command` / `.args` / `.enabled` | `codex` | How to start Codex |
| `devboxAgents.codex.home` | `$CODEX_HOME` or `~/.codex` | History source and notify target |
| `devboxAgents.tmuxPath` | `tmux` | tmux binary |
| `devboxAgents.shell` | `$SHELL` | Login shell the agent runs in; stays open after the agent exits |
| `devboxAgents.sessionEnv` | `{}` | Extra environment variables for agent sessions |
| `devboxAgents.focusMode` | `activeSessions` | `activeSessions` (the agent workspace shows the worktrees root, then only the running sessions' worktrees), `swapFolder`, `addFolder`, `newWindow` or `terminalOnly` |
| `devboxAgents.terminalLocation` | `panel` | `panel` or `editor` |
| `devboxAgents.connectIdeOnFocus` | `false` | Type `/ide` into a Claude session when it is focused |
| `devboxAgents.refreshInterval` | `5` | Seconds between refreshes |
| `devboxAgents.history.days` / `.maxPerGroup` | `30` / `50` | History range |
| `devboxAgents.statusDir` | `~/.local/state/devbox-agents/status` | Where the status hook writes |
| `devboxAgents.notify` | `["waiting","idle"]` | Which state changes show a notification |

### Where to put worktrees

- **Not inside a repository** (e.g. under `.git/`). Tools that search upwards, such as `Directory.Build.props`, `tsconfig.json` and `pnpm-workspace.yaml`, would find the main repo's files.
- **Not inside a repo root,** or it is scanned as a repository too. If it has to be there, exclude it from your own tooling.
- The default, `~/worktrees`, avoids both.

## Status hooks (notifications)

`Devbox Agents: Install Status Hooks…` does three things, after asking first:

1. It writes `~/.local/share/devbox-agents/agent-hook.sh`. This bash script, with no other dependencies, dumps each hook payload into the status directory. It always exits 0 and prints nothing, so it cannot block or change the agent.
2. It adds hooks for `Notification`, `Stop`, `UserPromptSubmit`, `PostToolUse`, `SessionStart` and `SessionEnd` to `<claude configDir>/settings.json`, keeping everything already in there. A backup is saved as `settings.json.devbox-agents.bak`.
3. It adds `notify = [".../agent-hook.sh", "codex"]` to Codex's `config.toml`, but only if there is no `notify` yet. Codex reports only finished turns this way, not approval requests.

Without the hooks a session shows "agent active · no status", and the extension offers to install them when it starts (again after a provisioning run removed them; "Don't Ask Again" stops that). The hooks apply to agents started after the install. If your agent config is generated (dotfiles, provisioning scripts), add the hooks there instead, or the next run may remove them:

```jsonc
// ~/.claude/settings.json
"hooks": {
  "Notification":     [{ "hooks": [{ "type": "command", "command": "~/.local/share/devbox-agents/agent-hook.sh claude", "timeout": 5 }] }],
  "Stop":             [{ "hooks": [{ "type": "command", "command": "~/.local/share/devbox-agents/agent-hook.sh claude", "timeout": 5 }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "~/.local/share/devbox-agents/agent-hook.sh claude", "timeout": 5 }] }],
  "PostToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.local/share/devbox-agents/agent-hook.sh claude", "timeout": 5 }] }],
  "SessionStart":     [{ "hooks": [{ "type": "command", "command": "~/.local/share/devbox-agents/agent-hook.sh claude", "timeout": 5 }] }],
  "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "~/.local/share/devbox-agents/agent-hook.sh claude", "timeout": 5 }] }]
}
```

```toml
# ~/.codex/config.toml (top level, before any [table])
notify = ["/home/you/.local/share/devbox-agents/agent-hook.sh", "codex"]
```

Sessions started by the extension carry `DEVBOX_AGENTS_SESSION=<tmux session>` in their environment, and the hook uses that as its key. Agents started elsewhere report under their chat ID and are matched to a tmux session by working directory.

## Good to know

- **"Do you trust the authors…" for every worktree:** VS Code asks this for each new folder, and extensions cannot answer it. Trust the worktrees root once instead: run `Devbox Agents: Trust Worktrees and Repo Folders…` (or *Workspaces: Manage Workspace Trust → Add Folder*) and add `~/worktrees`. That covers every worktree inside it.
- **Workspace switch:** VS Code reloads the window when you add a folder to an empty or single-folder window. So the first time you focus a session there, the extension asks once whether to switch the window to `~/.local/share/devbox-agents/agents.code-workspace` (on the server). After that one reload, the session opens again, and later focusing swaps the folder without reloading. Already working in a multi-root workspace (e.g. a `.code-workspace` with all your repos)? Then no switch is needed.
- **Default terminal profile:** if your integrated terminals open a shared tmux session (e.g. `tmux new -A -s main`), the terminals of this extension are not affected. They start `tmux attach -t <session>` explicitly. For the same reason, don't use the Claude Code extension's *Use Terminal* option for agents you want to keep: it types `claude` into a new default terminal.
- **Agents create placeholder folders** (`.claude`, `.codex`, …) in their working directory. Sessions always start in a worktree, never in a repo root.
- **Sandboxed agents and worktrees:** a commit in a worktree writes to the *main* repository's `.git` directory. If your agent sandbox only allows writes below the working directory, add the repositories' `.git` directories to its writable paths, or commit outside the sandbox.
- **Leftover processes:** the Claude Code VS Code extension sometimes leaves old `claude` processes behind after a reconnect. They show up as *VS Code server* or *orphaned* in *Agent Processes*.
- **Codex's app-server daemon** (`codex app-server --managed-daemon`) is detached on purpose. It shows as `daemon`, not as orphaned.
- **Remote Control / mobile:** sessions are plain `claude`/`codex` processes, so their own remote features work as usual. The extension does not integrate with them.

## Development

```sh
npm install
npm run watch      # bundle to dist/ on change
npm test           # unit tests for src/core (no VS Code needed)
npm run typecheck
npm run package    # → devbox-agents-<version>.vsix
```

Press F5 in VS Code to start an Extension Development Host. To try it against a real server, start the host from a Remote-SSH window.

The code is split in two layers:

- `src/core/`: tmux, git, `/proc` scanning, history parsing and the hook script. Plain Node, no `vscode` import, unit tested.
- `src/*.ts`: the VS Code layer, with views, commands, focus and notifications.

## License

MIT
