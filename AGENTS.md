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
