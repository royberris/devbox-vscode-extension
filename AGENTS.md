# Agent notes

Instructions for coding agents (Hermes, Claude Code, Codex, …) working in this repository. User-facing documentation is in `README.md`.

## Project

VS Code extension `royberris.devbox-agents`. It runs on the remote side (`extensionKind: workspace`) and is a UI over tmux sessions and git worktrees on a dev box.

- `src/core/`: tmux, git, `/proc`, history parsing, hook script. Plain Node, no `vscode` import, unit tested.
- `src/*.ts`, `src/views/`: the VS Code layer.
- `src/test/`: `node --test` tests for `src/core` (`linux.test.ts` needs tmux and Linux).
- `marketplace/listing.md`: the Marketplace page. Packaging uses it instead of `README.md` (`vsce package --readme-path`). Keep both in sync when features or requirements change.
- `media/icon.png` is rendered from `media/icon.svg`; re-render the PNG (256×256) when the SVG changes.
- `SPEC.md` and `spec/` are internal notes (gitignored), not published.

## Commands

```sh
npm ci
npm run typecheck
npm test
npm run build      # dev bundle in dist/
npm run package    # typecheck + production bundle + .vsix
```

Run typecheck and tests before pushing.

## CI/CD

| Workflow | Runs on | Does |
|---|---|---|
| `ci.yml` | push to main, PRs | npm audit (high), typecheck, tests on Node 22 and 24, builds the VSIX |
| `codeql.yml` | push, PRs, weekly | CodeQL for JS/TS and Actions |
| `dependency-review.yml` | PRs | blocks new dependencies with moderate+ advisories |
| `dependabot-automerge.yml` | Dependabot PRs | enables auto-merge for patch/minor updates |
| `release.yml` | tag `v*` | tests, packages, creates a GitHub release with the `.vsix`, publishes to Open VSX if `OVSX_PAT` is set |

- `main` is protected by a ruleset: required checks `Test (Node 22)`, `Test (Node 24)`, `Package VSIX` and `review`, no force push, no deletion. Work on a branch and open a PR.
- Actions are pinned to commit SHAs with the version as a comment (`uses: x/y@<sha> # v1.2.3`). Keep that format; Dependabot updates both.

## Dependencies

- Dependabot opens weekly PRs for npm and GitHub Actions. Patch/minor merge by themselves once checks pass; majors need a human decision.
- `@types/vscode` must not be newer than `engines.vscode` (vsce refuses to package). Bump both together, by hand.
- `@types/node` follows the Node version of the oldest supported VS Code; majors are ignored by Dependabot.
- Before merging a major: read the changelog for breaking changes and run `npm run package` locally, not just the tests.

## Releasing

1. Update `CHANGELOG.md` (it is shown on the Marketplace page).
2. `npm version patch|minor|major` (updates `package.json`, commits, tags `vX.Y.Z`).
3. `git push --follow-tags`. The release workflow checks that the tag matches `package.json`.
4. The `.vsix` appears on the GitHub release.
5. **VS Code Marketplace: manual upload by Roy.** Download the `.vsix` from the release and upload it at https://marketplace.visualstudio.com/manage (extension → … → Update). There is deliberately no `VSCE_PAT`: Azure DevOps retires global PATs on 2026-12-01, and the replacement (Entra ID managed identity) needs an Azure subscription that is not set up. Do not add a PAT or change this route without asking Roy.

Agents may prepare a release (changelog, version bump on a branch) but ask Roy before pushing a release tag.

## Rules

- Never push to `main` directly, change rulesets, repository settings or secrets.
- Never commit tokens, `.vsix` files, `dist/` or `out/`.
- Publisher assets (logo, publisher description) are not kept in this repo.
