import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Issue #20: a dream that changes too much is rolled back as a whole, and
 * every dream commit is identifiable. The model is mocked at the AI SDK
 * boundary, as in mutation-outcome.test.ts.
 */
const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateText,
}));

const { KnowledgeBase } = await import("../src/okf/index.js");
const { runMutation } = await import("../src/agent/agent.js");
const {
  DEFAULT_DREAM_MAX_CHANGES,
  buildDreamInstruction,
  resolveDreamMaxChanges,
  runDream,
} = await import("../src/agent/dream.js");

let root: string;

const fm = (title: string) => ({ type: "note", title, description: `about ${title}` });
const env = (over: Record<string, string | undefined> = {}) => over as NodeJS.ProcessEnv;

const exists = (rel: string) =>
  fs
    .access(path.join(root, rel))
    .then(() => true)
    .catch(() => false);

/** Every file under the bundle except run traces, as path → contents. */
async function tree(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const full = path.join(e.parentPath, e.name);
    const r = path.relative(root, full);
    if (r.startsWith(".traces") || r.startsWith(".git")) continue;
    out[r] = await fs.readFile(full, "utf-8");
  }
  return out;
}

const gitLog = () =>
  execSync("git log --format=%s", { cwd: root }).toString().trim().split("\n");

/** A model run that writes `n` concepts and then answers. */
function writes(kb: InstanceType<typeof KnowledgeBase>, n: number) {
  return async () => {
    for (let i = 0; i < n; i++) {
      await kb.writeConcept(`/c${i}.md`, fm(`C${i}`), `# C${i}\n`, `Added C${i}.`);
    }
    return { text: "done", steps: [{}] };
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-guardrails-"));
  generateText.mockReset();
  delete process.env.MUTATION_ROLLBACK;
  delete process.env.DREAM_MAX_CHANGES;
  process.env.LLM_API_BASE_URL = "http://localhost:8080/v1";
  process.env.LLM_API_FORMAT = "openai";
  process.env.LLM_MODEL = "test-model";
});

