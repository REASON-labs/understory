import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase, normalizeSources, DERIVED_WEIGHT } from "../src/okf/index.js";
import { buildWriteTools } from "../src/agent/tools.js";
import { TraceRecorder } from "../src/agent/trace.js";
import { explainConcept, formatExplanation } from "../src/agent/explain.js";
import { detectSignals } from "../src/agent/dream.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-derived-"));
  kb = new KnowledgeBase(root);
  await kb.writeConcept("/svc/billing.md", { type: "Service", title: "Billing" }, "Billing handles invoices.\n", "Added billing.");
  await kb.writeConcept("/svc/oncall.md", { type: "Service", title: "Oncall" }, "Oncall rotation is weekly.\n", "Added oncall.");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const exec = <T,>(t: { execute?: (...a: never[]) => unknown }, input: unknown) =>
  (t.execute as unknown as (i: unknown, o: unknown) => Promise<T>)(input, {});

const write = (input: Record<string, unknown>, opts?: { deriveNew?: boolean }) =>
  exec(buildWriteTools(kb, new Set(), new TraceRecorder(), opts).write_concept, {
    frontmatter: { type: "Overview", title: "Overview" },
    log_summary: "Added overview.",
    ...input,
  });

describe("derived concepts", () => {
  it("stamps a new concept the model declares derived, citing what it links to", async () => {
    await write({
      path: "/insights/ops.md",
      body: "Ops overview: [Billing](/svc/billing.md) and [Oncall](/svc/oncall.md) and [ghost](/svc/ghost.md).\n",
      derived: true,
    });
    const c = await kb.readConcept("/insights/ops.md");
    expect(c.frontmatter.derived).toBe(true);
    const refs = normalizeSources(c.frontmatter.sources).map((s) => s.ref);
    expect(refs).toContain("/svc/billing.md");
    expect(refs).toContain("/svc/oncall.md");
    expect(refs).not.toContain("/svc/ghost.md"); // only concepts that exist
    expect(refs.some((r) => r.startsWith("trace:"))).toBe(true);
  });

  it("stamps every new concept when the run is configured as overview-only", async () => {
    await write({ path: "/insights/auto.md", body: "See [Billing](/svc/billing.md).\n" }, { deriveNew: true });
    expect((await kb.readConcept("/insights/auto.md")).frontmatter.derived).toBe(true);
  });

  it("does not stamp ordinary concepts, and ignores a model-supplied derived key", async () => {
    await write({ path: "/svc/plain.md", body: "Plain fact.\n", frontmatter: { type: "Service", derived: true } });
    expect((await kb.readConcept("/svc/plain.md")).frontmatter.derived).toBeUndefined();
  });

  it("does not turn an existing primary concept into a derived one by overwriting it", async () => {
    await write({ path: "/svc/billing.md", body: "Rewritten.\n", derived: true, frontmatter: { type: "Service" } });
    expect((await kb.readConcept("/svc/billing.md")).frontmatter.derived).toBeUndefined();
  });

  it("keeps a derived concept derived when it is rewritten", async () => {
    await write({ path: "/insights/ops.md", body: "[B](/svc/billing.md)\n", derived: true });
    await write({ path: "/insights/ops.md", body: "[B](/svc/billing.md) rewritten\n" });
    expect((await kb.readConcept("/insights/ops.md")).frontmatter.derived).toBe(true);
  });

  it("ranks a derived concept below a primary one at equal relevance, and flags it", async () => {
    await write({ path: "/insights/zebra.md", body: "zebra stripes notes [B](/svc/billing.md)\n", frontmatter: { type: "Overview", title: "zebra" }, derived: true });
    await kb.writeConcept("/svc/zebra.md", { type: "Service", title: "zebra" }, "zebra stripes notes\n", "Added zebra.");
    const hits = await kb.search("zebra");
    expect(hits.map((h) => h.path)).toEqual(["/svc/zebra.md", "/insights/zebra.md"]);
    expect(hits[1].derived).toBe(true);
    expect(hits[0].derived).toBeUndefined();
    expect(hits[1].score).toBeCloseTo(hits[0].score * DERIVED_WEIGHT, 5);
  });

  it("memory_explain says a concept is derived", async () => {
    await write({ path: "/insights/ops.md", body: "[B](/svc/billing.md)\n", derived: true });
    const x = await explainConcept(kb, "/insights/ops.md");
    expect(x.derived).toBe(true);
    expect(formatExplanation(x)).toContain("DERIVED");
  });

  it("the insights signal ignores activity about derived concepts", async () => {
    for (let i = 0; i < 4; i++) {
      await kb.writeConcept(`/svc/s${i}.md`, { type: "Service", title: `S${i}` }, `Fact ${i}.\n`, `Added [S${i}](/svc/s${i}.md).`);
    }
    // 2 (setup) + 4 = 6 primary entries.
    const before = await detectSignals(kb, new Set(["insights"]));
    expect(before.signals[0].count).toBe(6);

    await write({ path: "/insights/ops.md", body: "[B](/svc/billing.md)\n", derived: true, log_summary: "Added [Ops overview](/insights/ops.md)." });
    const after = await detectSignals(kb, new Set(["insights"]));
    expect(after.signals[0].count).toBe(6); // the overview's own log entry is not fed back in
    expect(after.signals[0].instruction).not.toContain("/insights/ops.md");
    expect(after.signals[0].instruction).toContain("derived=true"); // and the model is told to mark overviews
  });
});
