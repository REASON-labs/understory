import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Same approach as mutation-outcome.test.ts: the model is mocked at the AI SDK boundary. */
const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateText,
}));

const { KnowledgeBase } = await import("../src/okf/index.js");
const { runMutation } = await import("../src/agent/agent.js");
const { runDream } = await import("../src/agent/dream.js");

let root: string;
let kb: InstanceType<typeof KnowledgeBase>;

const fm = (title: string) => ({ type: "note", title, description: `about ${title}` });
const exists = (rel: string) =>
  fs.access(path.join(root, rel)).then(() => true, () => false);
/** What generateText returns when the agent spent its whole budget while still asking for tools. */
const stepLimitedResult = { text: "", steps: Array.from({ length: 12 }, () => ({})), finishReason: "tool-calls" };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-hooks-"));
  kb = new KnowledgeBase(root);
  generateText.mockReset();
  delete process.env.MUTATION_ROLLBACK;
  delete process.env.AGENT_MAX_STEPS;
  delete process.env.DREAM_VERIFY;
  process.env.LLM_API_BASE_URL = "http://localhost:8080/v1";
  process.env.LLM_API_FORMAT = "openai";
  process.env.LLM_MODEL = "test-model";
  await kb.writeConcept("/existing.md", fm("Existing"), "# Existing\n", "Added existing.");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("verifyRun", () => {
  it("rolls the whole run back when verification fails, and reports why", async () => {
    generateText.mockImplementation(async () => {
      await kb.writeConcept("/alpha.md", fm("Alpha"), "# Alpha\n", "Added Alpha.");
      return { text: "done", steps: [{}, {}], finishReason: "stop" };
    });
    const outcome = await runMutation(kb, "go", { verifyRun: async () => ["alpha looks wrong"] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.status !== "rolled_back") throw new Error("expected rolled_back");
    expect(outcome.unverified).toEqual(["alpha looks wrong"]);
    expect(await exists("alpha.md")).toBe(false);
  });

  it("keeps the run when verification passes, and tells verify what was created and deleted", async () => {
    generateText.mockImplementation(async () => {
      await kb.writeConcept("/alpha.md", fm("Alpha"), "# Alpha\n", "Added Alpha.");
      await kb.deleteConcept("/existing.md", "Removed existing.");
      return { text: "done", steps: [{}], finishReason: "stop" };
    });
    let seen: { touched: string[]; created: string[]; deleted: string[] } | undefined;
    const outcome = await runMutation(kb, "go", {
      verifyRun: async (_kb, run) => {
        seen = run;
        return [];
      },
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual({
      touched: ["/alpha.md", "/existing.md"],
      created: ["/alpha.md"],
      deleted: ["/existing.md"],
    });
    expect(await exists("alpha.md")).toBe(true);
  });
});

describe("rollbackOnStepLimit", () => {
  const writeThenCutOff = async () => {
    await kb.writeConcept("/half.md", fm("Half"), "# half-done\n", "Added half.");
    return stepLimitedResult;
  };

  it("keeps a step-limited interactive run as partial (the default)", async () => {
    generateText.mockImplementation(writeThenCutOff);
    const outcome = await runMutation(kb, "go");
    expect(outcome).toMatchObject({ ok: false, status: "partial" });
    expect(await exists("half.md")).toBe(true);
  });

  it("rolls an unattended step-limited run back instead", async () => {
    generateText.mockImplementation(writeThenCutOff);
    const outcome = await runMutation(kb, "go", { rollbackOnStepLimit: true });
    if (outcome.ok || outcome.status !== "rolled_back") throw new Error("expected rolled_back");
    expect(outcome.stepLimited).toEqual({ limit: 12 });
    expect(await exists("half.md")).toBe(false);
  });
});

describe("runDream wiring", () => {
  // Enough orphans to fire the orphans signal, and enough log entries for insights.
  async function seedActivity() {
    for (let i = 0; i < 5; i++) await kb.writeConcept(`/n${i}.md`, fm(`N${i}`), `Note ${i}\n`, `Added [N${i}](/n${i}.md).`);
  }
  const capture = () => {
    const calls: Record<string, unknown>[] = [];
    const runner = vi.fn(async (_k: unknown, _i: string, o: Record<string, unknown>) => {
      calls.push(o);
      return { ok: true as const, result: { summary: "ok", filesChanged: [], steps: 1, traceId: "t", commits: [] } };
    });
    return { calls, runner };
  };

  it("passes verification, step-limit rollback and mixed-signal settings to the run", async () => {
    await seedActivity();
    const { calls, runner } = capture();
    await runDream(kb, { mode: "apply" }, runner as never);
    expect(typeof calls[0].verifyRun).toBe("function");
    expect(calls[0].rollbackOnStepLimit).toBe(true);
    expect(calls[0].deriveNewConcepts).toBe(false); // orphans fire too, so not overview-only
  });

  it("treats a run whose only signal is insights as overview-only", async () => {
    await seedActivity();
    // Link everything into one hub so no orphans or broken links remain.
    await kb.writeConcept(
      "/hub.md",
      fm("Hub"),
      [0, 1, 2, 3, 4].map((i) => `[N${i}](/n${i}.md)`).join(" ") + " [Existing](/existing.md)\n",
      "Added hub."
    );
    for (let i = 0; i < 5; i++) await kb.patchConcept(`/n${i}.md`, { replaceBody: `Note ${i} see [Hub](/hub.md)\n` }, `Linked N${i}.`);
    const { calls, runner } = capture();
    const report = await runDream(kb, { mode: "apply" }, runner as never);
    expect(report.signals?.map((s) => s.kind)).toEqual(["insights"]);
    expect(calls[0].deriveNewConcepts).toBe(true);
  });

  it("DREAM_VERIFY=false leaves verification off but keeps the step-limit rollback", async () => {
    process.env.DREAM_VERIFY = "false";
    await seedActivity();
    const { calls, runner } = capture();
    await runDream(kb, { mode: "apply" }, runner as never);
    expect(calls[0].verifyRun).toBeUndefined();
    expect(calls[0].rollbackOnStepLimit).toBe(true);
  });

  it("reports a failed verification as 'unverified' with the reasons", async () => {
    await seedActivity();
    const runner = vi.fn(async () => ({
      ok: false as const,
      status: "rolled_back" as const,
      filesReverted: ["/x.md"],
      error: "Verification failed (1): bad",
      traceId: "t",
      unverified: ["/x.md: derived but cites no concept it was derived from"],
    }));
    const report = await runDream(kb, { mode: "apply" }, runner as never);
    expect(report.outcome).toBe("unverified");
    expect(report.summary).toContain("failed verification");
    expect(report.summary).toContain("derived but cites no concept");
    expect(report.filesChanged).toEqual([]);
  });

  it("reports a step-limited dream as rolled back, not partial", async () => {
    await seedActivity();
    const runner = vi.fn(async () => ({
      ok: false as const,
      status: "rolled_back" as const,
      filesReverted: ["/x.md"],
      error: "stopped",
      traceId: "t",
      stepLimited: { limit: 12 },
    }));
    const report = await runDream(kb, { mode: "apply" }, runner as never);
    expect(report.outcome).toBe("rolled_back");
    expect(report.summary).toContain("used all 12 steps");
  });
});
