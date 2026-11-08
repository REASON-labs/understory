import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";
import { KnowledgeBase } from "@understory/core";
import { buildApp } from "../src/app.js";
import { singleMemoryHost } from "../src/host.js";
import { checkFilePath, hashOf } from "../src/api/files.js";

const FULL = "full-token-123";
const RO = "readonly-token-456";

let root: string;
let kb: KnowledgeBase;
let server: Server | undefined;
let base: string;

async function start(fileApi: boolean, git = false): Promise<void> {
  kb = new KnowledgeBase(root, { gitAutocommit: git });
  if (git) expect((await kb.ensureGitReady()).ok).toBe(true);
  await kb.writeConcept("/areas/home.md", { type: "area", title: "Home" }, "Home things.\n", "Seed.");
  const app = buildApp(singleMemoryHost(kb, { full: FULL, readOnly: RO }), { fileApi });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

const call = (method: string, url: string, body?: unknown, token = FULL) =>
  fetch(base + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

const put = (body: Record<string, unknown>, token = FULL) => call("PUT", "/api/file", body, token);
const note = (p: string, mode: string, extra: Record<string, unknown> = {}) =>
  put({ path: p, mode, frontmatter: { type: "upkeep", title: "Garbage", every: "1 week on Tuesday" }, body: "Bins out.\n", ...extra });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-files-"));
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("checkFilePath", () => {
  it("canonicalizes and accepts ordinary paths", () => {
    expect(checkFilePath("household/upkeep/garbage.md")).toBe("/household/upkeep/garbage.md");
    expect(checkFilePath("/writing/drafts/2026-11-08_a-b.md")).toBe("/writing/drafts/2026-11-08_a-b.md");
  });
  it.each([
    ["/.git/config.md"],
    ["/.traces/x.md"],
    ["/household/.hidden.md"],
    ["/household/../areas/home.md"],
    ["/household//x.md"],
    ["/household/x.txt"],
    ["/household/a b.md"],
    [""],
    [42],
  ])("refuses %s", (p) => {
    expect(() => checkFilePath(p)).toThrow();
  });
});

describe("/api/file", () => {
  it("is not mounted unless FILE_API is on", async () => {
    await start(false);
    expect((await note("/household/upkeep/garbage.md", "create")).status).toBe(404);
    expect(await kb.bundle.exists("/household/upkeep/garbage.md")).toBe(false);
  });

  it("creates the exact file, then refuses a second create", async () => {
    await start(true);
    const r = await note("/household/upkeep/garbage.md", "create");
    expect(r.status).toBe(201);
    const j = (await r.json()) as { path: string; hash: string; created: boolean };
    expect(j).toMatchObject({ path: "/household/upkeep/garbage.md", created: true });
    const c = await kb.readConcept("/household/upkeep/garbage.md");
    expect(c.frontmatter).toMatchObject({ type: "upkeep", title: "Garbage", every: "1 week on Tuesday" });
    expect(c.body).toBe("Bins out.\n");
    expect(j.hash).toBe(hashOf(c.raw));
    expect((await note("/household/upkeep/garbage.md", "create")).status).toBe(409);
  });

  it("keeps index.md and log.md up to date", async () => {
    await start(true);
    await note("/household/upkeep/garbage.md", "create");
    expect(await kb.bundle.exists("/household/index.md")).toBe(true);
    const log = await fs.readFile(path.join(root, "log.md"), "utf-8");
    expect(log).toContain("/household/upkeep/garbage.md");
  });

  it("replace needs an existing file; upsert does either", async () => {
    await start(true);
    expect((await note("/household/dates/x.md", "replace")).status).toBe(404);
    expect((await note("/household/dates/x.md", "upsert")).status).toBe(201);
    expect((await note("/household/dates/x.md", "upsert", { body: "Changed.\n" })).status).toBe(200);
    expect((await kb.readConcept("/household/dates/x.md")).body).toBe("Changed.\n");
  });

  it("GET returns the content and hash; ifMatch guards writes and deletes", async () => {
    await start(true);
    await note("/household/help/a.md", "create");
    const g = await call("GET", "/api/file?path=/household/help/a.md");
    expect(g.status).toBe(200);
    const { hash, body } = (await g.json()) as { hash: string; body: string };
    expect(body).toBe("Bins out.\n");
    expect((await note("/household/help/a.md", "replace", { ifMatch: "0".repeat(64) })).status).toBe(409);
    const ok = await note("/household/help/a.md", "replace", { ifMatch: hash, body: "Second.\n" });
    expect(ok.status).toBe(200);
    const newHash = ((await ok.json()) as { hash: string }).hash;
    expect((await call("DELETE", `/api/file?path=/household/help/a.md&ifMatch=${hash}`)).status).toBe(409);
    expect((await call("DELETE", `/api/file?path=/household/help/a.md&ifMatch=${newHash}`)).status).toBe(200);
    expect(await kb.bundle.exists("/household/help/a.md")).toBe(false);
    expect((await call("DELETE", "/api/file?path=/household/help/a.md")).status).toBe(404);
  });

  it("ignores a caller-supplied timestamp and requires a type", async () => {
    await start(true);
    await put({ path: "/household/a.md", mode: "create", frontmatter: { type: "t", timestamp: "1999-01-01" }, body: "x" });
    expect(String((await kb.readConcept("/household/a.md")).frontmatter.timestamp)).not.toContain("1999");
    const r = await put({ path: "/household/b.md", mode: "create", frontmatter: { title: "no type" }, body: "x" });
    expect(r.status).toBe(400);
    expect(await kb.bundle.exists("/household/b.md")).toBe(false);
  });

  it("refuses bad paths, modes and bodies without writing", async () => {
    await start(true);
    for (const p of ["/.git/x.md", "/.traces/x.md", "/index.md", "/household/log.md", "/../escape.md", "/household/x.txt"]) {
      expect((await note(p, "upsert")).status, p).toBe(400);
    }
    expect((await note("/household/x.md", "overwrite")).status).toBe(400);
    expect((await put({ path: "/household/x.md", mode: "create", frontmatter: { type: "t" } })).status).toBe(400);
    expect((await put({ path: "/household/x.md", mode: "create", frontmatter: [1], body: "x" })).status).toBe(400);
    expect(await kb.bundle.exists("/household/x.md")).toBe(false);
  });

  it("the read-only token can read but not write or delete", async () => {
    await start(true);
    await note("/household/a.md", "create");
    expect((await call("GET", "/api/file?path=/household/a.md", undefined, RO)).status).toBe(200);
    expect((await note("/household/b.md", "create", {})).status).toBe(201);
    expect((await put({ path: "/household/c.md", mode: "create", frontmatter: { type: "t" }, body: "x" }, RO)).status).toBe(403);
    expect((await call("DELETE", "/api/file?path=/household/a.md", undefined, RO)).status).toBe(403);
    expect((await call("GET", "/api/file?path=/household/a.md", undefined, "wrong")).status).toBe(401);
    expect(await kb.bundle.exists("/household/a.md")).toBe(true);
  });

  it("commits each write to git when autocommit is on", async () => {
    await start(true, true);
    const subjects = () => execFileSync("git", ["log", "--format=%s"], { cwd: root, encoding: "utf-8" }).trim().split("\n");
    const before = subjects().length;
    await note("/household/upkeep/garbage.md", "create", { summary: "Seed garbage day." });
    await call("DELETE", "/api/file?path=/household/upkeep/garbage.md");
    const log = subjects();
    expect(log.length).toBe(before + 2);
    expect(log[1]).toContain("Seed garbage day.");
    expect(log[0].toLowerCase()).toContain("deletion");
  }, 30_000);
});
