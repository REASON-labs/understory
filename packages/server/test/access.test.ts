import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KnowledgeBase } from "@understory/core";
import { buildApp } from "../src/app.js";
import { singleMemoryHost } from "../src/host.js";
import { accessFor, calledTools, resolveAuthConfig } from "../src/access.js";

const FULL = "full-token-123";
const RO = "readonly-token-456";
const READ_TOOLS = ["memory_explain", "memory_query", "memory_status"];
const WRITE_TOOLS = ["memory_add", "memory_forget", "memory_maintain", "memory_update"];

let root: string;
let kb: KnowledgeBase;
let server: Server;
let base: string;

async function start(auth: string | { full?: string; readOnly?: string } | undefined): Promise<void> {
  const app = buildApp(singleMemoryHost(kb, auth));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

/** A connected MCP client sending the given bearer token (or none). */
async function client(token?: string): Promise<Client> {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    })
  );
  return c;
}

const fingerprint = async () => {
  const parts: string[] = [];
  for (const f of (await fs.readdir(root)).sort()) {
    if (f.startsWith(".")) continue;
    parts.push(f + ":" + (await fs.stat(path.join(root, f))).mtimeMs);
  }
  return parts.join("|");
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-access-"));
  kb = new KnowledgeBase(root);
  await kb.writeConcept("/svc/billing.md", { type: "Service", title: "Billing" }, "Billing handles invoices.\n", "Added billing.");
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("token settings", () => {
  it("accepts no tokens, a full token, or both", () => {
    expect(resolveAuthConfig({})).toEqual({ full: undefined, readOnly: undefined });
    expect(resolveAuthConfig({ AUTH_TOKEN: FULL })).toEqual({ full: FULL, readOnly: undefined });
    expect(resolveAuthConfig({ AUTH_TOKEN: FULL, AUTH_TOKEN_READONLY: RO })).toEqual({ full: FULL, readOnly: RO });
  });

  it("refuses a read-only token with no full token: the server would be open to everyone", () => {
    expect(() => resolveAuthConfig({ AUTH_TOKEN_READONLY: RO })).toThrow(/AUTH_TOKEN is not/);
  });

  it("refuses identical tokens", () => {
    expect(() => resolveAuthConfig({ AUTH_TOKEN: FULL, AUTH_TOKEN_READONLY: FULL })).toThrow(/must differ/);
  });

  it("keeps AUTH_REQUIRED=true meaning 'never start open'", () => {
    expect(() => resolveAuthConfig({ AUTH_REQUIRED: "true" })).toThrow(/refusing to start open/);
  });

  it("treats empty strings as unset (compose forwards empty values)", () => {
    expect(resolveAuthConfig({ AUTH_TOKEN: "", AUTH_TOKEN_READONLY: "" })).toEqual({ full: undefined, readOnly: undefined });
  });

  it("maps a presented token to an access level", () => {
    const cfg = { full: FULL, readOnly: RO };
    expect(accessFor(FULL, cfg)).toBe("full");
    expect(accessFor(RO, cfg)).toBe("read");
    expect(accessFor("nope", cfg)).toBeNull();
    expect(accessFor("", cfg)).toBeNull();
    expect(accessFor("anything", {})).toBe("full"); // open server
  });

  it("finds the tools a request would call, including inside a batch", () => {
    expect(calledTools({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_add" } })).toEqual(["memory_add"]);
    expect(
      calledTools([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_forget" } },
      ])
    ).toEqual(["memory_forget"]);
    expect(calledTools({ method: "initialize" })).toEqual([]);
    expect(calledTools(undefined)).toEqual([]);
  });
});

describe("/mcp with a full token and a read-only token", () => {
  beforeEach(() => start({ full: FULL, readOnly: RO }));

  it("answers 401 to a missing or wrong token", async () => {
    await expect(client()).rejects.toBeDefined();
    await expect(client("wrong")).rejects.toBeDefined();
    const raw = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(raw.status).toBe(401);
  });

  it("gives the full token all seven tools", async () => {
    const c = await client(FULL);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    await c.close();
  });

  it("shows the read-only token only the three read tools", async () => {
    const c = await client(RO);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(READ_TOOLS);
    await c.close();
  });

  it("lets the read-only token call the read tools", async () => {
    const c = await client(RO);
    const status = await c.callTool({ name: "memory_status", arguments: {} });
    expect(status.isError).toBeFalsy();
    expect(JSON.stringify(status.content)).toContain("conformant");
    const explained = await c.callTool({ name: "memory_explain", arguments: { path: "/svc/billing.md" } });
    expect(explained.isError).toBeFalsy();
    expect(JSON.stringify(explained.content)).toContain("Billing");
    await c.close();
  });

  it.each(WRITE_TOOLS)("answers 403 when the read-only token calls %s, and changes nothing", async (tool) => {
    const before = await fingerprint();
    const c = await client(RO);
    const args = { memory_add: { content: "x" }, memory_update: { instruction: "x" }, memory_forget: { path: "/svc/billing.md", dry_run: false }, memory_maintain: {} }[tool];
    await expect(c.callTool({ name: tool, arguments: args })).rejects.toMatchObject({ code: 403 });
    await c.close();
    expect(await fingerprint()).toBe(before);
    expect(await kb.readConcept("/svc/billing.md")).toBeTruthy(); // not forgotten
  });

  it("cannot be sidestepped by hiding a write call in a batch, or with an odd tool name", async () => {
    const post = (body: unknown) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${RO}` },
        body: JSON.stringify(body),
      });
    const batch = await post([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_forget", arguments: { path: "/svc/billing.md", dry_run: false } } },
    ]);
    expect(batch.status).toBe(403);
    expect((await batch.json()).error.message).toMatch(/read-only/);
    const unnamed = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { arguments: {} } });
    expect(unnamed.status).toBe(403);
    expect(await kb.readConcept("/svc/billing.md")).toBeTruthy();
  });

  it("does not let a read-only token be used as the full token", async () => {
    const c = await client(FULL);
    // the full token still writes (reaches the agent, which has no model here: an error, but not a 403)
    await expect(c.callTool({ name: "memory_forget", arguments: {} })).resolves.toMatchObject({ isError: true });
    await c.close();
  });
});

describe("/api with a read-only token", () => {
  beforeEach(() => start({ full: FULL, readOnly: RO }));
  const call = (token: string, method: string, url: string, body?: unknown) =>
    fetch(`${base}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("can read", async () => {
    expect((await call(RO, "GET", "/api/tree")).status).toBe(200);
    expect((await call(RO, "GET", "/api/search?q=billing")).status).toBe(200);
    expect((await call(RO, "GET", "/api/dream/status")).status).toBe(200);
  });

  it("cannot use the chat, which can write", async () => {
    const r = await call(RO, "POST", "/api/chat", { messages: [] });
    expect(r.status).toBe(403);
    expect((await r.json()).access).toBe("read");
  });

  it("cannot accept or reject a dream review", async () => {
    expect((await call(RO, "POST", "/api/dream/reviews/20260101-000000/accept")).status).toBe(403);
    expect((await call(RO, "POST", "/api/dream/reviews/20260101-000000/reject")).status).toBe(403);
  });

  it("the full token is not blocked by the guard", async () => {
    // 404 (no such review), not 403
    expect((await call(FULL, "POST", "/api/dream/reviews/20260101-000000/reject")).status).toBe(404);
  });
});

describe("an open server (no tokens) is unchanged", () => {
  it("serves full access to anyone", async () => {
    await start(undefined);
    const c = await client();
    expect((await c.listTools()).tools).toHaveLength(7);
    await c.close();
  });
});

describe("tool annotations", () => {
  beforeEach(() => start({ full: FULL }));

  it("marks the read tools read-only and the destructive ones destructive", async () => {
    const c = await client(FULL);
    const byName = Object.fromEntries((await c.listTools()).tools.map((t) => [t.name, t.annotations]));
    for (const name of READ_TOOLS) {
      expect(byName[name]).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    }
    for (const name of ["memory_update", "memory_forget", "memory_maintain"]) {
      expect(byName[name]).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(byName.memory_add).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    await c.close();
  });
});
