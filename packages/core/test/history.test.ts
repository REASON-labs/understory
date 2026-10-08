import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase, appendHistory, normalizeHistory, MAX_HISTORY } from "../src/okf/index.js";
import { buildWriteTools } from "../src/agent/tools.js";
import { TraceRecorder } from "../src/agent/trace.js";
import { explainConcept, formatExplanation } from "../src/agent/explain.js";

describe("normalizeHistory", () => {
  it("keeps valid entries and drops malformed ones", () => {
    expect(
      normalizeHistory([
        { date: "2026-10-07", was: " old ", reason: "moved" },
        { date: "2026-10-07" },
        { was: "no date" },
        "nope",
        null,
      ])
    ).toEqual([{ date: "2026-10-07", was: "old", reason: "moved" }]);
  });
  it("returns [] for non-arrays", () => {
    expect(normalizeHistory(undefined)).toEqual([]);
  });
});

describe("appendHistory", () => {
  it("appends, stamps the date, and does not repeat an identical entry", () => {
    const once = appendHistory([], [{ was: "A" }], "2026-10-07");
    const twice = appendHistory(once, [{ was: "A" }, { was: "B", reason: "r" }], "2026-10-07");
    expect(twice).toEqual([
      { date: "2026-10-07", was: "A" },
      { date: "2026-10-07", was: "B", reason: "r" },
    ]);
  });

  it("caps at the newest MAX_HISTORY", () => {
    const incoming = Array.from({ length: MAX_HISTORY + 3 }, (_, i) => ({ was: `v${i}` }));
    const out = appendHistory([], incoming, "2026-10-07");
    expect(out).toHaveLength(MAX_HISTORY);
    expect(out[0].was).toBe("v3");
    expect(out.at(-1)?.was).toBe(`v${MAX_HISTORY + 2}`);
  });
});

describe("write tools record supersessions", () => {
  let root: string;
  let kb: KnowledgeBase;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-history-"));
    kb = new KnowledgeBase(root);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const run = <T,>(t: { execute?: (...a: never[]) => unknown }, input: unknown) =>
    (t.execute as unknown as (i: unknown, o: unknown) => Promise<T>)(input, {});

  it("records what a patch replaced, with the run as source, and keeps the body clean", async () => {
    await run(buildWriteTools(kb, new Set()).write_concept, {
      path: "/office.md",
      frontmatter: { type: "place" },
      body: "The office is at 12 Elm St.\n",
      log_summary: "Added office.",
    });
    expect((await kb.readConcept("/office.md")).frontmatter.history).toBeUndefined();

    const t = new TraceRecorder();
    await run(buildWriteTools(kb, new Set(), t).patch_concept, {
      path: "/office.md",
      replace_body: "The office is at 99 Oak Ave.\n",
      replaced: [{ was: "Office was at 12 Elm St", reason: "moved" }],
      log_summary: "Office moved.",
    });

    const c = await kb.readConcept("/office.md");
    expect(c.body).toContain("99 Oak Ave");
    expect(c.body).not.toContain("Elm");
    expect(c.frontmatter.history).toMatchObject([
      { was: "Office was at 12 Elm St", reason: "moved", source: `trace:${t.id}` },
    ]);
  });

  it("preserves history on overwrite and ignores model-supplied or null history", async () => {
    const tools = buildWriteTools(kb, new Set(), new TraceRecorder());
    await run(tools.write_concept, {
      path: "/a.md",
      frontmatter: { type: "note", history: [{ date: "1999-01-01", was: "forged" }] },
      body: "v1\n",
      log_summary: "v1",
    });
    expect((await kb.readConcept("/a.md")).frontmatter.history).toBeUndefined();

    await run(tools.patch_concept, {
      path: "/a.md",
      replace_body: "v2\n",
      replaced: [{ was: "v1" }],
      log_summary: "v2",
    });
    await run(tools.write_concept, {
      path: "/a.md",
      frontmatter: { type: "note" },
      body: "v3\n",
      replaced: [{ was: "v2" }],
      log_summary: "v3",
    });
    await run(tools.patch_concept, {
      path: "/a.md",
      frontmatter: { history: null },
      log_summary: "tamper",
    });

    const h = normalizeHistory((await kb.readConcept("/a.md")).frontmatter.history);
    expect(h.map((e) => e.was)).toEqual(["v1", "v2"]);
  });

  it("memory_explain surfaces superseded facts", async () => {
    const tools = buildWriteTools(kb, new Set(), new TraceRecorder());
    await run(tools.write_concept, {
      path: "/a.md",
      frontmatter: { type: "note" },
      body: "new\n",
      replaced: [{ was: "old value", reason: "corrected" }],
      log_summary: "x",
    });
    const x = await explainConcept(kb, "/a.md");
    expect(x.superseded).toMatchObject([{ was: "old value", reason: "corrected" }]);
    expect(formatExplanation(x)).toContain('was "old value" (corrected)');
  });
});

describe("frontmatter key validation", () => {
  it("rejects malformed keys from small models instead of storing them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-keys-"));
    try {
      const kb = new KnowledgeBase(root);
      const tools = buildWriteTools(kb, new Set());
      const exec = (t: { execute?: (...a: never[]) => unknown }, input: unknown) =>
        (t.execute as unknown as (i: unknown, o: unknown) => Promise<unknown>)(input, {});
      await expect(
        exec(tools.write_concept, {
          path: "/k.md",
          frontmatter: { type: "note", "resource}: ~/x": "y" },
          body: "b\n",
          log_summary: "k",
        })
      ).rejects.toThrow(/Invalid frontmatter key/);
      await exec(tools.write_concept, { path: "/k.md", frontmatter: { type: "note", resource: "ok" }, body: "b\n", log_summary: "k" });
      await expect(
        exec(tools.patch_concept, { path: "/k.md", frontmatter: { "bad key": 1 }, log_summary: "k" })
      ).rejects.toThrow(/Invalid frontmatter key/);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
