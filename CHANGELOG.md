# Changelog

## 1.1.0

- When the pull request of a session's branch is merged on GitHub, a notification offers to clean up the session: stop it, remove the worktree and delete the local branch. Works however the PR was merged and does not need the GitHub Pull Requests extension; uses the GitHub account signed in to VS Code. Setting: `devboxAgents.promptCleanupOnMerge`.
- *Clean Up* deletes the local branch too once its pull request is known to be merged (only when it has no commits that are not in the PR).

## 1.0.0

- Recommended layout (explorer with sessions left, file in the middle, agent terminal right) with a screenshot in the README and on the Marketplace page.
- Development dependencies updated by Dependabot (TypeScript 7).

## 0.2.0

- Antigravity CLI (`agy`) as a third agent: start, resume (`--conversation`), process overview and chat history.
- Agents whose command is not found on the server are hidden from the pickers and menus.
- A window without a folder switches to the agent workspace as soon as it opens, instead of on the first focus (`devboxAgents.openAgentWorkspaceOnStart`).
- Codex now reports working and waiting for approval, through Codex hooks in `~/.codex/hooks.json`. Run *Install Status Hooks* again and trust the hooks once with `/hooks` in Codex.

## 0.1.0

- First version: sessions per worktree in tmux, process overview, chat history with resume, waiting-agent notifications via hooks.
