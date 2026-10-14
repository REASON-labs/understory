import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase, addTombstones } from "../src/okf/index.js";
import { DreamReviews, runInDreamWorktree } from "../src/agent/dream-review.js";
import { planForget, runForget, formatForget } from "../src/agent/forget.js";

const URL = "https://example.com/secret-memo";
const QUOTE = "Dana is allergic to peanuts.";

let root: string;
let kb: KnowledgeBase;

const exists = (rel: string) =>
  fs.access(path.join(root, rel)).then(() => true, () => false);

/** A review-mode dream that adds one concept, kept as a dream/<id> branch. */
async function dreamAdding(file: string, sources: unknown[], body: string): Promise<string> {
  const { branch } = await runInDreamWorktree(kb, async (w) => {
    await w.writeConcept(file, { type: "Insight", title: "Note", sources: sources as never }, body, `Added ${file}.`);
    return { keep: true, title: "dream: add a note", body: "Added a note." };
  });
  if (!branch) throw new Error("dream kept nothing");
  return branch.replace("dream/", "");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-dream-forget-"));
  kb = new KnowledgeBase(root, { gitAutocommit: true });
  expect((await kb.ensureGitReady()).ok).toBe(true);
  await kb.writeConcept(
    "/people/dana.md",
    { type: "Person", title: "Dana", sources: [{ ref: URL, quote: QUOTE }, { ref: "trace:w1" }] },
    `# Dana\n${QUOTE}\n`,
    "Added [Dana](/people/dana.md)."
  );
  await kb.writeConcept("/other.md", { type: "Note", title: "Other", sources: ["https://example.com/other"] }, "# Other\n", "Added other.");
}, 60_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("memory_forget and pending dream reviews", () => {
  it("plans to reject a review that derived from forgotten material, and does so on apply", async () => {
    const id = await dreamAdding("/insights/health.md", [{ ref: "/people/dana.md" }], "Allergy noted for Dana.\n");
    const plan = await planForget(kb, { source: URL });
    expect(plan.dreamReviews).toEqual([id]);
    expect(formatForget({ status: "dry_run", plan, warnings: [] })).toContain(id);

    const result = await runForget(kb, { source: URL }, { dryRun: false });
    expect(result.status).toBe("forgotten");
    // The review is gone, so accepting it later cannot bring anything back.
    expect(await new DreamReviews(kb).get(id)).toBeNull();
    expect(await new DreamReviews(kb).accept(id)).toMatchObject({ ok: false, reason: "not_found" });
    expect(await exists("insights/health.md")).toBe(false);
  }, 90_000);

  it("leaves an unrelated pending review alone, and it still accepts", async () => {
    const id = await dreamAdding("/insights/unrelated.md", ["https://example.com/other"], "Nothing to do with Dana.\n");
    const plan = await planForget(kb, { source: URL });
    expect(plan.dreamReviews).toEqual([]);
    await runForget(kb, { source: URL }, { dryRun: false });
    expect(await new DreamReviews(kb).get(id)).not.toBeNull();
    const accepted = await new DreamReviews(kb).accept(id);
    expect(accepted.ok).toBe(true);
    expect(await exists("insights/unrelated.md")).toBe(true);
  }, 90_000);
});

describe("accepting a dream that predates a forget", () => {
  it("refuses to merge a concept that cites a forgotten source, and keeps the review", async () => {
    const id = await dreamAdding("/insights/health.md", [{ ref: "/people/dana.md" }], "Allergy noted for Dana.\n");
    // Tombstoned without going through memory_forget (e.g. a review created later, or an older forget).
    await addTombstones(root, ["/people/dana.md"]);
    await kb.commitPending("tombstone");

    const result = await new DreamReviews(kb).accept(id);
    expect(result).toMatchObject({ ok: false, reason: "forgotten" });
    if (result.ok === false && result.reason === "forgotten") expect(result.files).toEqual(["/insights/health.md"]);
    expect(await exists("insights/health.md")).toBe(false); // nothing merged
    expect(await new DreamReviews(kb).get(id)).not.toBeNull(); // review kept for the human
  }, 90_000);

  it("also catches a forgotten URL merely mentioned in the body", async () => {
    const id = await dreamAdding("/insights/mention.md", [], `See ${URL} for details.\n`);
    await addTombstones(root, [URL]);
    await kb.commitPending("tombstone");
    expect(await new DreamReviews(kb).accept(id)).toMatchObject({ ok: false, reason: "forgotten" });
  }, 90_000);
});
