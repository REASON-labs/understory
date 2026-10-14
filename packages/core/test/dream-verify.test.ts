import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase, addTombstones } from "../src/okf/index.js";
import { baselineBrokenLinks, verifyDreamRun } from "../src/agent/dream-verify.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-verify-"));
  kb = new KnowledgeBase(root);
  await kb.writeConcept("/a.md", { type: "Note", title: "A" }, "Alpha says the deploy window is Tuesday.\n", "a");
  await kb.writeConcept("/b.md", { type: "Note", title: "B" }, "See [A](/a.md).\n", "b");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const run = (over: Partial<{ touched: string[]; created: string[]; deleted: string[] }> = {}) => ({
  touched: [],
  created: [],
  deleted: [],
  ...over,
});
const opts = async (allowDelete = false) => ({ allowDelete, baselineBroken: await baselineBrokenLinks(kb) });

describe("verifyDreamRun", () => {
  it("passes a run that changed nothing suspicious", async () => {
    expect(await verifyDreamRun(kb, run({ touched: ["/b.md"] }), await opts())).toEqual([]);
  });

  it("rejects deletions unless duplicate merging is authorized", async () => {
    const bad = await verifyDreamRun(kb, run({ touched: ["/a.md"], deleted: ["/a.md"] }), await opts(false));
    expect(bad.join(" ")).toMatch(/deleted \/a\.md/);
    expect(await verifyDreamRun(kb, run({ touched: ["/a.md"], deleted: ["/a.md"] }), await opts(true))).toEqual([]);
  });

  it("blames a run only for broken links it introduced", async () => {
    // Pre-existing broken link: not the dream's fault.
    await kb.writeConcept("/old.md", { type: "Note" }, "Links [gone](/gone.md).\n", "old");
    const baseline = await baselineBrokenLinks(kb);
    expect(await verifyDreamRun(kb, run({ touched: ["/old.md"] }), { allowDelete: false, baselineBroken: baseline })).toEqual([]);
    // New broken link written during the run.
    await kb.writeConcept("/c.md", { type: "Note" }, "Links [nope](/nope.md).\n", "c");
    const bad = await verifyDreamRun(kb, run({ touched: ["/c.md"], created: ["/c.md"] }), { allowDelete: false, baselineBroken: baseline });
    expect(bad.join(" ")).toMatch(/\/c\.md: now links to \/nope\.md/);
  });

  it("requires a derived concept to cite the concepts it came from", async () => {
    await kb.writeConcept("/d.md", { type: "Insight", derived: true, sources: [{ ref: "trace:t1" }] }, "Summary.\n", "d");
    const bad = await verifyDreamRun(kb, run({ touched: ["/d.md"], created: ["/d.md"] }), await opts());
    expect(bad.join(" ")).toMatch(/derived but cites no concept/);
  });

  it("rejects a derived concept citing a concept that does not exist", async () => {
    await kb.writeConcept("/d.md", { type: "Insight", derived: true, sources: [{ ref: "/missing.md" }] }, "Summary.\n", "d");
    const bad = await verifyDreamRun(kb, run({ touched: ["/d.md"], created: ["/d.md"] }), await opts());
    expect(bad.join(" ")).toMatch(/derived from \/missing\.md, which does not exist/);
  });

  it("checks that a quoted excerpt really appears in the concept it names", async () => {
    const mk = (quote: string) =>
      kb.writeConcept(
        "/d.md",
        { type: "Insight", derived: true, sources: [{ ref: "/a.md", quote }] },
        "Summary.\n",
        "d"
      );
    await mk("the deploy window is   TUESDAY"); // whitespace and case are forgiven
    expect(await verifyDreamRun(kb, run({ touched: ["/d.md"] }), await opts())).toEqual([]);
    await mk("the deploy window is Friday");
    const bad = await verifyDreamRun(kb, run({ touched: ["/d.md"] }), await opts());
    expect(bad.join(" ")).toMatch(/quotes \/a\.md, but that text is not there/);
  });

  it("rejects writes that cite or mention a forgotten source", async () => {
    await addTombstones(root, ["https://example.com/gone", "/old-person.md"]);
    await kb.writeConcept("/e.md", { type: "Note", sources: [{ ref: "https://example.com/gone" }] }, "x\n", "e");
    await kb.writeConcept("/f.md", { type: "Note" }, "Mentions /old-person.md in passing.\n", "f");
    const bad = await verifyDreamRun(kb, run({ touched: ["/e.md", "/f.md"] }), await opts());
    expect(bad.filter((m) => /forgotten/.test(m))).toHaveLength(2);
  });
});
