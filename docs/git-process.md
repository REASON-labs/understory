# Git process for agents

Jay runs two git remotes. Agents use the appropriate one depending on the repo.

## Forgejo (primary remote — LAN)

| What | Address |
|---|---|
| Web UI and API | http://192.168.254.223:3000 (API at /api/v1) |
| Git over SSH | ssh://git@192.168.254.223:2222 |
| SSH alias | `forgejo` (port 2222) |

Used for: all repos agents work on (understory, my-site, reason.direct, rentstuff, freestuff, earthseed.online, jaybb.com).

- Agents push `agent/*` branches to Forgejo and open PRs there.
- **This address is private — do not publish it publicly.**

Credentials are in `LOCAL-AGENT-INTRO.md`. Each agent has its own account.

## GitHub (downstream mirror only)

| What | Address |
|---|---|
| Web | https://github.com/REASON-labs |
| Git SSH | git@github.com:REASON-labs/ |

GitHub is only a downstream mirror. Agents **never** push to GitHub or open PRs there. It is used by Vercel to deploy some repos (my-site, earthseed.online).

## The process

1. **Clone or pull** the repo you need. Start from `main` (or the default branch).
2. **Create a branch** named `agent/<short-description>` — descriptive but short (no spaces, use hyphens).
3. **Make your changes** on the branch. Run tests and dev servers locally before pushing.
4. **Commit** with messages that explain why, not what. Keep commits small and reviewable.
5. **Push** the branch to Forgejo (`origin`).
6. **Open a draft PR** against the default branch on Forgejo. Describe the change, what you tested, and any gotchas.
7. **Stop.** Jay reviews and merges. For repos Vercel deploys from GitHub (my-site, earthseed.online) the merge triggers a deploy; for others (e.g. reason.direct) deployment is manual — check the repo's AGENTS.md.

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
- SSH keys are in `~/.ssh/` and referenced in `~/.ssh/config`.</parameter>
</function>
</tool_call>
<tool_call>
<function=write_file>
<parameter=path>
/home/jay/git/understory/docs/devops/git-process.md