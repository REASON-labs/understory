import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { KnowledgeBase } from "@understory/core";
import { healthRouter } from "../src/api/health.js";
import { bearerAuth } from "../src/auth.js";

/**
 * Minimal KnowledgeBase stand-in — /health only calls validate().
 * `reachable: false` is the mount-vanished case we care about.
 */
function fakeKb(opts: { reachable: boolean }): KnowledgeBase {
  return {
    validate: async () => {
      if (!opts.reachable) throw new Error("ENOENT: bundle root is gone");
      return { conformant: true, issues: [] };
    },
  } as unknown as KnowledgeBase;
}

let server: Server;
let baseUrl: string;
let bundleRoot: string;

function listen(app: express.Express): Promise<void> {
  return new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

beforeEach(() => {
  bundleRoot = mkdtempSync(path.join(tmpdir(), "understory-health-"));
  // /health reads LLM config; give it a valid generic one.
  process.env.LLM_API_BASE_URL = "http://localhost:8080/v1";
  process.env.LLM_API_FORMAT = "openai";
  process.env.LLM_MODEL = "test-model";
  delete process.env.LLM_FALLBACK_API_BASE_URL;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  rmSync(bundleRoot, { recursive: true, force: true });
});

describe("GET /health", () => {
  it("returns 200 ok with model labels when the bundle is reachable", async () => {
    const app = express();
    app.use(healthRouter(fakeKb({ reachable: true }), bundleRoot));
    await listen(app);

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.bundle).toMatchObject({ root: bundleRoot, reachable: true });
    expect(body.model).toEqual({ primary: "openai:test-model", fallback: null });
    expect(typeof body.uptimeSeconds).toBe("number");
  });

  it("reports the fallback model when one is configured", async () => {
    process.env.LLM_FALLBACK_API_BASE_URL = "https://api.deepseek.com/v1";
    process.env.LLM_FALLBACK_MODEL = "deepseek-chat";

    const app = express();
    app.use(healthRouter(fakeKb({ reachable: true }), bundleRoot));
    await listen(app);

    const body = await (await fetch(`${baseUrl}/health`)).json();
    expect(body.model.fallback).toBe("openai:deepseek-chat");
  });

  it("returns 503 degraded when the bundle is unreachable", async () => {
    const app = express();
    app.use(healthRouter(fakeKb({ reachable: false }), bundleRoot));
    await listen(app);

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.bundle.reachable).toBe(false);
    expect(body.bundle.error).toMatch(/ENOENT/);
  });

  it("never leaks the model baseURL", async () => {
    const app = express();
    app.use(healthRouter(fakeKb({ reachable: true }), bundleRoot));
    await listen(app);

    const text = await (await fetch(`${baseUrl}/health`)).text();
    expect(text).not.toContain("localhost:8080");
  });

  it("stays reachable when bearer auth is enabled", async () => {
    // The whole point: a container HEALTHCHECK carries no token.
    const app = express();
    app.use(healthRouter(fakeKb({ reachable: true }), bundleRoot));
    app.use(["/mcp", "/api"], bearerAuth("s3cret"));
    app.get("/api/tree", (_req, res) => res.json({}));
    await listen(app);

    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/tree`)).status).toBe(401);
  });
});
