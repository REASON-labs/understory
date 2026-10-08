import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase, forgottenRefs, normalizeSources } from "../src/okf/index.js";
import { planForget, runForget, formatForget } from "../src/agent/forget.js";
import { buildWriteTools } from "../src/agent/tools.js";
import { TraceRecorder, TraceStore } from "../src/agent/trace.js";
import type { MutationOutcome } from "../src/agent/agent.js";

const SECRET_URL = "https://example.com/secret-doc";
const QUOTE = "Alice has the blue badge.";

let root: string;
let kb: KnowledgeBase;

const exists = (rel: string) =>
  fs.access(path.join(root, rel)).then(() => true, () => false);

async function seed() {
  // sole-source: only the secret URL
  await kb.writeConcept(
    "/solo.md",
    // Every agent-written concept also cites the run that wrote it.
    { type: "note", title: "Solo", sources: [{ ref: SECRET_URL, quote: QUOTE }, { ref: "trace:write1" }] },
    `${QUOTE}\n`,
    "Added solo."
  );
  // derived solely from the sole-source concept: cascades
  await kb.writeConcept(
    "/derived.md",
    { type: "note", title: "Derived", sources: [{ ref: "/solo.md" }, { ref: "trace:write2" }] },
    "Summary of solo.\n",
    "Added derived."
  );
  // mixed provenance: needs a rewrite
  await kb.writeConcept(
    "/shared.md",
    {
      type: "note",
      title: "Shared",
      sources: [{ ref: SECRET_URL, quote: QUOTE }, { ref: "https://example.com/ok" }, { ref: "trace:write3" }],
      history: [{ date: "2026-10-01", was: "old claim", source: "trace:run1" }],
    },
    `Keep this fact.\n${QUOTE}\n`,
    "Added shared."
  );
  // unrelated
  await kb.writeConcept(
    "/other.md",
    { type: "note", title: "Other", sources: [{ ref: "https://example.com/other" }] },
    "Unrelated. See [shared](/shared.md).\n",
    "Added other."
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-forget-"));
  kb = new KnowledgeBase(root);
  await seed();
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Stand-in for the agent: removes the excerpt from shared.md's prose. */
const redactingRunner = (calls: string[] = []) => async (k: KnowledgeBase, instruction: string): Promise<MutationOutcome> => {
  calls.push(instruction);
  const c = await k.readConcept("/shared.md");
  await k.patchConcept(
    "/shared.md",
    {
      replaceBody: c.body.replace(QUOTE, "").trim() + "\n",
      // The real write tools cite the run on everything it touches.
      frontmatter: { sources: [...normalizeSources(c.frontmatter.sources), { ref: "trace:redact-run" }] },
    },
    "Removed material at the owner's request."
  );
  return { ok: true, result: { summary: "done", filesChanged: ["/shared.md"], steps: 1, traceId: "redact-run", truncated: false } };
};

describe("planForget", () => {
  it("cascades through sole-source derivations and flags mixed provenance", async () => {
    const plan = await planForget(kb, { source: SECRET_URL });
    expect(plan.delete).toEqual(["/derived.md", "/solo.md"]);
    expect(plan.redact).toEqual(["/shared.md"]);
    expect(plan.refs).toEqual(["/derived.md", "/solo.md", SECRET_URL].sort());
  });

  it("path mode deletes the concept and flags survivors that link to it", async () => {
    await kb.writeConcept("/mention.md", { type: "note", sources: ["https://example.com/m"] }, "See [solo](/solo.md).\n", "m");
    const plan = await planForget(kb, { path: "/solo.md" });
    expect(plan.delete).toEqual(["/derived.md", "/solo.md"]);
    expect(plan.redact).toContain("/mention.md");
  });

  it("requires exactly one target and an existing concept", async () => {
    await expect(planForget(kb, {})).rejects.toThrow(/exactly one/);
    await expect(planForget(kb, { source: "a", path: "/b.md" })).rejects.toThrow(/exactly one/);
    await expect(planForget(kb, { path: "/missing.md" })).rejects.toThrow(/No such concept/);
  });

  it("includes traces that cite the run or touched affected concepts", async () => {
    const store = new TraceStore(root);
    const touching = new TraceRecorder();
    touching.record("read_concept", "/shared.md", ["/shared.md"]);
    const t1 = touching.finalize("query", "q", "answer");
    const unrelated = new TraceRecorder();
    unrelated.record("read_concept", "/other.md", ["/other.md"]);
    const t2 = unrelated.finalize("query", "q", "answer");
    await store.save(t1);
    await store.save(t2);
    const plan = await planForget(kb, { source: SECRET_URL });
    expect(plan.traces).toContain(t1.id);
    expect(plan.traces).not.toContain(t2.id);
  });
});

describe("runForget", () => {
  it("is a dry run by default and changes nothing", async () => {
    const result = await runForget(kb, { source: SECRET_URL });
    expect(result.status).toBe("dry_run");
    expect(await exists("solo.md")).toBe(true);
    expect(await forgottenRefs(root, [SECRET_URL])).toEqual([]);
    expect(formatForget(result)).toContain("DRY RUN");
  });

  it("applies the plan: deletes, rewrites, scrubs provenance, tombstones, and cleans up", async () => {
    const store = new TraceStore(root);
    const t = new TraceRecorder();
    t.record("read_concept", "/shared.md", ["/shared.md"]);
    const trace = t.finalize("query", "what is on the badge", QUOTE);
    await store.save(trace);
    const calls: string[] = [];

    const result = await runForget(kb, { source: SECRET_URL }, { dryRun: false, runner: redactingRunner(calls) });

    expect(result.status).toBe("forgotten");
    expect(result.warnings).toEqual([]);
    expect(await exists("solo.md")).toBe(false);
    expect(await exists("derived.md")).toBe(false);

    const shared = await kb.readConcept("/shared.md");
    expect(shared.body).not.toContain(QUOTE);
    expect(shared.body).toContain("Keep this fact.");
    expect(normalizeSources(shared.frontmatter.sources).map((s) => s.ref)).toEqual(["https://example.com/ok", "trace:write3"]); // incl. no dangling cite of the deleted rewrite run
    expect(JSON.stringify(shared.frontmatter)).not.toContain(QUOTE);

    // The agent was told what to remove, and the neutral log wording.
    expect(calls[0]).toContain(QUOTE);
    expect(calls[0]).toContain("Removed material at the owner's request.");

    // Nothing leaks into the surviving log, and traces are gone.
    const log = await fs.readFile(path.join(root, "log.md"), "utf-8");
    expect(log).not.toContain("(/solo.md)");
    expect(log).not.toContain("(/derived.md)");
    expect(await store.list()).toEqual([]);

    // Tombstoned: neither the URL nor the cascaded paths can be re-cited.
    expect((await forgottenRefs(root, [SECRET_URL, "/solo.md", "https://example.com/ok"]))).toEqual([SECRET_URL, "/solo.md"]);
    await expect(
      buildWriteTools(kb, new Set()).write_concept.execute!(
        {
          path: "/again.md",
          frontmatter: { type: "note" },
          body: "x\n",
          sources: [{ ref: SECRET_URL }],
          log_summary: "x",
        } as never,
        {} as never
      )
    ).rejects.toThrow(/forgotten/);
    expect(await exists("again.md")).toBe(false);
  });

  it("scrubs a forgotten run from history trails even when prose is untouched", async () => {
    await kb.writeConcept(
      "/trail.md",
      { type: "note", sources: ["https://example.com/t"], history: [{ date: "2026-10-01", was: "secret old value", source: "trace:run9" }] },
      "Current.\n",
      "t"
    );
    const result = await runForget(kb, { source: "trace:run9" }, { dryRun: false });
    expect(result.status).toBe("forgotten");
    expect(result.plan.scrubHistory).toEqual(["/trail.md"]);
    expect((await kb.readConcept("/trail.md")).frontmatter.history).toBeUndefined();
  });

  it("aborts without changing anything or tombstoning when the rewrite fails", async () => {
    const failing = async (): Promise<MutationOutcome> => ({ ok: false, status: "failed", error: "model fell over" });
    const result = await runForget(kb, { source: SECRET_URL }, { dryRun: false, runner: failing });
    expect(result.status).toBe("aborted");
    expect(result.error).toMatch(/nothing was changed/);
    expect(await exists("solo.md")).toBe(true);
    expect(await forgottenRefs(root, [SECRET_URL])).toEqual([]);
  });

  it("warns when a known excerpt survives the rewrite", async () => {
    const lazy = async (): Promise<MutationOutcome> => ({
      ok: true,
      result: { summary: "did nothing", filesChanged: [], steps: 1, traceId: "x", truncated: false },
    });
    const result = await runForget(kb, { source: SECRET_URL }, { dryRun: false, runner: lazy });
    expect(result.warnings.join(" ")).toMatch(/shared\.md still contains/);
  });
});
