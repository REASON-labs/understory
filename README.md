# understory 🌱

**Memory that grows.**

The layer beneath your agents: a self-wiring, plain-markdown memory. Every fact your agents learn is filed as a markdown concept, cross-linked into a living knowledge graph, and kept healthy by the agent itself — searchable, diffable, and entirely yours. Runs great on local models.

Bundles follow the [Open Knowledge Format (OKF) v0.1 spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) — plain markdown files with YAML frontmatter, readable by humans, diffable in git, portable across tools.

Fork: [REASON-labs/understory](https://github.com/REASON-labs/understory) (primary) · [thecodacus/understory](https://github.com/thecodacus/understory) (upstream)

**Three ways in, one agent:**

- **MCP server** — `memory_query` / `memory_add` / `memory_update` / `memory_status` / `memory_maintain` tools over stdio or streamable HTTP. Each call drives an internal LLM agent with the OKF spec in its system prompt.
- **Web UI** — browse the bundle (tree, concept viewer, update log, conformance badge), see the memory as an Obsidian-style **force-directed graph** (drag/pan/zoom, colored by type, sized by connections, orphans ringed red, click to open), and chat with the same agent to test it. Tool calls render inline so you can watch it work.
- **Query-path replay** — every agent run (query/mutation/chat) records its traversal (searches → reads → writes) as a compact notation, persisted under `<bundle>/.traces/`. The graph view lists recent runs; selecting one replays the path as numbered directed hops over the graph — visited concepts ringed, search hits dotted, everything else faded.
- **CLI** — `pnpm agent:query "..."` / `pnpm agent:mutate "..."` smoke entries.

**Design rule: conformance is enforced in code, not prompts.** The deterministic bundle layer validates frontmatter (`type` required), regenerates `index.md` files, appends `log.md` entries (newest-first, spec §7), and sandboxes all paths to the bundle root. The LLM decides *what* to change; the code guarantees the result is a conformant bundle.

## Quick start (Docker)

### From source (recommended)

Clone your fork and build locally:

```bash
git clone https://github.com/REASON-labs/understory.git
cd understory
cp .env.example .env   # add your API key
docker compose up -d
```

The repo's [docker-compose.yml](docker-compose.yml) builds from source and mounts `./sample-bundle`.

### Pre-built image

No clone needed — the image is public. Save this as `docker-compose.yml`:

```yaml
services:
  understory:
    image: ghcr.io/thecodacus/understory:latest
    ports:
      - "3800:3800"
    volumes:
      # Your memory lives here as plain markdown — a named volume, or point
      # a bind mount (e.g. ./my-memory:/bundle) at any OKF bundle.
      - understory-memory:/bundle
    environment:
      BUNDLE_ROOT: /bundle
      LLM_API_BASE_URL: ${LLM_API_BASE_URL}
      LLM_API_KEY: ${LLM_API_KEY}
      LLM_API_FORMAT: openai
      LLM_MODEL: ${LLM_MODEL:-}
      # Optional fallback
      LLM_FALLBACK_API_BASE_URL: ${LLM_FALLBACK_API_BASE_URL:-}
      LLM_FALLBACK_API_KEY: ${LLM_FALLBACK_API_KEY:-}
      LLM_FALLBACK_API_FORMAT: ${LLM_FALLBACK_API_FORMAT:-openai}
      LLM_FALLBACK_MODEL: ${LLM_FALLBACK_MODEL:-}
    restart: unless-stopped

volumes:
  understory-memory:
```

```bash
docker compose up -d
```

### Choosing a provider

The generic provider system supports any OpenAI-compatible or Anthropic-compatible API.
Set `LLM_API_BASE_URL` + `LLM_API_KEY` + `LLM_API_FORMAT` + `LLM_MODEL`. This is the only
supported configuration path.

**DeepSeek:**
```bash
LLM_API_BASE_URL=https://api.deepseek.com/v1 LLM_API_KEY=sk-... LLM_MODEL=deepseek-chat
```

**OpenAI:**
```bash
LLM_API_BASE_URL=https://api.openai.com/v1 LLM_API_KEY=sk-... LLM_MODEL=gpt-4o
```

**Anthropic (Claude):**
```bash
LLM_API_BASE_URL=https://api.anthropic.com/v1 LLM_API_KEY=sk-ant-... LLM_API_FORMAT=anthropic LLM_MODEL=claude-sonnet-5
```

**Groq:**
```bash
LLM_API_BASE_URL=https://api.groq.com/openai/v1 LLM_API_KEY=gsk_... LLM_MODEL=llama-3.3-70b-versatile
```

**Local llama.cpp:**
```bash
LLM_API_BASE_URL=http://localhost:8080/v1 LLM_MODEL=
```

**Local llama.cpp with DeepSeek fallback:**
```bash
LLM_API_BASE_URL=http://localhost:8080/v1 LLM_MODEL= \
LLM_FALLBACK_API_BASE_URL=https://api.deepseek.com/v1 LLM_FALLBACK_API_KEY=sk-... LLM_FALLBACK_MODEL=deepseek-chat
```

> **Removed in this fork:** the old `LLM_PROVIDER` enum and per-provider keys
> (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`,
> `LLAMACPP_BASE_URL`, `LLAMACPP_API_KEY`, `LOCAL_BASE_URL`, `LOCAL_API_KEY`)
> are gone. Setting any of them is a startup error with a migration message
> rather than a silent fallback to a hardcoded hosted endpoint.

Then:

- **Web UI** → http://localhost:3800 — browse the memory, watch the graph, chat with the agent
- **MCP endpoint** → `http://localhost:3800/mcp` (streamable HTTP) — register it in any MCP client:
  ```bash
  claude mcp add --transport http ustory http://localhost:3800/mcp
  ```
- Your agent now has `memory_query` / `memory_add` / `memory_update` / `memory_status` / `memory_maintain`, and gets a seed overview of the memory at every session start.

Teach it something (`memory_add`: "We deploy on Fridays, never Mondays"), then open the graph and watch the concept wire itself in. Deploying with Portainer? Use [docker-compose.portainer.yml](docker-compose.portainer.yml) as a repository stack.

## Stack

pnpm monorepo:

| Package | What |
|---|---|
| `packages/core` | OKF bundle layer (zero LLM) + agent (Vercel AI SDK tool loop: search/read/list/write/patch/delete) + provider registry |
| `packages/server` | Express: MCP streamable-HTTP at `/mcp`, stdio bin, REST browse API at `/api/*`, streaming chat at `/api/chat`, serves the web build |
| `packages/web` | Vite + React + TS + Tailwind: bundle browser + agent chat (`useChat`) |

Providers are configured through `LLM_API_BASE_URL`, `LLM_API_KEY`, `LLM_API_FORMAT` (`openai` or `anthropic`), and `LLM_MODEL`. Any OpenAI-compatible endpoint (DeepSeek, OpenAI, Groq, OpenRouter, llama.cpp, etc.) works with `LLM_API_FORMAT=openai`; Anthropic-compatible endpoints use `LLM_API_FORMAT=anthropic`. Optional fallback uses the matching `LLM_FALLBACK_*` variables.

### llama.cpp

```bash
# on the inference box — --jinja enables OpenAI-style tool calling
llama-server -m model.gguf --jinja --host 0.0.0.0 --port 8080

# here — no model id needed, it's discovered for llama-server-like local endpoints
LLM_API_BASE_URL=http://inference-box:8080/v1 LLM_API_FORMAT=openai LLM_MODEL= \
BUNDLE_ROOT=./sample-bundle node packages/server/dist/index.js
```

Works behind llama-swap too: discovery prefers the currently **loaded** model so a query doesn't trigger a multi-minute model swap. Pin a specific model with `LLM_MODEL=`.

## From source

```bash
pnpm install
pnpm build
cp .env.example .env   # add your API key

BUNDLE_ROOT=./sample-bundle \
LLM_API_BASE_URL=https://api.deepseek.com/v1 \
LLM_API_KEY=sk-... \
LLM_API_FORMAT=openai \
LLM_MODEL=deepseek-chat \
node packages/server/dist/index.js
# → http://localhost:3800  (web UI + /api + /mcp)
```

Or build the container yourself: `docker compose up --build` (the repo's [docker-compose.yml](docker-compose.yml) builds from source and mounts `./sample-bundle`).

Dev mode (server on :3800, Vite HMR on :5180 with proxy):

```bash
BUNDLE_ROOT=./sample-bundle pnpm --filter @understory/server dev
pnpm --filter @understory/web dev
```

## MCP registration (Claude Code / Desktop)

```bash
claude mcp add ustory \
  -e BUNDLE_ROOT=/path/to/your/bundle \
  -e LLM_API_BASE_URL=https://api.deepseek.com/v1 \
  -e LLM_API_KEY=sk-... \
  -e LLM_API_FORMAT=openai \
  -e LLM_MODEL=deepseek-chat \
  -- node /path/to/understory/packages/server/dist/mcp/stdio.js
```

Or point an HTTP MCP client at `http://host:3800/mcp`.

### Auth

By default the server is open — fine on localhost or a trusted LAN. Before exposing it anywhere else, set `AUTH_TOKEN`:

```bash
AUTH_TOKEN=$(openssl rand -hex 24)
```

With it set, `/mcp` and `/api` require `Authorization: Bearer <token>` (the web UI stays reachable and prompts for the token). Register authenticated MCP clients with a header:

```bash
claude mcp add --transport http ustory http://host:3800/mcp \
  --header "Authorization: Bearer <token>"
```

The stdio transport needs no token — it's a local process spawned by the client.

### Seed memory

A client LLM that only sees four bare tool names never gets the instinct to check memory. So at **session start** the server injects a compact overview of what the knowledge base contains (directories, concepts with types + descriptions, recent activity) through both channels that reach the model:

1. the MCP initialize **`instructions`** field (clients like Claude put it in the system prompt), and
2. the **`memory_query` tool description** — the universal fallback every tool-calling client loads.

The seed regenerates fresh for every new session. After `memory_add` / `memory_update` in a long-lived (stdio) session, the tool description refreshes via `tools/list_changed`, so the session sees its own writes. Out-of-band edits (hand edits, other clients) are picked up on the next session.

### Graph health & maintenance

Memory is a graph, not a pile of notes, and graphs rot: concepts go **orphaned** (nothing links to them) and links go **broken**. Two mechanisms keep it healthy:

- **Write-time linking** — new knowledge either enriches the concept it belongs to (an attribute of an existing entity is patched in, not filed separately) or, when it's a distinct entity, is created *and* back-linked from related concepts. Contradictions are superseded in place, never left standing alongside the old value.
- **`memory_maintain`** — a deterministic lint (orphans + broken links, surfaced in `memory_status` under `graph`) drives an internal agent to wire orphans into related concepts and fix dangling links. Run it periodically to counter drift; it's a no-op when the graph is already healthy.

### Scoped queries

`memory_query` accepts optional filters alongside the question:

```jsonc
{
  "question": "what are the rate limits?",
  "type": "policy",          // exact concept type
  "tags": ["billing"],       // ALL must match
  "directory": "/services"   // restrict to a subtree
}
```

The internal agent's `search_knowledge` tool has always had `type`/`tags`
filters, but they were reachable only by the inner agent's own choice — an
external client could ask for precision and not get it. These now pass through.

A scope is a **guarantee to the caller, not a suggestion to the model**: the
model can narrow it further but cannot widen it, and `read_concept` refuses
paths outside a `directory` scope. (This is a retrieval boundary for answer
quality, not a security boundary — `AUTH_TOKEN` is the security boundary.)

`directory` also shrinks the bundle tree injected into the system prompt and
into search-miss results, so a scoped query is cheaper as well as more precise.

Scopes are part of the query cache key, and scoped queries skip cached Q&A
pairs in hot memory — a cached answer carries no record of which concepts
produced it, so it can't be shown to respect the scope.

### Dreaming (autonomous consolidation)

Set `DREAM_INTERVAL` (e.g. `6h`) and understory runs a consolidation pass on a
timer. Deterministic signals decide whether there is anything to do, so a
healthy memory costs nothing — no signals, no agent run, no tokens. The first
run is one interval after boot, never at startup, and runs never overlap.
Minimum interval is 5 minutes.

**Signals**, controlled by `DREAM_SIGNALS`:

| Signal | Fires when | The dream then |
|---|---|---|
| `orphans` | nothing links to a concept | wires it into related concepts, or leaves it alone |
| `links` | a link target is missing | fixes the path, or removes the link |
| `oversized` | a concept has grown fat | splits it hub-and-spoke, original path preserved |
| `insights` | ≥5 recent log entries | may create one overview concept over an emergent theme |
| `duplicates` | two concepts look near-identical | merges them and **deletes** one |

Default is everything **except `duplicates`**. That signal is the only one that
deletes, and it fires on title/description string similarity — the measure most
likely to be wrong. Mutations are transactional and git-committed, so a bad
merge is revertible, but only if you notice. Enable with `DREAM_SIGNALS=all`
once the other signals look right on your bundle.

An unknown value in `DREAM_SIGNALS` is a startup error, not a silent
narrowing — a typo there is otherwise invisible until you wonder why nothing
is being consolidated.

#### Watching it

Dreaming is the one part of understory that writes with nobody watching, hours
apart. Two endpoints exist to make that observable (both under `/api`, so
`AUTH_TOKEN` protects them):

```bash
# What would a dream do right now? No agent, no tokens, no writes.
curl localhost:3800/api/dream/preview

# Is it running, on what schedule, and how did recent runs go?
curl localhost:3800/api/dream/status
```

`preview` returns the signals that fired with their counts and the exact
prompt text each contributes, plus anything suppressed by `DREAM_SIGNALS` —
so you can see what turning `duplicates` on would pick up before turning it on.

`status` returns the resolved schedule and signal set, the next run time, and
the last 20 runs with outcome, duration, and files changed. History is
in-memory and resets with the process, by design: it describes this process's
behaviour, and a stale history read off disk after a restart would mislead.

A dream that fails is logged to stderr, and its outcome is recorded — including
`rolled_back`, which means it failed and the bundle was fully restored. That is
a materially different event from `partial`, which means rollback itself failed
and a human needs to look.

**Note:** a dream holds the exclusive bundle write lock for its whole run, so
user mutations queue behind it. At a 6h interval on a personal bundle this is
invisible; if you shorten the interval a lot, it stops being.

### Health check

`GET /health` — unauthenticated, cheap, safe to poll. Returns `200 {status:"ok"}`
when the bundle root is reachable and `503 {status:"degraded"}` when it isn't,
plus uptime and the resolved model labels:

```json
{
  "status": "ok",
  "uptimeSeconds": 412,
  "bundle": { "root": "/bundle", "reachable": true },
  "model": { "primary": "openai:qwen3-30b", "fallback": "openai:deepseek-chat" }
}
```

It is mounted *before* the bearer-auth middleware on purpose — a container
`HEALTHCHECK` has no way to carry `AUTH_TOKEN`. Model **base URLs are omitted**
so an exposed instance doesn't leak internal hostnames. Docker Compose and the
Dockerfile both wire this up automatically.

### Mutation safety

Mutations are **all-or-nothing**. Every write in an agent run — concepts,
regenerated `index.md`, appended `log.md` — is journalled, and if the run fails
partway the bundle is restored to exactly its pre-instruction state. Upstream, a
model that died at step 7 of 12 left the first six writes behind permanently
with no rollback; that was the largest reliability gap when driving the agent
with a small local model.

Outcomes reported by `memory_add` / `memory_update`:

| Status | Meaning |
|---|---|
| `ok` | Run completed; writes kept. |
| `rolled_back` | Run failed; **every** write undone. Bundle unchanged. |
| `partial` | Run failed *and* rollback couldn't fully restore. Needs a human — `filesUnrestored` lists what's inconsistent. |
| `failed` | Run failed before writing anything. |

A transaction holds an exclusive bundle write lock for its duration, so a
background dream consolidation can't interleave with a user mutation — without
that, rolling back a failed run could silently revert the other one's work.

`GIT_AUTOCOMMIT` now defaults to **true**: rollback handles runs that fail,
git handles runs that "succeed" but write something wrong. A rollback with git
enabled lands as a `revert:` commit rather than a dirty working tree.
`MUTATION_ROLLBACK=false` restores upstream behaviour.

This design mirrors the pattern in Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (index.md + log.md, create-vs-enrich, lint for orphans). Deferred from that pattern until scale warrants: an explicit page-type schema, and hybrid FTS5+embedding search (the naive scan in `search.ts` is fine into the low thousands of concepts).

## Tests

```bash
pnpm test                                  # core: 18 tests (spec §5/§6/§7/§9, sandbox, search, concurrency)
pnpm --filter @understory/server exec tsx scripts/mcp-smoke.mts   # MCP stdio round-trip (needs SMOKE_BUNDLE + an API key)
```

## Environment

See [.env.example](.env.example). `BUNDLE_ROOT` is required. `GIT_AUTOCOMMIT` (default `true`) commits every mutation; `MUTATION_ROLLBACK` (default `true`) makes agent runs transactional.
