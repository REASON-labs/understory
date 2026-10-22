import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * deadline.test.ts mocks generateText, so it cannot show that the REAL AI SDK
 * loop honours prepareStep's activeTools and system. This runs the real loop
 * with a scripted model and records what it was actually offered at each step.
 */
const model = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("../src/providers/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createModel: async () => model.current,
}));

const { KnowledgeBase } = await import("../src/okf/index.js");
const { runMutation } = await import("../src/agent/agent.js");

let root: string;
let kb: InstanceType<typeof KnowledgeBase>;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-deadline-sdk-"));
  kb = new KnowledgeBase(root);
  process.env.LLM_API_BASE_URL = "http://localhost:8080/v1";
  process.env.LLM_API_FORMAT = "openai";
  process.env.LLM_MODEL = "scripted";
  delete process.env.AGENT_MUTATION_DEADLINE;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

type Offered = { tools: string[]; system: string };
/** A minimal LanguageModelV2 (ai v5): generateText only needs doGenerate. */
const mockModel = (doGenerate: (options: { tools?: unknown; prompt: unknown }) => Promise<unknown>) => ({
  specificationVersion: "v2" as const,
  provider: "scripted",
  modelId: "scripted",
  supportedUrls: {},
  doGenerate,
  doStream: async () => {
    throw new Error("streaming is not used by runMutation");
  },
});
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A model that takes `stepMs` per step and calls `decide` with the tools it is offered. */
function scripted(
  stepMs: number,
  decide: (offered: string[], step: number) => { tool: string; input: unknown } | { text: string }
) {
  const log: Offered[] = [];
  let step = 0;
  model.current = mockModel(async (options) => {
      await sleep(stepMs);
      const tools = ((options.tools ?? []) as { name: string }[]).map((t) => t.name).sort();
      const sys = (options.prompt as { role: string; content: unknown }[]).find((m) => m.role === "system");
      log.push({ tools, system: typeof sys?.content === "string" ? sys.content : "" });
      const d = decide(tools, step++);
      if ("text" in d) return { content: [{ type: "text", text: d.text }], finishReason: "stop", usage, warnings: [] };
      return {
        content: [{ type: "tool-call", toolCallId: `c${step}`, toolName: d.tool, input: JSON.stringify(d.input) }],
        finishReason: "tool-calls",
        usage,
        warnings: [],
      };
  });
  return log;
}

describe("the real SDK loop under a deadline", () => {
  it("offers only the write tools once the write phase starts, and the model's write is stored", async () => {
    const log = scripted(150, (offered) =>
      offered.includes("search_knowledge")
        ? { tool: "search_knowledge", input: { query: "anything" } } // keeps exploring while it can
        : offered.includes("write_concept")
          ? { tool: "write_concept", input: { path: "/fact.md", frontmatter: { type: "note", title: "Fact" }, body: "# Fact\nStored.\n", log_summary: "Added fact." } }
          : { text: "no tools" }
    );
    // 150 ms/step against a 1000 ms deadline: write phase begins at ~650 ms.
    const outcome = await runMutation(kb, "remember the fact", { deadlineMs: 1000 });

    const early = log[0];
    expect(early.tools).toContain("search_knowledge");
    expect(early.tools).toContain("delete_concept");
    expect(early.system).not.toMatch(/TIME LIMIT/);

    // Steps with some-but-not-all tools are the write phase; steps with none are the wrap-up that follows.
    const writePhase = log.filter((s) => s.tools.length > 0 && !s.tools.includes("search_knowledge"));
    expect(writePhase.length).toBeGreaterThan(0);
    for (const s of writePhase) {
      expect(s.tools).toEqual(["patch_concept", "write_concept"]); // never delete, never read
      expect(s.system).toMatch(/TIME LIMIT/);
    }
    // The phases only ever move forward: once tools start shrinking they do not come back.
    const sizes = log.map((s) => s.tools.length);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(outcome.ok).toBe(true);
    expect(await fs.readFile(path.join(root, "fact.md"), "utf8")).toContain("Stored.");
    if (outcome.ok) expect(outcome.result.summary).toMatch(/write-only phase/);
  }, 30_000);

  it("takes every tool away in the wrap phase so a slow model is made to finish", async () => {
    // 400 ms/step against 1000 ms: a step starts at ~0, 400, 800 (write phase), 1200 (wrap).
    const log = scripted(400, (offered) =>
      offered.length === 0
        ? { text: "Nothing was stored; ran out of time." }
        : offered.includes("search_knowledge")
          ? { tool: "search_knowledge", input: { query: "x" } }
          : { tool: "search_knowledge", input: { query: "x" } } // tries to keep reading even when it cannot
    );
    const outcome = await runMutation(kb, "go", { deadlineMs: 1000 });
    expect(log.some((s) => s.tools.length === 0 && /TIME IS UP/.test(s.system))).toBe(true);
    // wrap-up with nothing stored is reported as a failure, not as a success
    expect(outcome).toMatchObject({ ok: false, status: "failed" });
  }, 30_000);

  it("without a deadline the loop is untouched: every tool, every step", async () => {
    const log = scripted(20, (_o, step) => (step < 3 ? { tool: "search_knowledge", input: { query: "x" } } : { text: "done" }));
    await runMutation(kb, "go");
    for (const s of log) {
      expect(s.tools).toContain("search_knowledge");
      expect(s.tools).toContain("write_concept");
      expect(s.system).not.toMatch(/TIME LIMIT|TIME IS UP/);
    }
  }, 30_000);
});
