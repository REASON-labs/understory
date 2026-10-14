import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { KnowledgeBase, runDream } from "@understory/core";
import { dreamRouter } from "../src/api/dream.js";

/**
 * The review routes (issue #34) against a real git-backed bundle. The dream
 * itself is a stub runner that writes through the worktree KB, so no model is
 * involved; core's dream-review tests cover the run and merge logic.
 */
let server: Server;
let baseUrl: string;
let root: string;
let kb: KnowledgeBase;

const fm = (title: string) => ({ type: "note", title, description: `about ${title}` });

async function makeReview(): Promise<string> {
  const runner = async (wkb: KnowledgeBase) => {
    const scope = { commitPrefix: "dream:", touched: new Set<string>(), commits: [] as string[] };
    await wkb.withRunScope(scope, () => wkb.writeConcept("/hub.md", fm("Hub"), "# Hub\n\nSee [Stray](/stray.md).\n", "Dream added hub."));
    return { ok: true, result: { summary: "Added a hub.", filesChanged: ["/hub.md"], steps: 1, traceId: "t", commits: scope.commits } };
  };
  const report = await runDream(kb, { mode: "review" }, runner as never);
  return report.review!.branch.slice("dream/".length);
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "understory-review-api-"));
  kb = new KnowledgeBase(root, { gitAutocommit: true });
  await kb.ensureGitReady();
  await kb.writeConcept("/stray.md", fm("Stray"), "# Stray\n", "Added stray.");
  const app = express();
  app.use("/api", dreamRouter(kb));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe("dream review API", () => {
  it("lists a pending review in /dream/status and /dream/reviews", async () => {
    const id = await makeReview();

    const status = await (await fetch(`${baseUrl}/dream/status`)).json();
    expect(status.reviews.map((r: { id: string }) => r.id)).toEqual([id]);

    const list = await (await fetch(`${baseUrl}/dream/reviews`)).json();
    expect(list[0]).toMatchObject({ id, branch: `dream/${id}`, filesChanged: ["/hub.md"] });

    const one = await (await fetch(`${baseUrl}/dream/reviews/${id}`)).json();
    expect(one.summary).toMatch(/Added a hub\./);
  }, 30_000);

  it("serves the diff as plain text", async () => {
    const id = await makeReview();
    const res = await fetch(`${baseUrl}/dream/reviews/${id}/diff`);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toContain("+See [Stray](/stray.md).");
  }, 30_000);

  it("accept merges into the live bundle; the review is then gone", async () => {
    const id = await makeReview();
    expect(existsSync(path.join(root, "hub.md"))).toBe(false);

    const res = await fetch(`${baseUrl}/dream/reviews/${id}/accept`, { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, filesChanged: ["/hub.md"] });
    expect(body.revertCommand).toMatch(/^git revert -m 1 --no-edit [0-9a-f]+$/);
    expect(existsSync(path.join(root, "hub.md"))).toBe(true);
    expect((await fetch(`${baseUrl}/dream/reviews/${id}`)).status).toBe(404);
  }, 30_000);

  it("reject discards the review", async () => {
    const id = await makeReview();
    const res = await fetch(`${baseUrl}/dream/reviews/${id}/reject`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await (await fetch(`${baseUrl}/dream/reviews`)).json()).toEqual([]);
    expect(existsSync(path.join(root, "hub.md"))).toBe(false);
  }, 30_000);

  it("returns 404 for unknown reviews", async () => {
    expect((await fetch(`${baseUrl}/dream/reviews/20990101-000000`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/dream/reviews/20990101-000000/diff`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/dream/reviews/nope/accept`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${baseUrl}/dream/reviews/nope/reject`, { method: "POST" })).status).toBe(404);
  });
});
