import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase, mergeSources, normalizeSources, MAX_SOURCES, MAX_RUN_CITATIONS } from "../src/okf/index.js";
import { buildWriteTools } from "../src/agent/tools.js";
import { TraceRecorder } from "../src/agent/trace.js";

describe("normalizeSources", () => {
  it("coerces strings and objects, dropping malformed entries", () => {
    expect(
      normalizeSources(["https://a.example", { ref: " b ", quote: "q" }, { quote: "no ref" }, 42, null])
    ).toEqual([{ ref: "https://a.example" }, { ref: "b", quote: "q" }]);
  });

  it("returns [] for non-arrays", () => {
    expect(normalizeSources(undefined)).toEqual([]);
    expect(normalizeSources("x")).toEqual([]);
  });
});

describe("mergeSources", () => {
  it("dedupes by ref, stamps `at`, and backfills a missing quote", () => {
    const merged = mergeSources(
      [{ ref: "a", at: "2026-01-01" }],
      [{ ref: "a", quote: "said so" }, { ref: "b" }],
      "2026-10-07"
    );
    expect(merged).toEqual([
      { ref: "a", at: "2026-01-01", quote: "said so" },
      { ref: "b", at: "2026-10-07" },
    ]);
  });

  it("caps the list, keeping the newest", () => {
    const incoming = Array.from({ length: MAX_SOURCES + 5 }, (_, i) => ({ ref: `r${i}` }));
    const merged = mergeSources([], incoming);
    expect(merged).toHaveLength(MAX_SOURCES);
    expect(merged.at(-1)?.ref).toBe(`r${MAX_SOURCES + 4}`);
    expect(merged[0].ref).toBe("r5");
  });
});

describe("write tools record provenance", () => {
  let root: string;
  let kb: KnowledgeBase;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-sources-"));
    kb = new KnowledgeBase(root);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const run = <T,>(t: { execute?: (...a: never[]) => unknown }, input: unknown) =>
    (t.execute as unknown as (i: unknown, o: unknown) => Promise<T>)(input, {});

  it("cites the run and any model-supplied sources on create", async () => {
    const trace = new TraceRecorder();
    const tools = buildWriteTools(kb, new Set(), trace);
    await run(tools.write_concept, {
      path: "/note.md",
      frontmatter: { type: "note", title: "Note" },
      body: "# Note\n",
      sources: [{ ref: "https://example.com/doc", quote: "the fact" }],
      log_summary: "Added note.",
    });
    const fm = (await kb.readConcept("/note.md")).frontmatter;
    expect(fm.sources).toMatchObject([
      { ref: "https://example.com/doc", quote: "the fact" },
      { ref: `trace:${trace.id}` },
    ]);
  });

  it("keeps earlier sources when a concept is overwritten", async () => {
    const t1 = new TraceRecorder();
    await run(buildWriteTools(kb, new Set(), t1).write_concept, {
      path: "/note.md",
      frontmatter: { type: "note" },
      body: "v1\n",
      log_summary: "v1",
    });
    const t2 = new TraceRecorder();
    await run(buildWriteTools(kb, new Set(), t2).write_concept, {
      path: "/note.md",
      frontmatter: { type: "note" },
      body: "v2\n",
      log_summary: "v2",
    });
    const refs = normalizeSources((await kb.readConcept("/note.md")).frontmatter.sources).map((s) => s.ref);
    expect(refs).toEqual([`trace:${t1.id}`, `trace:${t2.id}`]);
  });

  it("patch appends sources and cannot erase them with null", async () => {
    const t1 = new TraceRecorder();
    await run(buildWriteTools(kb, new Set(), t1).write_concept, {
      path: "/note.md",
      frontmatter: { type: "note" },
      body: "v1\n",
      log_summary: "v1",
    });
    const t2 = new TraceRecorder();
    await run(buildWriteTools(kb, new Set(), t2).patch_concept, {
      path: "/note.md",
      frontmatter: { sources: null, tags: ["x"] },
      sources: [{ ref: "person:alice" }],
      log_summary: "patched",
    });
    const fm = (await kb.readConcept("/note.md")).frontmatter;
    expect(normalizeSources(fm.sources).map((s) => s.ref)).toEqual([
      `trace:${t1.id}`,
      "person:alice",
      `trace:${t2.id}`,
    ]);
    expect(fm.tags).toEqual(["x"]);
  });
});

describe("lint reports unsourced concepts", () => {
  it("lists concepts without sources but stays healthy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-lint-"));
    try {
      const kb = new KnowledgeBase(root);
      await kb.writeConcept("/a.md", { type: "note", title: "A" }, "[B](/b.md)\n", "a");
      await kb.writeConcept(
        "/b.md",
        { type: "note", title: "B", sources: [{ ref: "https://x.example" }] },
        "[A](/a.md)\n",
        "b"
      );
      const report = await kb.lint();
      expect(report.unsourced.map((f) => f.path)).toEqual(["/a.md"]);
      expect(report.healthy).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("eviction keeps real origins", () => {
  it("does not lose the original external source however often a concept is edited", () => {
    let s = mergeSources([], [{ ref: "https://example.com/original-doc", quote: "the fact" }, { ref: "trace:run0" }]);
    for (let i = 1; i <= 200; i++) s = mergeSources(s, [{ ref: `trace:run${i}` }]);
    expect(s.some((x) => x.ref === "https://example.com/original-doc")).toBe(true);
    expect(s.find((x) => x.ref === "https://example.com/original-doc")?.quote).toBe("the fact");
  });

  it("keeps only the newest run citations", () => {
    let s = mergeSources([], [{ ref: "https://example.com/a" }]);
    for (let i = 1; i <= 25; i++) s = mergeSources(s, [{ ref: `trace:run${i}` }]);
    const runs = s.filter((x) => x.ref.startsWith("trace:")).map((x) => x.ref);
    expect(runs).toHaveLength(MAX_RUN_CITATIONS);
    expect(runs.at(-1)).toBe("trace:run25");
    expect(runs[0]).toBe("trace:run16");
  });

  it("evicts the oldest origins only as a last resort", () => {
    const incoming = Array.from({ length: MAX_SOURCES + 3 }, (_, i) => ({ ref: `https://example.com/${i}` }));
    const out = mergeSources([{ ref: "trace:t1" }], incoming);
    expect(out).toHaveLength(MAX_SOURCES);
    expect(out.some((x) => x.ref === "trace:t1")).toBe(false); // run citation went first
    expect(out[0].ref).toBe("https://example.com/3"); // then the 3 oldest origins (54 entries - 50 cap = 4 evictions)
  });
});
