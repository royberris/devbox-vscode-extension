# Decisions and open questions

## Decided

| Question | Decision |
|---|---|
| Where do worktrees go? | `~/worktrees/<repo>/<name>` by default: outside the repositories and outside the repo roots. Configurable (`devboxAgents.worktreesRoot`). |
| One window with several workspace folders, or one window per worktree? | One window by default, switched once to a dedicated agent workspace that shows exactly the worktrees of the running sessions. Folders keep their order so folder 0 (whose change restarts the extension host) only changes when its session ends. `devboxAgents.focusMode` also allows replacing one agent folder, adding folders, a new window per worktree, or terminal only. |
| Codex from day 1, or Claude first? | Both from day 1, each can be switched off. Codex reports only finished turns via `notify`, not approval requests. |
| Remote Control (following sessions from the Claude app or a phone)? | Out of scope. Sessions are plain CLI processes, so the agents' own remote features keep working. The extension does not integrate with them. |
| Public or internal? | Public. No host names, paths or organisation names in code. All server-side paths and commands are settings with machine scope. The extension runs on the remote side of the connection and needs no SSH settings of its own. |

## Open

- **Worktrees created by the agents themselves** (`claude -w`, `codex --worktree`, see [03-constraints.md](03-constraints.md)):
  - Should they show up in the Sessions view?
  - May the extension clean them up? Claude locks its worktrees while in use.
  - Should history group their chats per worktree? Claude's worktrees currently end up under the main repository, and Codex's under their raw path.
  - Should the extension warn when `.claude/worktrees` is not globally ignored?
- **Codex approval requests:** Codex's `notify` reports only finished turns. Is there a reliable signal for "waiting for approval"?
- **Status hooks vs. provisioning:** when a setup script manages the agents' config files, should the extension stay out of them and only print the snippet to add?
