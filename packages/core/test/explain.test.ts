import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";
import { explainConcept, formatExplanation } from "../src/agent/explain.js";
import { TraceRecorder, TraceStore } from "../src/agent/trace.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-explain-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("explainConcept", () => {
  it("resolves run citations, links, and falls back to log.md for history", async () => {
    const kb = new KnowledgeBase(root);
    const rec = new TraceRecorder();
    await new TraceStore(root).save(rec.finalize("mutation", "note the deploy freeze", "done"));

    await kb.writeConcept(
      "/policy.md",
      {
        type: "note",
        title: "Deploy policy",
        sources: [
          { ref: `trace:${rec.id}`, at: "2026-10-07" },
          { ref: "https://example.com/policy", quote: "Deploys freeze on Fridays." },
        ],
      },
      "See [Runbook](/runbook.md).\n",
      "Added [policy.md](/policy.md)."
    );
    await kb.writeConcept("/runbook.md", { type: "note" }, "Back to [policy](/policy.md).\n", "Added runbook.");

    const x = await explainConcept(kb, "policy.md");

    expect(x.path).toBe("/policy.md");
    expect(x.sources[0].run).toMatchObject({ kind: "mutation", input: "note the deploy freeze" });
    expect(x.sources[1]).toMatchObject({ ref: "https://example.com/policy", quote: "Deploys freeze on Fridays." });
    expect(x.links).toEqual({ outbound: ["/runbook.md"], inbound: ["/runbook.md"] });
    expect(x.changesFrom).toBe("log");
    expect(x.changes[0].summary).toContain("Creation");
    expect(x.notes).toEqual([]);
    expect(formatExplanation(x)).toContain("> Deploys freeze on Fridays.");
  });

  it("flags missing evidence instead of inventing it", async () => {
    const kb = new KnowledgeBase(root);
    await kb.writeConcept("/old.md", { type: "note" }, "legacy\n", "x");
    // Hand-edited concept with a dangling run citation.
    await kb.writeConcept(
      "/ghost.md",
      { type: "note", sources: [{ ref: "trace:gone-12345" }] },
      "y\n",
      "y"
    );

    const old = await explainConcept(kb, "/old.md");
    expect(old.sources).toEqual([]);
    expect(old.notes.join(" ")).toMatch(/No sources recorded/);

    const ghost = await explainConcept(kb, "/ghost.md");
    expect(ghost.notes.join(" ")).toMatch(/no longer have a trace file/);
    expect(ghost.notes.join(" ")).toMatch(/Only run citations/);
  });

  it("uses git history when autocommit is on", async () => {
    const kb = new KnowledgeBase(root, { gitAutocommit: true });
    expect((await kb.ensureGitReady()).ok).toBe(true);
    await kb.writeConcept("/a.md", { type: "note" }, "v1\n", "Added a.");
    await kb.writeConcept("/a.md", { type: "note" }, "v2\n", "Changed a.");
    await kb.writeConcept("/b.md", { type: "note" }, "other\n", "Added b.");

    const x = await explainConcept(kb, "/a.md");

    expect(x.changesFrom).toBe("git");
    expect(x.changes.map((c) => c.summary)).toEqual(["update: Changed a.", "creation: Added a."]);
    expect(x.changes[0].commit).toMatch(/^[0-9a-f]{7}$/);
  }, 30_000);

  it("rejects a path that is not a concept", async () => {
    const kb = new KnowledgeBase(root);
    await expect(explainConcept(kb, "/nope.md")).rejects.toThrow();
  });
});
