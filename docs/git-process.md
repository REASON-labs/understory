# Git process for agents

Jay runs two git remotes. Agents use the appropriate one depending on the repo.

## GitHub (remote)

| What | Address |
|---|---|
| Web | https://github.com/REASON-labs |
| Git SSH | git@github.com:REASON-labs/ |

Used for: my-site, reason.direct, rentstuff, freestuff, earthseed.online, understory, jaybb.com, reason-direct.

Credentials are in the web-dev sandbox via `GH_TOKEN` (fine-grained, scoped to the five site repos). Other agents use their own tokens.

## Forgejo (local LAN)

| What | Address |
|---|---|
| Web UI and API | http://192.168.254.223:3000 (API at /api/v1) |
| Git over SSH | ssh://git@192.168.254.223:2222 |
| Server SSH host key (RSA 4096) | SHA256:QC2YXss7XU/gfA43cmAGI5PY4xAQtgLKr65LQ9F+ELo |

Used for: local repos that contain credentials or are not ready for GitHub.

Credentials are in `LOCAL-AGENT-INTRO.md`. Each agent has its own account.

## The process

1. **Clone or pull** the repo you need. Start from `main` (or the default branch).
2. **Create a branch** named `agent/<short-description>` — descriptive but short (no spaces, use hyphens).
3. **Make your changes** on the branch. Run tests and dev servers locally before pushing.
4. **Commit** with messages that explain why, not what. Keep commits small and reviewable.
5. **Push** the branch to the remote.
6. **Open a draft PR** against the default branch. Describe the change, what you tested, and any gotchas.
7. **Stop.** Jay reviews and merges. The merge is the production deploy.

### Rules

- Never push directly to `main` or any default branch.
- Never merge any PR, including your own.
- Never force-push or rewrite published history.
- Never delete a remote branch.
- One PR per logical change.
- If you learn something durable about the repo (commands, layout, gotchas), add a line to its AGENTS.md in the same branch and PR.
- Coordinate with other agents through branches and PRs, not by editing shared files on the same branch.
- If another agent is working on the same checkout, check `git status` before committing and stage by path, never `git add -A`.

### Credentials

- Never print, write, or embed credentials in commits, PR descriptions, or chat.
- Tokens live in environment variables or files with mode 600.
- SSH keys are in `~/.ssh/` and referenced in `~/.ssh/config`.