afterEach(async () => {
  delete process.env.MUTATION_ROLLBACK;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe("resolveDreamMaxChanges", () => {
  it("defaults when unset or empty", () => {
    expect(resolveDreamMaxChanges(env())).toEqual({ limit: DEFAULT_DREAM_MAX_CHANGES });
    expect(resolveDreamMaxChanges(env({ DREAM_MAX_CHANGES: " " }))).toEqual({
      limit: DEFAULT_DREAM_MAX_CHANGES,
    });
  });

  it("accepts a positive whole number", () => {
    expect(resolveDreamMaxChanges(env({ DREAM_MAX_CHANGES: "40" }))).toEqual({ limit: 40 });
  });

  it.each(["0", "-3", "2.5", "lots"])("falls back to the default with a warning for %s", (raw) => {
    const r = resolveDreamMaxChanges(env({ DREAM_MAX_CHANGES: raw }));
    expect(r.limit).toBe(DEFAULT_DREAM_MAX_CHANGES);
    expect(r.warning).toMatch(/DREAM_MAX_CHANGES/);
  });
});

describe("runMutation change budget", () => {
  it("rolls back every write of a run that exceeds the budget, and says why", async () => {
    const kb = new KnowledgeBase(root);
    await kb.writeConcept("/existing.md", fm("Existing"), "# Existing\n", "Added existing.");
    const before = await tree();
    generateText.mockImplementation(writes(kb, 3));

    const outcome = await runMutation(kb, "consolidate", { maxConceptsChanged: 2 });

    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.status !== "rolled_back") throw new Error(`unexpected ${JSON.stringify(outcome)}`);
    expect(outcome.tooBroad).toEqual({ changed: ["/c0.md", "/c1.md", "/c2.md"], limit: 2 });
    expect(outcome.error).toMatch(/Too broad: the run changed 3 concepts, over the limit of 2/);
    for (const f of ["c0.md", "c1.md", "c2.md"]) expect(await exists(f)).toBe(false);
    // index.md and log.md included: the bundle is byte-identical.
    expect(await tree()).toEqual(before);
  });

  it("keeps a run that stays within the budget", async () => {
    const kb = new KnowledgeBase(root);
    generateText.mockImplementation(writes(kb, 2));

    const outcome = await runMutation(kb, "consolidate", { maxConceptsChanged: 2 });

    expect(outcome.ok).toBe(true);
    expect(await exists("c1.md")).toBe(true);
  });

  it("counts a concept written twice once", async () => {
    const kb = new KnowledgeBase(root);
    generateText.mockImplementation(async () => {
      await kb.writeConcept("/a.md", fm("A"), "# A\n", "Added A.");
      await kb.writeConcept("/a.md", fm("A"), "# A\n\nmore\n", "Enriched A.");
      return { text: "done", steps: [{}] };
    });

    const outcome = await runMutation(kb, "consolidate", { maxConceptsChanged: 1 });

    expect(outcome.ok).toBe(true);
  });

  it("is unlimited when no budget is given (interactive mutations)", async () => {
    const kb = new KnowledgeBase(root);
    generateText.mockImplementation(writes(kb, 5));
    expect((await runMutation(kb, "add five")).ok).toBe(true);
  });

  it("reports partial, not rolled back, when MUTATION_ROLLBACK=false keeps the writes", async () => {
    process.env.MUTATION_ROLLBACK = "false";
    const kb = new KnowledgeBase(root);
    generateText.mockImplementation(writes(kb, 3));

    const outcome = await runMutation(kb, "consolidate", { maxConceptsChanged: 2 });

    if (outcome.ok || outcome.status !== "partial") throw new Error(`unexpected ${JSON.stringify(outcome)}`);
    expect(outcome.error).toMatch(/Too broad/);
    expect(outcome.filesChanged).toEqual(["/c0.md", "/c1.md", "/c2.md"]);
    expect(await exists("c0.md")).toBe(true);
  });
});

describe("dream commits (git)", () => {
  it("prefixes and returns the commits of a run, and lists them afterwards", async () => {
    const kb = new KnowledgeBase(root, { gitAutocommit: true });
    expect((await kb.ensureGitReady()).ok).toBe(true);
    await kb.writeConcept("/user.md", fm("User"), "# User\n", "User wrote this.");
    generateText.mockImplementation(writes(kb, 2));

    const outcome = await runMutation(kb, "consolidate", { commitPrefix: "dream:" });

    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    expect(outcome.result.commits).toHaveLength(2);
    const subjects = gitLog();
    expect(subjects.slice(0, 2)).toEqual(["dream: creation: Added C1.", "dream: creation: Added C0."]);
    // Outside the run nothing is prefixed.
    expect(subjects).toContain("creation: User wrote this.");

    const listed = await kb.commitsWithPrefix("dream:");
    expect(listed.map((c) => c.message)).toEqual([
      "dream: creation: Added C1.",
      "dream: creation: Added C0.",
    ]);
    expect(listed[1].commit).toBe(outcome.result.commits[0]);
  }, 30_000);

  it("prefixes the revert commit of a too-broad run too", async () => {
    const kb = new KnowledgeBase(root, { gitAutocommit: true });
    expect((await kb.ensureGitReady()).ok).toBe(true);
    generateText.mockImplementation(writes(kb, 3));

    const outcome = await runMutation(kb, "consolidate", { commitPrefix: "dream:", maxConceptsChanged: 1 });

    expect(outcome.ok).toBe(false);
    expect(gitLog()[0]).toMatch(/^dream: revert: roll back failed mutation/);
  }, 30_000);

  it("is empty without autocommit", async () => {
    const kb = new KnowledgeBase(root);
    expect(await kb.commitsWithPrefix("dream:")).toEqual([]);
  });
});

describe("runDream guardrails", () => {
  /** One orphan is enough to make a dream run. */
  async function orphanBundle() {
    const kb = new KnowledgeBase(root);
    await kb.writeConcept("/stray.md", fm("Stray"), "# Stray\n", "Added stray.");
    return kb;
  }

  it("runs under the dream prefix and the configured budget, and tells the model the budget", async () => {
    process.env.DREAM_MAX_CHANGES = "7";
    const kb = await orphanBundle();
    const runner = vi.fn(async () => ({
      ok: true,
      result: { summary: "wired", filesChanged: ["/stray.md"], steps: 2, traceId: "t", commits: ["abc"] },
    }));

    const report = await runDream(kb, {}, runner as never);

    const [, instruction, options] = runner.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
    expect(options).toMatchObject({ commitPrefix: "dream:", maxConceptsChanged: 7 });
    expect(instruction).toMatch(/change at most 7 concepts/);
    expect(report).toMatchObject({ outcome: "success", commits: ["abc"], maxChanges: 7 });
  });

  it("reports a budget rollback as too_broad, naming what it touched", async () => {
    const kb = await orphanBundle();
    const runner = vi.fn(async () => ({
      ok: false,
      status: "rolled_back",
      filesReverted: ["/a.md", "/b.md"],
      error: "Too broad",
      traceId: "t",
      tooBroad: { changed: ["/a.md", "/b.md"], limit: 1 },
    }));

    const report = await runDream(kb, {}, runner as never);

    expect(report.outcome).toBe("too_broad");
    expect(report.filesChanged).toEqual([]);
    expect(report.summary).toMatch(/changed 2 concepts, over DREAM_MAX_CHANGES=1\. Nothing was kept\..*\/a\.md, \/b\.md/);
  });

  it("still reports an ordinary failed run as rolled_back", async () => {
    const kb = await orphanBundle();
    const runner = vi.fn(async () => ({
      ok: false,
      status: "rolled_back",
      filesReverted: ["/a.md"],
      error: "model died",
      traceId: "t",
    }));
    expect((await runDream(kb, {}, runner as never)).outcome).toBe("rolled_back");
  });

  it("leaves the instruction unchanged when no budget is passed", () => {
    expect(buildDreamInstruction([])).not.toMatch(/CHANGE BUDGET/);
  });
});
