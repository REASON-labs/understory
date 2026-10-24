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
const { runForget } = await import("../src/agent/forget.js");
const {
  deadlinePhase,
  deadlineStep,
  laterPhase,
  resolveMutationDeadline,
  DEADLINE_WRITE_TOOLS,
  MIN_DEADLINE_MS,
} = await import("../src/agent/deadline.js");

describe("resolveMutationDeadline", () => {
  it("is off unless configured", () => {
    expect(resolveMutationDeadline({})).toEqual({ ms: null });
    expect(resolveMutationDeadline({ AGENT_MUTATION_DEADLINE: "  " })).toEqual({ ms: null });
  });
  it("reads durations", () => {
    expect(resolveMutationDeadline({ AGENT_MUTATION_DEADLINE: "270s" })).toEqual({ ms: 270_000 });
    expect(resolveMutationDeadline({ AGENT_MUTATION_DEADLINE: "4m" })).toEqual({ ms: 240_000 });
  });
  it("turns a bad or too-short value into 'no deadline' with a warning, never a guess", () => {
    for (const bad of ["soon", "-5s", "0s", "10s"]) {
      const r = resolveMutationDeadline({ AGENT_MUTATION_DEADLINE: bad });
      expect(r.ms).toBeNull();
      expect(r.warning).toMatch(/AGENT_MUTATION_DEADLINE/);
    }
    expect(MIN_DEADLINE_MS).toBe(30_000);
  });
});

describe("phases", () => {
  const D = 100_000;
  it("explores, then writes at 65%, then wraps at 90%", () => {
    expect(deadlinePhase(0, D)).toBe("explore");
    expect(deadlinePhase(64_999, D)).toBe("explore");
    expect(deadlinePhase(65_000, D)).toBe("write");
    expect(deadlinePhase(89_999, D)).toBe("write");
    expect(deadlinePhase(90_000, D)).toBe("wrap");
    expect(deadlinePhase(500_000, D)).toBe("wrap");
  });
  it("never moves back to an earlier phase", () => {
    expect(laterPhase("write", "explore")).toBe("write");
    expect(laterPhase("explore", "wrap")).toBe("wrap");
    expect(laterPhase("wrap", "write")).toBe("wrap");
  });
  it("explore changes nothing", () => {
    expect(deadlineStep("explore", false, 60_000, "SYS")).toEqual({});
  });
  it("write phase allows only write tools (never delete) and keeps the original prompt", () => {
    const s = deadlineStep("write", false, 30_000, "SYS");
    expect(s.activeTools).toEqual([...DEADLINE_WRITE_TOOLS]);
    expect(s.activeTools).not.toContain("delete_concept");
    expect(s.system).toMatch(/^SYS\n\nTIME LIMIT: about 30s remain/);
    expect(s.system).toMatch(/write it now/);
  });
  it("after a write, the write phase says to finish links and conclude", () => {
    expect(deadlineStep("write", true, 20_000, "SYS").system).toMatch(/Finish any remaining links/);
  });
  it("wrap phase gives no tools at all", () => {
    const s = deadlineStep("wrap", true, 5_000, "SYS");
    expect(s.activeTools).toEqual([]);
    expect(s.system).toMatch(/TIME IS UP/);
  });
});

