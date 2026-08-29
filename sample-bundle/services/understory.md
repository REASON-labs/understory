---
type: Service
title: Understory Service
description: >-
  AI agent service running on port 3800 with Docker host networking, using
  llamacpp via llama-swap for LLM inference.
tags:
  - understory
  - llm
  - docker
  - llamacpp
  - llama-swap
timestamp: '2026-08-22T19:09:59.797Z'
---
## Overview

Understory is an AI agent service running on **port 3800** inside a Docker container with **host networking** (`network_mode: host`).

- **Docker compose file:** `/home/jay/ai/understory/docker-compose.yml`
- **Data directory:** `/home/jay/ai/understory/bundle/` (mounted inside the container as `/bundle`)

## LLM Provider Configuration

Understory uses the **`llamacpp`** provider (not `anthropic` or `openrouter`). It uses legacy provider config (`LLM_PROVIDER` + per-provider vars), NOT the `LLM_API_*` variables.

### Required environment variables

| Variable | Value |
|---|---|
| `LLM_PROVIDER` | `llamacpp` |
| `LLAMACPP_BASE_URL` | `http://127.0.0.1:8080` (points to llama-swap) |
| `LLM_MODEL` | `qwen3.6-35b` |
| `GIT_AUTOCOMMIT` | `false` (git is not installed inside the container) |

> **Note:** The default provider is `anthropic`. If `LLM_PROVIDER` is unset, Understory will attempt to use Anthropic and fail without an API key.

## Known Issues

- **`git autocommit failed: spawn git ENOENT`** — Git is not installed inside the Understory container. Autocommit is disabled (`GIT_AUTOCOMMIT=false`). This is not a blocking issue.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `x-api-key header is required` | `LLAMACPP_BASE_URL` is unset or points to a non-working llama-swap endpoint | Ensure `LLAMACPP_BASE_URL=http://127.0.0.1:8080` is set and llama-swap is running |
| `ECONNREFUSED 172.17.0.1:8080` | Container is on bridge networking but llama-swap binds to `127.0.0.1` only | Use `network_mode: host` in docker-compose |

## History

- **2026-08-22:** Fixed port routing issue. Understory was on bridge network trying to reach llama-swap at `172.17.0.1:8080`, but llama-swap binds to `127.0.0.1` only. Switched to `network_mode: host` and corrected env vars to use `LLM_PROVIDER=llamacpp` + `LLAMACPP_BASE_URL=http://127.0.0.1:8080`.

# Overview

Understory is an AI agent service running on **port 3800** inside a Docker container with **host networking** (`network_mode: host`).

- **Docker compose file:** `/home/jay/ai/understory/docker-compose.yml`
- **Data directory:** `/home/jay/ai/understory/bundle/` (mounted inside the container as `/bundle`)

## Agent Roles

- **Merch Store design authoring** — The Hermes agent uses Understory to create SVGs, run `render.sh`, interpret validation output, and iterate on designs for the [Merch Store pipeline](/devops/merch-store.md).

# Agent Roles

- **Merch Store design authoring** — The Hermes agent uses Understory to create SVGs, run `render.sh`, interpret validation output, and iterate on designs for the [Merch Store pipeline](/devops/merch-store.md).
- **Merch Design skill** — The [merch-design skill](/devops/merch-design-skill.md) provides the procedural workflow for terminal/typed-text style designs targeting Printful.
