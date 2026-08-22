import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * End-to-end outcome mapping for runMutation. The model is mocked at the AI
 * SDK boundary: `generateText` stands in for a whole agent run, so a test can
 * write through the KB and then fail exactly the way a flaky local model does.
 */
const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateText,
}));

const { KnowledgeBase } = await import("../src/okf/index.js");
const { runMutation } = await import("../src/agent/agent.js");

let root: string;
let kb: InstanceType<typeof KnowledgeBase>;

const fm = (title: string) => ({ type: "note", title, description: `about ${title}` });

const exists = (rel: string) =>
  fs
    .access(path.join(root, rel))
    .then(() => true)
    .catch(() => false);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-mutation-"));
  kb = new KnowledgeBase(root);
  generateText.mockReset();
  delete process.env.MUTATION_ROLLBACK;
  process.env.LLM_API_BASE_URL = "http://localhost:8080/v1";
  process.env.LLM_API_FORMAT = "openai";
  process.env.LLM_MODEL = "test-model";
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("runMutation outcomes", () => {
  it("returns ok and keeps the writes on success", async () => {
    generateText.mockImplementation(async () => {
      await kb.writeConcept("/alpha.md", fm("Alpha"), "# Alpha\n", "Added Alpha.");
      return { text: "done", steps: [{}, {}] };
    });

    const outcome = await runMutation(kb, "add alpha");

    expect(outcome.ok).toBe(true);
    expect(await exists("alpha.md")).toBe(true);
  });

  it("returns rolled_back and leaves no trace of the writes on failure", async () => {
    generateText.mockImplementation(async () => {
      await kb.writeConcept("/alpha.md", fm("Alpha"), "# Alpha\n", "Added Alpha.");
      await kb.writeConcept("/beta.md", fm("Beta"), "# Beta\n", "Added Beta.");
      throw new Error("model returned malformed tool call");
    });

    const outcome = await runMutation(kb, "add alpha and beta");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.status).toBe("rolled_back");
    expect(outcome.error).toMatch(/malformed tool call/);

    // The point of the whole branch: a mid-run failure leaves nothing behind.
    expect(await exists("alpha.md")).toBe(false);
    expect(await exists("beta.md")).toBe(false);
  });

  it("returns failed (not rolled_back) when nothing was written", async () => {
    generateText.mockRejectedValue(new Error("connection refused"));

    const outcome = await runMutation(kb, "add alpha");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.status).toBe("failed");
  });

  it("falls back to the old partial behaviour when MUTATION_ROLLBACK=false", async () => {
    process.env.MUTATION_ROLLBACK = "false";
    generateText.mockImplementation(async () => {
      await kb.writeConcept("/alpha.md", fm("Alpha"), "# Alpha\n", "Added Alpha.");
      throw new Error("boom");
    });

    const outcome = await runMutation(kb, "add alpha");

    expect(outcome.ok).toBe(false);
    // The behaviour that matters: with the escape hatch set, the partial
    // write survives on disk exactly as it did upstream. (The reported
    // status is "failed" rather than "partial" here only because this mock
    // bypasses the write tools that populate filesChanged; without a
    // journal there is no other signal that anything was written — which is
    // precisely the visibility gap rollback closes.)
    expect(await exists("alpha.md")).toBe(true);
  });

  it("records the rolled_back outcome in the trace", async () => {
    generateText.mockImplementation(async () => {
      await kb.writeConcept("/alpha.md", fm("Alpha"), "# Alpha\n", "Added Alpha.");
      throw new Error("boom");
    });

    await runMutation(kb, "add alpha");

    const traceDir = path.join(root, ".traces");
    const files = await fs.readdir(traceDir);
    const traces = await Promise.all(
      files.map((f) => fs.readFile(path.join(traceDir, f), "utf-8"))
    );
    expect(traces.join("\n")).toContain("rolled_back");
  });
});