describe("runMutation with a deadline", () => {
  let root: string;
  let kb: InstanceType<typeof KnowledgeBase>;
  const fm = (title: string) => ({ type: "note", title, description: `about ${title}` });
  const exists = (rel: string) => fs.access(path.join(root, rel)).then(() => true, () => false);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-deadline-"));
    kb = new KnowledgeBase(root);
    generateText.mockReset();
    delete process.env.AGENT_MUTATION_DEADLINE;
    process.env.LLM_API_BASE_URL = "http://localhost:8080/v1";
    process.env.LLM_API_FORMAT = "openai";
    process.env.LLM_MODEL = "test-model";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  type Args = { prepareStep?: () => { system?: string; activeTools?: string[] } };
  /** Run the mocked agent: at each given elapsed time it asks prepareStep what the next step may do. */
  function script(times: number[], afterStep?: (i: number) => Promise<void>) {
    const seen: ({ system?: string; activeTools?: string[] } | undefined)[] = [];
    generateText.mockImplementation(async (args: Args) => {
      for (let i = 0; i < times.length; i++) {
        vi.setSystemTime(new Date(Date.parse("2026-10-22T00:00:00Z") + times[i]));
        seen.push(args.prepareStep?.());
        if (afterStep) await afterStep(i);
      }
      return { text: "done", steps: times.map(() => ({})), finishReason: "stop" };
    });
    return seen;
  }

  it("adds no prepareStep, and changes nothing, when no deadline is set", async () => {
    let passed: Args | undefined;
    generateText.mockImplementation(async (args: Args) => {
      passed = args;
      await kb.writeConcept("/a.md", fm("A"), "# A\n", "Added A.");
      return { text: "done", steps: [{}], finishReason: "stop" };
    });
    const outcome = await runMutation(kb, "go");
    expect(passed?.prepareStep).toBeUndefined();
    expect(outcome.ok && outcome.result.summary).toBe("done");
  });

  it("walks explore, write, wrap as time passes", async () => {
    const seen = script([1_000, 70_000, 95_000]);
    await runMutation(kb, "go", { deadlineMs: 100_000 });
    expect(seen[0]).toEqual({});
    expect(seen[1]?.activeTools).toEqual(["write_concept", "patch_concept"]);
    expect(seen[1]?.system).toMatch(/TIME LIMIT/);
    expect(seen[2]?.activeTools).toEqual([]);
  });

  it("reads the deadline from AGENT_MUTATION_DEADLINE when the caller does not say", async () => {
    process.env.AGENT_MUTATION_DEADLINE = "100s";
    const seen = script([70_000]);
    await runMutation(kb, "go");
    expect(seen[0]?.activeTools).toEqual(["write_concept", "patch_concept"]);
  });

  it("keeps a run that stored something, and tells the caller it was cut short", async () => {
    script([1_000, 70_000], async (i) => {
      if (i === 1) await kb.writeConcept("/a.md", fm("A"), "# A\n", "Added A.");
    });
    const outcome = await runMutation(kb, "go", { deadlineMs: 100_000 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.summary).toMatch(/reached its time limit and was moved to a write-only phase/);
    expect(await exists("a.md")).toBe(true);
  });

  it("does not add the note to a run that never needed the write phase", async () => {
    script([1_000, 2_000], async (i) => {
      if (i === 1) await kb.writeConcept("/a.md", fm("A"), "# A\n", "Added A.");
    });
    const outcome = await runMutation(kb, "go", { deadlineMs: 100_000 });
    expect(outcome.ok && outcome.result.summary).toBe("done");
  });

  it("reports a plain failure, not a success, when it reached wrap-up with nothing stored", async () => {
    script([1_000, 95_000]);
    const outcome = await runMutation(kb, "go", { deadlineMs: 100_000 });
    expect(outcome).toMatchObject({ ok: false, status: "failed" });
    if (outcome.ok || outcome.status !== "failed") return;
    expect(outcome.error).toMatch(/deadline before storing anything, so nothing was saved/);
    expect(outcome.error).toMatch(/AGENT_MUTATION_DEADLINE/);
  });

  it("null switches the deadline off even when the environment sets one", async () => {
    process.env.AGENT_MUTATION_DEADLINE = "100s";
    let passed: Args | undefined;
    generateText.mockImplementation(async (args: Args) => {
      passed = args;
      await kb.writeConcept("/a.md", fm("A"), "# A\n", "Added A.");
      return { text: "done", steps: [{}], finishReason: "stop" };
    });
    await runMutation(kb, "go", { deadlineMs: null });
    expect(passed?.prepareStep).toBeUndefined();
  });
});

describe("unattended runs opt out of the interactive deadline", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-deadline-un-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("a dream passes deadlineMs: null to its run", async () => {
    const kb = new KnowledgeBase(root);
    for (let i = 0; i < 5; i++) await kb.writeConcept(`/n${i}.md`, { type: "note", title: `N${i}` }, `Note ${i}\n`, `Added [N${i}](/n${i}.md).`);
    const calls: Record<string, unknown>[] = [];
    const runner = vi.fn(async (_k: unknown, _i: string, o: Record<string, unknown>) => {
      calls.push(o);
      return { ok: true as const, result: { summary: "ok", filesChanged: [], steps: 1, traceId: "t", commits: [] } };
    });
    await runDream(kb, { mode: "apply" }, runner as never);
    expect(calls[0].deadlineMs).toBeNull();
  });

  it("the forget rewrite passes deadlineMs: null to its run", async () => {
    const kb = new KnowledgeBase(root);
    await kb.writeConcept("/a.md", { type: "note", sources: [{ ref: "https://x.example/a" }, { ref: "https://x.example/b" }] }, "text\n", "a");
    let seen: { deadlineMs?: number | null } | undefined;
    const runner = async (_k: unknown, _i: string, o?: { deadlineMs?: number | null }) => {
      seen = o;
      return { ok: false as const, status: "failed" as const, error: "stop here" };
    };
    await runForget(kb, { source: "https://x.example/a" }, { dryRun: false, runner: runner as never });
    expect(seen?.deadlineMs).toBeNull();
  });
});
