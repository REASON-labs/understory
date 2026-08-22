import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase, inDirectory, matchesFilters } from "../src/okf/index.js";
import { buildReadTools } from "../src/agent/tools.js";
import { runQueryCached, clearQueryCache } from "../src/agent/query-cache.js";
import {
  clearHotMemory,
  hotLookup,
  recordHotQuery,
  recordHotWrite,
} from "../src/agent/hot-memory.js";
import type { QueryResult } from "../src/agent/agent.js";

let root: string;
let kb: KnowledgeBase;

/** Runs a tool's execute() without the AI SDK in the way. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const exec = (t: any, args: unknown) => t.execute(args, {} as never);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-scope-"));
  kb = new KnowledgeBase(root);
  clearQueryCache();
  clearHotMemory();

  await kb.writeConcept(
    "/services/billing.md",
    { type: "policy", title: "Billing rate limits", description: "limits", tags: ["billing", "api"] },
    "# Billing\n\n100 requests per minute.\n",
    "Added billing."
  );
  await kb.writeConcept(
    "/services/oncall.md",
    { type: "runbook", title: "Billing oncall", description: "rota", tags: ["billing"] },
    "# Oncall\n\nPager rota for billing.\n",
    "Added oncall."
  );
  await kb.writeConcept(
    "/people/ana.md",
    { type: "policy", title: "Ana billing contact", description: "person", tags: ["billing"] },
    "# Ana\n\nOwns billing.\n",
    "Added Ana."
  );

  // The hot set is populated by the agent's write TOOLS, not by
  // kb.writeConcept — seeding it directly is what a real agent run would do.
  recordHotWrite("/services/billing.md");
  recordHotWrite("/services/oncall.md");
  recordHotWrite("/people/ana.md");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("filter predicates", () => {
  it("matchesFilters is case-insensitive on type and requires ALL tags", () => {
    const fm = { type: "Policy", tags: ["Billing", "API"] };
    expect(matchesFilters(fm, { type: "policy" })).toBe(true);
    expect(matchesFilters(fm, { type: "runbook" })).toBe(false);
    expect(matchesFilters(fm, { tags: ["billing"] })).toBe(true);
    expect(matchesFilters(fm, { tags: ["billing", "api"] })).toBe(true);
    expect(matchesFilters(fm, { tags: ["billing", "missing"] })).toBe(false);
  });

  it("inDirectory matches subtrees, not prefixes of sibling names", () => {
    expect(inDirectory("/services/billing.md", "/services")).toBe(true);
    expect(inDirectory("/services/billing.md", "services")).toBe(true);
    expect(inDirectory("/services/billing.md", "/services/")).toBe(true);
    expect(inDirectory("/people/ana.md", "/services")).toBe(false);
    // "/services-old" must not match a "/services" scope.
    expect(inDirectory("/services-old/x.md", "/services")).toBe(false);
    expect(inDirectory("/anything.md", undefined)).toBe(true);
    expect(inDirectory("/anything.md", "/")).toBe(true);
  });
});

describe("search scoping", () => {
  it("narrows results by directory", async () => {
    const all = await kb.search("billing");
    expect(all.map((h) => h.path).sort()).toEqual([
      "/people/ana.md",
      "/services/billing.md",
      "/services/oncall.md",
    ]);

    const scoped = await kb.search("billing", { directory: "/services" });
    expect(scoped.map((h) => h.path).sort()).toEqual([
      "/services/billing.md",
      "/services/oncall.md",
    ]);
  });

  it("combines directory with type", async () => {
    const hits = await kb.search("billing", { directory: "/services", type: "policy" });
    expect(hits.map((h) => h.path)).toEqual(["/services/billing.md"]);
  });

  it("returns nothing for a directory with no concepts, without throwing", async () => {
    await expect(kb.search("billing", { directory: "/nonexistent" })).resolves.toEqual([]);
  });
});

describe("buildReadTools scope enforcement", () => {
  it("applies the caller scope to search_knowledge", async () => {
    const tools = buildReadTools(kb, undefined, { directory: "/services" });
    const hits = await exec(tools.search_knowledge, { query: "billing" });
    expect((hits as { path: string }[]).map((h) => h.path).sort()).toEqual([
      "/services/billing.md",
      "/services/oncall.md",
    ]);
  });

  it("does not let the model widen the caller's scope", async () => {
    // The whole point of a scope: the caller's guarantee must survive whatever
    // the model passes in its own tool arguments.
    const tools = buildReadTools(kb, undefined, { type: "policy" });
    const hits = await exec(tools.search_knowledge, { query: "billing", type: "runbook" });
    for (const hit of hits as { path: string }[]) {
      expect(hit.path).not.toBe("/services/oncall.md");
    }
  });

  it("unions tags rather than replacing them", async () => {
    const tools = buildReadTools(kb, undefined, { tags: ["billing"] });
    const hits = await exec(tools.search_knowledge, { query: "billing", tags: ["api"] });
    expect((hits as { path: string }[]).map((h) => h.path)).toEqual(["/services/billing.md"]);
  });

  it("scopes the bundle_layout returned on a search miss", async () => {
    const tools = buildReadTools(kb, undefined, { directory: "/services" });
    const miss = (await exec(tools.search_knowledge, { query: "zzzznomatch" })) as {
      hits: unknown[];
      bundle_layout: string;
    };
    expect(miss.hits).toEqual([]);
    // Dumping the whole bundle here would leak out-of-scope structure and
    // bloat the context — the two problems scoping is meant to reduce.
    expect(miss.bundle_layout).toContain("billing.md");
    expect(miss.bundle_layout).not.toContain("ana.md");
  });

  it("blocks read_concept outside the directory scope", async () => {
    const tools = buildReadTools(kb, undefined, { directory: "/services" });
    const ok = await exec(tools.read_concept, { path: "/services/billing.md" });
    expect(ok).toHaveProperty("body");

    const denied = await exec(tools.read_concept, { path: "/people/ana.md" });
    expect(denied).toHaveProperty("error");
    expect((denied as { error: string }).error).toMatch(/Out of scope/);
  });

  it("leaves everything reachable when no scope is given", async () => {
    const tools = buildReadTools(kb);
    expect(await exec(tools.read_concept, { path: "/people/ana.md" })).toHaveProperty("body");
    const hits = await exec(tools.search_knowledge, { query: "billing" });
    expect(hits).toHaveLength(3);
  });
});

describe("query cache scope isolation", () => {
  const result = (answer: string): QueryResult => ({ answer, steps: 1, traceId: "t" });

  it("does not serve an unscoped cached answer to a scoped query", async () => {
    // The silent-bug case: same question, different scope, must not collide.
    const runner = vi.fn().mockResolvedValue(result("unscoped answer"));
    const noHot = async () => null;

    const first = await runQueryCached(kb, "what are the limits?", {}, runner, noHot);
    expect(first.source).toBe("deep");

    const second = await runQueryCached(
      kb,
      "what are the limits?",
      { scope: { directory: "/services" } },
      runner,
      noHot
    );
    expect(second.cached).toBe(false);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("still caches repeats of the same scoped question", async () => {
    const runner = vi.fn().mockResolvedValue(result("scoped answer"));
    const noHot = async () => null;
    const opts = { scope: { directory: "/services" } };

    await runQueryCached(kb, "what are the limits?", opts, runner, noHot);
    const again = await runQueryCached(kb, "what are the limits?", opts, runner, noHot);

    expect(again.cached).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("treats tag order as irrelevant to the cache key", async () => {
    const runner = vi.fn().mockResolvedValue(result("answer"));
    const noHot = async () => null;

    await runQueryCached(kb, "q", { scope: { tags: ["a", "b"] } }, runner, noHot);
    const again = await runQueryCached(kb, "q", { scope: { tags: ["B", "A"] } }, runner, noHot);

    expect(again.cached).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("distinguishes different scopes from each other", async () => {
    const runner = vi.fn().mockResolvedValue(result("answer"));
    const noHot = async () => null;

    await runQueryCached(kb, "q", { scope: { type: "policy" } }, runner, noHot);
    await runQueryCached(kb, "q", { scope: { type: "runbook" } }, runner, noHot);

    expect(runner).toHaveBeenCalledTimes(2);
  });
});

describe("hot memory scope handling", () => {
  it("excludes hot concepts outside the scope", async () => {
    // Writes above put all three concepts in the hot set.
    const seen: string[] = [];
    const capture = async (_system: string, prompt: string) => {
      seen.push(prompt);
      return "UNKNOWN";
    };

    await hotLookup(kb, "who owns billing?", { scope: { directory: "/services" } }, capture);

    expect(seen[0]).toContain("/services/billing.md");
    expect(seen[0]).not.toContain("/people/ana.md");
  });

  it("skips cached Q&A pairs for scoped queries", async () => {
    // A cached answer carries no record of which concepts produced it, so it
    // can't be shown to respect the scope.
    recordHotQuery("previous question", "previous answer");

    const scopedPrompts: string[] = [];
    await hotLookup(kb, "q", { scope: { type: "policy" } }, async (_s, p) => {
      scopedPrompts.push(p);
      return "UNKNOWN";
    });
    expect(scopedPrompts[0]).not.toContain("previous answer");

    const unscopedPrompts: string[] = [];
    await hotLookup(kb, "q", {}, async (_s, p) => {
      unscopedPrompts.push(p);
      return "UNKNOWN";
    });
    expect(unscopedPrompts[0]).toContain("previous answer");
  });

  it("returns null when the scope excludes everything", async () => {
    const generate = vi.fn().mockResolvedValue("some answer");

    // Guard against a vacuous pass: unscoped, the hot set DOES answer here.
    expect(await hotLookup(kb, "q", {}, generate)).toBe("some answer");
    generate.mockClear();

    const answer = await hotLookup(kb, "q", { scope: { directory: "/nowhere" } }, generate);
    expect(answer).toBeNull();
    // No sections means no LLM call at all — scoping must not cost a token.
    expect(generate).not.toHaveBeenCalled();
  });
});
