# understory 🌱

**Memory that grows.**

The layer beneath your agents: a self-wiring, plain-markdown memory. Every fact your agents learn is filed as a markdown concept, cross-linked into a living knowledge graph, and kept healthy by the agent itself — searchable, diffable, and entirely yours. Runs great on local models.

Bundles follow the [Open Knowledge Format (OKF) v0.1 spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) — plain markdown files with YAML frontmatter, readable by humans, diffable in git, portable across tools.

Fork: [REASON-labs/understory](https://github.com/REASON-labs/understory) (primary) · [thecodacus/understory](https://github.com/thecodacus/understory) (upstream). See [What this fork adds](#what-this-fork-adds).

**Three ways in, one agent:**

- **MCP server** — `memory_query` / `memory_add` / `memory_update` / `memory_status` / `memory_maintain` / `memory_explain` / `memory_forget` tools over stdio or streamable HTTP. Each call drives an internal LLM agent with the OKF spec in its system prompt.
- **Web UI** — browse the bundle (tree, concept viewer, update log, conformance badge), see the memory as an Obsidian-style **force-directed graph** (drag/pan/zoom, colored by type, sized by connections, orphans ringed red, click to open), and chat with the same agent to test it. Tool calls render inline so you can watch it work.
- **Query-path replay** — every agent run (query/mutation/chat) records its traversal (searches → reads → writes) as a compact notation, persisted under `<bundle>/.traces/`. The graph view lists recent runs; selecting one replays the path as numbered directed hops over the graph — visited concepts ringed, search hits dotted, everything else faded.
- **CLI** — `pnpm agent:query "..."` / `pnpm agent:mutate "..."` smoke entries.
- **Profiles** — optionally host several isolated memories on one server, each selected by its own API key. See [Profiles](#profiles-several-isolated-memories-on-one-server).

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

This fork publishes `ghcr.io/reason-labs/understory` **only when a `v*` tag is
pushed**, so `:latest` is the newest release, not `main`. To run `main`, build
from source as above. For a Portainer repository stack, use
[docker-compose.portainer.yml](docker-compose.portainer.yml), which points at
that image and forwards the same settings as `docker-compose.yml`.

(The upstream image, `ghcr.io/thecodacus/understory`, is upstream's code and
lacks everything listed under [What this fork adds](#what-this-fork-adds).)

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
LLM_API_BASE_URL=http://host.docker.internal:8080/v1 LLM_MODEL=
```

> When understory runs in Docker, `localhost` is the container itself, not the
> host — so a llama-server on the host is reached at `host.docker.internal`
> (the compose files above already map it via `extra_hosts`). Running from
> source on the same box as llama-server, use `http://localhost:8080/v1`.

**Local llama.cpp with DeepSeek fallback:**
```bash
LLM_API_BASE_URL=http://host.docker.internal:8080/v1 LLM_MODEL= \
LLM_FALLBACK_API_BASE_URL=https://api.deepseek.com/v1 LLM_FALLBACK_API_KEY=sk-... LLM_FALLBACK_MODEL=deepseek-chat
```

> **Removed in this fork:** the old `LLM_PROVIDER` enum and per-provider keys
> (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`,
> `LLAMACPP_BASE_URL`, `LLAMACPP_API_KEY`, `LOCAL_BASE_URL`, `LOCAL_API_KEY`)
> are gone. Setting any of them is a startup error with a migration message
> rather than a silent fallback to a hardcoded hosted endpoint. (Under Docker,
> `docker-compose.yml` no longer forwards them, so a leftover one in `.env` is
> simply ignored.)

Then:

- **Web UI** → http://localhost:3800 — browse the memory, watch the graph, chat with the agent
- **MCP endpoint** → `http://localhost:3800/mcp` (streamable HTTP) — register it in any MCP client:
  ```bash
  claude mcp add --transport http ustory http://localhost:3800/mcp
  ```
- Your agent now has `memory_query` / `memory_add` / `memory_update` / `memory_status` / `memory_maintain` / `memory_explain` / `memory_forget`, and gets a seed overview of the memory at every session start.

Teach it something (`memory_add`: "We deploy on Fridays, never Mondays"), then open the graph and watch the concept wire itself in. Deploying with Portainer? See [Pre-built image](#pre-built-image).

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

**Running directly on a bundle that lives inside a clone:** `./sample-bundle` is a folder in this repository, and `GIT_AUTOCOMMIT` is on by default, so every mutation would be committed to *this repository's* history (the server prints a `WARNING` at startup saying so). For a throwaway try-out add `GIT_AUTOCOMMIT=false`, or copy the bundle somewhere outside the clone first (`cp -r sample-bundle ~/my-bundle`).

Or build the container yourself: `docker compose up --build` (the repo's [docker-compose.yml](docker-compose.yml) builds from source and mounts `./sample-bundle` unless `BUNDLE_PATH` is set in `.env`).

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

**The default is open, and `memory_forget` is reachable.** With no `AUTH_TOKEN`, anyone who can reach the port can call `memory_add`, `memory_update`, `memory_forget` and `memory_maintain`. The server prints a warning at startup when auth is off and it listens on all interfaces. Set `AUTH_REQUIRED=true` to make it refuse to start without a token, and use `BIND_ADDRESS` (compose) or `HOST` (running node directly) to keep the port off networks you do not trust, for example `BIND_ADDRESS=127.0.0.1` or your Tailscale IP. In Docker the port mapping decides who can connect; `HOST` alone does not.

#### Read-only access

Give an agent that should only *read* the memory its own token:

```bash
AUTH_TOKEN=$(openssl rand -hex 24)            # full access: keep this one to yourself
AUTH_TOKEN_READONLY=$(openssl rand -hex 24)   # look, but never change
```

| | `AUTH_TOKEN` | `AUTH_TOKEN_READONLY` | no / wrong token |
|---|---|---|---|
| `memory_query`, `memory_status`, `memory_explain` | yes | yes | 401 |
| `memory_add`, `memory_update`, `memory_forget`, `memory_maintain` | yes | **403** | 401 |
| `/api` GET (browse, search, graph, dream status and diffs) | yes | yes | 401 |
| `/api` POST (web chat, accept or reject a dream) | yes | **403** | 401 |

A read-only client's tool list shows only the three read tools. The check is made on the request itself (including each call inside a batch), so a client cannot get a write through by naming it anyway. It needs `AUTH_TOKEN` as well (otherwise the server is open and every caller already has full access), and the two must differ; the server refuses to start otherwise. Not available in profile mode, where each profile's key is full access to that profile.

```bash
claude mcp add --transport http ustory-readonly http://host:3800/mcp \
  --header "Authorization: Bearer <read-only token>"
```

Every tool also declares behaviour hints (`readOnlyHint`, `destructiveHint`) so clients can prompt accordingly. These describe the tool; the read-only token is what enforces it.

### Profiles: several isolated memories on one server

One server can host a separate memory per profile, for example `work`, `health` and a side project. Each profile has its own bundle on disk and its own API key, and the key is the only thing that selects a memory. A request made with the `work` key is served from the `work` bundle and cannot name, read or search any other profile. The URLs stay the same for everyone.

Turn it on by pointing `PROFILES_ROOT` at a directory (it takes precedence over `BUNDLE_ROOT`):

```yaml
services:
  understory:
    # ...as in the quick start, plus:
    volumes:
      - understory-profiles:/profiles
    environment:
      PROFILES_ROOT: /profiles
      ADMIN_TOKEN: ${ADMIN_TOKEN:-}   # optional, enables the /admin API

volumes:
  understory-profiles:
```

Manage profiles with the bundled CLI. It works against a running server, which picks up changes on the next request:

```bash
docker compose exec understory node server/dist/profiles-cli.js create work
# profile: work
# api key: usk_...        <- shown once; only a hash is stored

docker compose exec understory node server/dist/profiles-cli.js list
docker compose exec understory node server/dist/profiles-cli.js rotate work          # old key stops working
docker compose exec understory node server/dist/profiles-cli.js remove work          # revokes the key, keeps the memory
docker compose exec understory node server/dist/profiles-cli.js remove work --purge  # also deletes the memory
```

From a source checkout the same commands are `PROFILES_ROOT=... pnpm --filter @understory/server profiles <command>`.

Give each agent its profile's key:

```bash
claude mcp add --transport http work-memory http://host:3800/mcp \
  --header "Authorization: Bearer usk_..."
```

The web UI asks for a key and opens that profile's memory. The sidebar shows which profile you are in, with a `switch` button to enter a different key.

Things worth knowing:

- In profile mode every request needs a profile key. `AUTH_TOKEN` is not used.
- With `ADMIN_TOKEN` set, `GET/POST /admin/profiles`, `POST /admin/profiles/<name>/rotate` and `DELETE /admin/profiles/<name>[?purge=true]` do what the CLI does. The admin token manages profiles but cannot open any memory, and a profile key cannot reach `/admin`.
- Layout is `PROFILES_ROOT/<name>/` per bundle plus `PROFILES_ROOT/profiles.json` for the registry. To move an existing bundle into a profile, put it at `PROFILES_ROOT/<name>/` and run `create <name>`, which adopts the directory.
- The query cache, hot memory, traces, git history and dreaming are all per profile. Dreams run one profile after another.
- The stdio transport serves one bundle. Point its `BUNDLE_ROOT` at a profile's directory to use that memory locally.

#### Keeping something private: give it its own profile

There is no per-concept privacy class (a `private` flag on a concept inside a shared bundle). That was considered and deliberately not built: every way of reading a concept (search, the graph, browse, the seed overview, chat, caches, hot memory, `memory_explain`, `memory_forget`) would have to filter, and a single missed path leaks. A profile has nothing to filter. Private material lives in its own bundle, git history, traces, caches and dream history, behind its own key, and no request made with another key can reach it.

To keep something private:

1. Create a profile for it (`profiles-cli.js create private`) and give that key only to the agents and people who should see it.
2. Put the sensitive concepts in that profile's bundle, using `memory_add` with its key, or by copying files into `PROFILES_ROOT/private/` before running `create private`, which adopts the directory.
3. Remove them from the old bundle. If they had a source, `memory_forget` does that cleanly. Git history in the old bundle still holds earlier versions, as it does for any forgotten concept (see [Forgetting](#forgetting)).

What a profile does **not** protect, so you can decide whether it is enough:

- **Anyone holding a profile's key sees all of it.** There are no finer classes inside a profile; split it into two profiles instead.
- **The LLM is shared.** Every profile uses the server's one `LLM_*` configuration, so text from every profile is sent to that model. If private memory must never reach a hosted model, run the whole server on a local model. There is no per-profile model.
- **The host.** Whoever can read `PROFILES_ROOT` (or its backups) can read every profile's files.
- **Nothing links across profiles.** A concept in one cannot reference or be cited by another, by design. To let a private concept inform a shared one, copy a sanitised version across yourself.

Isolation is tested for the run history in `/api/dream/status`, which is process-wide inside the server: each profile's key sees only its own dream runs. The query cache and hot memory are keyed per bundle, and the traces, git history, reviews and tombstones live inside each profile's own directory.

### Serving under a sub-path

The web UI uses relative URLs throughout, so it works behind a path-prefixing reverse proxy — no configuration needed. Any proxy that strips the prefix before forwarding works:

```bash
# Tailscale
tailscale serve --bg --set-path=/understory http://localhost:3800
```

```caddy
# Caddy
handle_path /understory/* {
  reverse_proxy localhost:3800
}
```

One rule: open the UI with a trailing slash (`https://host/understory/`, not `.../understory`) — relative URLs resolve against the last path segment, so without the slash they escape the prefix. If your proxy can redirect `/understory` → `/understory/`, do that.

### Seed memory

A client LLM that only sees four bare tool names never gets the instinct to check memory. So at **session start** the server injects a compact overview of what the knowledge base contains (directories, concepts with types + descriptions, recent activity) through both channels that reach the model:

1. the MCP initialize **`instructions`** field (clients like Claude put it in the system prompt), and
2. the **`memory_query` tool description** — the universal fallback every tool-calling client loads.

The seed regenerates fresh for every new session. After `memory_add` / `memory_update` in a long-lived (stdio) session, the tool description refreshes via `tools/list_changed`, so the session sees its own writes. Out-of-band edits (hand edits, other clients) are picked up on the next session.

### Graph health & maintenance

Memory is a graph, not a pile of notes, and graphs rot: concepts go **orphaned** (nothing links to them) and links go **broken**. Two mechanisms keep it healthy:

- **Write-time linking** — new knowledge either enriches the concept it belongs to (an attribute of an existing entity is patched in, not filed separately) or, when it's a distinct entity, is created *and* back-linked from related concepts. Contradictions are superseded in place, never left standing alongside the old value.
- **`memory_maintain`** — a deterministic lint (orphans + broken links, surfaced in `memory_status` under `graph`) drives an internal agent to wire orphans into related concepts and fix dangling links. Run it periodically to counter drift; it's a no-op when the graph is already healthy.
- **`memory_explain`** — deterministic (no LLM): for one concept, its recorded `sources` (with the agent run that wrote it), its change history (git when `GIT_AUTOCOMMIT` is on, otherwise `log.md`), and what links to and from it. Missing evidence is reported as a caveat rather than guessed.

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

`status` returns the resolved schedule, signal set and change budget, the next
run time, and the last 20 runs with outcome, duration, files changed, and (for
a run that kept changes) its commits and a `revertCommand`. Run history is
in-memory and resets with the process, by design: it describes this process's
behaviour, and a stale history read off disk after a restart would mislead.
`commits` lists the memory's last 20 dream commits straight from git, so it
does survive restarts.

A dream that fails is logged to stderr, and its outcome is recorded — including
`rolled_back`, which means it failed and the bundle was fully restored, and
`too_broad` (below). Both are materially different events from `partial`, which
means rollback itself failed and a human needs to look.

#### Guardrails: change budget and undo

A dream may change at most `DREAM_MAX_CHANGES` concepts (default **15**;
creating, editing and deleting all count, a concept edited twice counts once).
The model is told the budget up front. A run that goes over it anyway is
rolled back **in full** and recorded as `too_broad`, with the concepts it
touched listed in the summary: a half-applied consolidation (say, a split whose
hub was never rewritten) is worse than none. An invalid value falls back to the
default with a warning, never to "unlimited". With `MUTATION_ROLLBACK=false`
nothing can be rolled back, so an over-budget run is reported as `partial`.

#### Verification, derived concepts and step limits

Before a dream commits, deterministic checks (no LLM, `DREAM_VERIFY`, on by
default) run inside the same transaction, so a failure rolls the whole run back
and is reported as `unverified` with the reasons:

- nothing is **deleted** unless duplicate merging is enabled (`DREAM_SIGNALS=all`);
- the run introduces no **new broken link** (links that were already broken are not its fault);
- nothing written **cites or mentions a forgotten source**;
- a **derived** concept cites the concepts it came from, those exist, and any
  quoted excerpt really appears in the concept it names.

A dream that **runs out of steps** is rolled back, never kept half-done (an
interactive `memory_update` that hits the limit is still reported as `partial`,
since someone is there to look).

A **derived** concept (`derived: true`) is a machine-written synthesis such as the
overview the `insights` signal writes. It cites the concepts it links to, ranks
below primary concepts in search (at equal relevance the primary one wins), is
flagged in search results and `memory_explain`, and the `insights` signal never
feeds it back in as input, so an inference cannot harden into a "fact" over
successive passes. The model marks an overview with `derived=true` when it writes
it; a dream whose only signal is `insights` marks every concept it creates. Forgetting a source
still cascades through derived concepts (they cite what they summarise).

Every commit a dream makes starts with `dream:` (including the `dream: revert:`
of a rolled-back run), so its changes are easy to find:

```bash
git -C "$BUNDLE_PATH" log --oneline --grep '^dream:'
```

A dream holds the bundle write lock for its whole run, so its commits are
contiguous and one range revert undoes exactly that run. The `revertCommand` in
`/api/dream/status` is that command. Under Docker, run it in the container (it
has git configured for the bundle; the host's git may refuse the root-owned
files), ideally while no dream or mutation is running:

```bash
docker compose exec understory git -C /bundle revert --no-edit <first>^..<last>
```

#### Review mode

`DREAM_MODE=review` runs dreams for real, with your model, but nothing live
changes: the dream works in a throwaway `git worktree` of the bundle and its
commits are left on a `dream/<timestamp>` branch for you to accept or reject.
It is the way to see what dreaming would actually do to your memory before
letting it apply on its own. Requires `GIT_AUTOCOMMIT=true`.

In the web UI, **Reviews** (sidebar footer, with a badge while one is pending)
shows each review's summary, the concepts it changes and a coloured diff, with
Accept and Reject buttons. The same is available over the API:

```bash
curl localhost:3800/api/dream/reviews                       # pending reviews: summary, concepts changed
curl localhost:3800/api/dream/reviews/<id>/diff             # the changes, as a plain-text diff
curl -X POST localhost:3800/api/dream/reviews/<id>/accept   # merge into the live memory
curl -X POST localhost:3800/api/dream/reviews/<id>/reject   # discard
```

(Add `-H "Authorization: Bearer $AUTH_TOKEN"` when auth is on.)

- One review at a time: while one is pending, the next dream is skipped, so
  unreviewed changes never stack.
- A dream that fails, is too broad, or changes nothing leaves no branch.
- Accept merges under the write lock. Your own edits made while the review was
  pending are fine: `log.md` keeps both sides' entries and every `index.md` is
  regenerated, never merged line by line. If the dream and you changed the
  **same concept**, accept is refused with `409` and the conflicting paths;
  nothing is merged and the review stays, so reject it or resolve it by hand.
- Accept returns a `revertCommand` (`git revert -m 1 ...`) that undoes it.
- The dream's trace is kept in the live `.traces/` either way.
- Pending reviews also show under `reviews` in `/api/dream/status`, and the
  dream log line says `dream ready for review: dream/<id>`.

#### Turning it on under Docker

Set `DREAM_INTERVAL` (e.g. `6h`) in `.env` and recreate the container
(`docker compose up -d`). Both compose files forward it, along with
`DREAM_SIGNALS`, `DREAM_INSIGHTS`, `DREAM_MAX_CHANGES` and `DREAM_MODE`; it is off unless set, since dreaming
spends tokens with nobody watching. The startup log confirms it:
`dreaming: every 6h — signals: ...`.

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

#### Mutation deadline

An agent that calls `memory_add` usually gives up after a fixed time (commonly 300 s). A local model that keeps searching and reading until then is aborted, the run is rolled back, and the fact is never stored. Set `AGENT_MUTATION_DEADLINE` to the time by which a mutation must be *completely finished*, a little under your caller's timeout (`270s` for a 300 s caller), and the run is walked through three phases:

| Phase | From | What the run may do |
|---|---|---|
| explore | start | everything |
| write | 65% of the deadline | only `write_concept` and `patch_concept`, told to stop reading and store it |
| wrap | 90% | no tools; it must say what it changed and finish |

Deleting is never forced by a clock. If the run reaches wrap-up with nothing stored it is reported as a **failure** ("nothing was saved"), never as a success with an empty file list; if it stored something in the write phase, its summary says it was cut short and may have linked fewer related concepts. Off unless set; dreams and forgetting are unattended and never use it; `memory_query` is unaffected. The server logs the setting at startup (`mutation deadline: ...`).

### Provenance

Every concept written through the agent records where its knowledge came from in a `sources` frontmatter list:

```yaml
sources:
  - ref: trace:mt4oplu4-tzle3       # the agent run that wrote it (see .traces/)
    at: 2026-10-07
  - ref: https://example.com/spec   # an origin the instruction cited
    quote: "Deploys freeze on Fridays."
    at: 2026-10-07
```

Runs are cited automatically; the agent adds URLs, documents or people only when the instruction names them. Sources are append-only through the tools (overwrites and patches keep earlier entries; the list is capped at 50, and run citations are limited to the newest 10 so frequent edits never push out the real origins `memory_forget` relies on). `sources` is an optional producer-defined key, so existing bundles stay valid, and `lint` lists concepts without it under `unsourced` without marking the bundle unhealthy.

When a write changes a fact, the agent records the old value in `history` instead of leaving it in the body (a concept never asserts two contradictory facts):

```yaml
history:
  - date: 2026-10-07
    was: Office was at 12 Elm St
    reason: moved
    source: trace:mt4oplu4-tzle3
```

The trail is tool-managed and append-only (a model can't overwrite or null it), capped at the newest 5; git holds the full record. `memory_explain` shows it under "Superseded facts".

#### Forgetting

`memory_forget` retracts a source (URL, `trace:<id>`, or bundle path) or a whole concept, and everything derived from it. **It defaults to a dry run** that lists what would change; call it again with `dry_run=false` to apply.

- Concepts whose only provenance is forgotten are deleted, and the cascade follows: anything citing a deleted concept as its sole source goes too.
- Concepts with mixed provenance, or that link to a deleted concept, are rewritten by an internal agent (transactional; if it fails nothing changes). Known excerpts are checked afterwards and flagged if still present.
- `sources` and `history` entries for the forgotten material are stripped, `log.md` bullets linking to deleted concepts are removed, and run traces that cited or touched affected concepts are deleted (they store instruction and answer text). Caches are cleared.
- The source is **tombstoned** in `.forgotten.json` (hashes only), so writes citing it are refused afterwards, including from dream passes. `memory_add` / `memory_update` also refuse input that merely *mentions* a forgotten URL or bundle path, so re-adding the fact uncited doesn't slip through. To allow a source again, delete its hash entry from `.forgotten.json`.
- **Pending dream reviews** (`DREAM_MODE=review` branches) hold a full copy of the bundle from before the forget, so accepting one later could merge derived material back in. `memory_forget` lists and rejects the pending reviews that change an affected concept or cite a forgotten source, and accepting any dream refuses (`forgotten`) if a changed concept cites or mentions a forgotten source. Dreams re-run, so a rejected review costs one pass.
- **Not erased:** git history still contains earlier versions. If that matters, rewrite history separately (e.g. `git filter-repo`) after forgetting.

This design mirrors the pattern in Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (index.md + log.md, create-vs-enrich, lint for orphans). Deferred from that pattern until scale warrants: an explicit page-type schema, and hybrid FTS5+embedding search (the naive scan in `search.ts` is fine into the low thousands of concepts).

## Tests

```bash
pnpm -r build && pnpm test                 # unit tests, core + server (CI runs the same)
node scripts/rollout-test.mjs <bundle>     # end-to-end on a temp COPY of <bundle>, real model (LLM_* env)
pnpm --filter @understory/server exec tsx scripts/mcp-smoke.mts   # MCP stdio round-trip (needs SMOKE_BUNDLE + an API key)
```

Unit tests mock the model, so they cannot show whether a prompt works.
`scripts/rollout-test.mjs` exercises each user-visible feature against a real
model on a copy of your bundle; it never touches the original.

For a full walk-through (every feature, the Docker image, profiles, and a
multi-week soak with a go/no-go table) see [docs/TESTING.md](docs/TESTING.md).
It uses `scripts/make-test-bundle.mjs` (a predictable bundle), `dream-now.mjs`
(run one dream now), `mcp-call.mjs` (call a tool over HTTP) and `soak-report.mjs`
(one-screen health summary).

## What this fork adds

Compared with [upstream](https://github.com/thecodacus/understory):

| Area | Change |
|---|---|
| Write safety | Transactional mutations with rollback ([Mutation safety](#mutation-safety)); `GIT_AUTOCOMMIT` on by default; a startup warning when the bundle sits inside another git repository |
| Mutation deadline | `AGENT_MUTATION_DEADLINE` walks an interactive `memory_add` / `memory_update` through explore, write-only and wrap-up phases so it stores its fact before the caller times out ([Mutation deadline](#mutation-deadline)) |
| Provenance | Per-fact `sources` (a run's own citation is kept to the newest 10 so real origins survive), capped `history` of superseded facts, `memory_explain` ([Provenance](#provenance)) |
| Forgetting | `memory_forget`: dry-run by default, cascades through derived concepts, rewrites mixed ones, tombstones the source (hashes only), clears traces and caches, and rejects pending dream reviews that would undo it ([Forgetting](#forgetting)) |
| Dreaming | Per-signal control (`DREAM_SIGNALS`), change budget with full rollback (`DREAM_MAX_CHANGES`), `dream:`-prefixed commits with a one-command revert, deterministic verification before commit (`DREAM_VERIFY`), step-limited dreams rolled back, derived concepts for syntheses, review mode (`DREAM_MODE=review`) with a web panel, `/api/dream/preview` and `/api/dream/status` |
| Security | CORS locked to same-origin unless `CORS_ORIGINS` is set; `AUTH_REQUIRED=true` refuses to start without `AUTH_TOKEN`; a second read-only token (`AUTH_TOKEN_READONLY`); tool annotations (`readOnlyHint`, `destructiveHint`); a startup warning when auth is off on all interfaces ([Auth](#auth)) |
| Config | Single `LLM_API_*` provider config (legacy per-provider keys removed); `HOST` / `BIND_ADDRESS` for who can connect; `BUNDLE_PATH` for the compose mount; every documented setting forwarded by both compose files |
| Ops | `/health`; CI (build, tests, container image build) on every PR, Docker publish on release tags only; `docs/TESTING.md` with `scripts/rollout-test.mjs`, `make-test-bundle.mjs`, `dream-now.mjs`, `mcp-call.mjs` and `soak-report.mjs`; recall benchmark (`pnpm bench:recall`) |

Upstream changes are merged in periodically (`git fetch upstream && git merge upstream/main`).

## Updating a deployment

The home deployment runs `docker-compose.yml` from a clone of this repo.

```bash
cd /path/to/understory
git rev-parse --short HEAD                         # note the current commit: your way back
tar czf ~/understory-bundle-$(date +%F).tgz -C "$BUNDLE_PATH" .   # back up the bundle
git pull && docker compose up -d --build
docker compose logs --tail 25                      # model, auth, step budget, mutation deadline, dreaming; read any WARNING
```

Rolling back code: `git checkout <previous commit> && docker compose up -d --build`.
Rolling back content: the bundle is its own git repo (`GIT_AUTOCOMMIT`), so
`git -C "$BUNDLE_PATH" log` / `revert` undoes individual runs.

Keep local deployment settings in `.env` (and any compose changes in a
`docker-compose.override.yml`), never in tracked files, so `git pull` never conflicts.

## Environment

See [.env.example](.env.example) for every setting with its default. `BUNDLE_ROOT`
is required (Docker sets it to `/bundle`; choose the host directory with
`BUNDLE_PATH`). Unless the row says otherwise, both compose files forward each
setting from `.env`; an empty value means "use the default".

| Setting | Default | Purpose |
|---|---|---|
| `LLM_API_BASE_URL` / `LLM_API_KEY` / `LLM_API_FORMAT` / `LLM_MODEL` | — / — / `openai` / auto | Primary model |
| `LLM_FALLBACK_API_BASE_URL` / `_API_KEY` / `_API_FORMAT` / `_MODEL` | off | Fallback model; also `LLM_FALLBACK_ALLOW_FOR`, `LLM_FALLBACK_RETRY_429` |
| `PORT` / `HOST` | `3800` / all interfaces | Port and interface when running node directly. In Docker the container always listens on 3800 and `BIND_ADDRESS` plus the compose port mapping decide who can connect |
| `AUTH_TOKEN` / `AUTH_REQUIRED` | open / `false` | Bearer auth on `/mcp` and `/api`; refuse to start open |
| `AUTH_TOKEN_READONLY` | unset | A second token that can only read (see [Read-only access](#read-only-access)); needs `AUTH_TOKEN` |
| `BIND_ADDRESS` | all interfaces | Host interface the compose file publishes the port on (`127.0.0.1`, a Tailscale IP) |
| `CORS_ORIGINS` | same-origin | Comma list, or `*` |
| `PROFILES_ROOT` / `ADMIN_TOKEN` | off | [Profiles](#profiles-several-isolated-memories-on-one-server) (commented out in compose) |
| `GIT_AUTOCOMMIT` / `MUTATION_ROLLBACK` | `true` / `true` | Commit every mutation; transactional runs |
| `LLM_TIMEOUT` | none | Deadline for one model run, e.g. `30m` |
| `AGENT_MAX_STEPS` | `12` | Steps per agent run |
| `AGENT_MUTATION_DEADLINE` | off | Time by which an interactive `memory_add` / `memory_update` must finish (for example `270s`); see [Mutation deadline](#mutation-deadline) |
| `QUERY_CACHE` / `QUERY_CACHE_TTL` | `true` / `24h` | Repeated-query cache |
| `HOT_MEMORY` / `HOT_MEMORY_TTL` | `true` / `1h` | Recent working set checked before a full run |
| `DREAM_INTERVAL` / `DREAM_SIGNALS` / `DREAM_INSIGHTS` | off | [Dreaming](#dreaming-autonomous-consolidation) |
| `DREAM_MAX_CHANGES` | `15` | Concepts one dream may change before it is rolled back |
| `DREAM_VERIFY` | `true` | Deterministic checks before a dream commits; `false` turns them off ([Verification](#verification-derived-concepts-and-step-limits)) |
| `DREAM_MODE` | `apply` | `review` leaves each dream on a `dream/*` branch to accept or reject ([Review mode](#review-mode)) |
