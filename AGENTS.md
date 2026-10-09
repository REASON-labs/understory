# understory — LLM-managed knowledge base (OKF spec)

## What this is
Personal knowledge base following the Open Knowledge Format. MCP server + web UI for querying and mutating structured knowledge.

## Stack
- **Node.js 20+** (monorepo via pnpm workspaces)
- **pnpm 10.15** package manager
- **TypeScript** for all packages
- **Docker** for deployment (docker-compose on :3800)

## Monorepo structure
- `packages/core/` — knowledge graph engine, OKF parsing, agent query/mutate commands
- `packages/server/` — MCP server + HTTP API
- `packages/web/` — web UI frontend
- `bench/` — benchmarking (recall-bundle fixtures, recall runner)
- `sample-bundle/` — example knowledge bundles (apis/, devops/, playbooks/, services/, tables/)
- `scripts/` — dev/deploy helpers

## Key commands
- `pnpm build` — build all packages
- `pnpm dev` — parallel dev mode for all packages
- `pnpm test` — run tests across all packages
- `pnpm --filter @understory/core agent:query` — query knowledge
- `pnpm --filter @understory/core agent:mutate` — mutate knowledge
- `docker compose up` — deploy full stack on :3800

## Knowledge model
- OKF spec: knowledge stored as structured facts, not free text
- Agent tools: query (read) and mutate (write/update/delete)
- Bundles: logical groupings of knowledge (e.g., "devops", "apis")

## Working agreements
How changes land here. Keep to these; they exist because a deep stack of PRs and an untested merge both cost us time.

1. **One item at a time.** Branch from `main`, finish and merge before starting the next. Avoid PRs stacked on PRs; if one item truly depends on another, merge the first first.
2. **Tests travel with the code.** New behaviour gets tests in the same PR. `pnpm -r build && pnpm test` must pass locally and in CI before merge.
3. **Test the real thing, not just units.** Unit tests mock the model; they cannot tell you whether the prompt works. Add steps to `scripts/rollout-test.mjs` for each user-visible feature and run it against a COPY of a real bundle (it never touches the original).
4. **Never run destructive tools on the live bundle.** `memory_forget`, bulk updates and migrations are rehearsed on a copy first. Tools that delete default to a dry run.
5. **PRs state limits honestly.** What it does not cover, what is heuristic, what depends on model behaviour.
6. **Deploy at checkpoints, with a way back.** Back up the bundle, record the previous commit, then `git pull && docker compose up -d --build`. The bundle's own git history is the undo for content; the previous image commit is the undo for code.
7. **Windows quirk.** Git is slow here; tests that touch git set generous timeouts, and temp-dir cleanup uses `maxRetries`.
