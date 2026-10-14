import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Issue #34: DREAM_MODE=review. Real git throughout; the model is mocked at
 * the AI SDK boundary and writes through whichever KB the dream runs against
 * (the worktree's, in review mode).
 */
const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateText,
}));

const { KnowledgeBase } = await import("../src/okf/index.js");
const { runMutation } = await import("../src/agent/agent.js");
const { runDream } = await import("../src/agent/dream.js");
const { DreamReviews, addedLogBullets, resolveDreamMode } = await import("../src/agent/dream-review.js");

type KB = InstanceType<typeof KnowledgeBase>;

let root: string;
let kb: KB;
/** The KB the current dream run writes through (the worktree's in review mode). */
let dreamKb: KB;

const fm = (title: string) => ({ type: "note", title, description: `about ${title}` });
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
const read = (rel: string) => fs.readFile(path.join(root, rel), "utf-8");
const exists = (rel: string) =>
  fs
    .access(path.join(root, rel))
    .then(() => true)
    .catch(() => false);

/** runMutation, remembering which KB it was handed. */
const runner = (async (k: KB, instruction: string, options: object) => {
  dreamKb = k;
  return runMutation(k, instruction, options);
}) as typeof runMutation;

/** A model run that writes the given concepts through the dream's KB. */
function modelWrites(...concepts: [string, string][]) {
  generateText.mockImplementation(async () => {
    for (const [p, body] of concepts) {
      await dreamKb.writeConcept(p, fm(path.basename(p, ".md")), body, `Dream wrote ${p}.`);
    }
    return { text: "Wired the stray concept into a new hub.", steps: [{}] };
  });
}

const reviewDream = () => runDream(kb, { mode: "review" }, runner);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-review-"));
  kb = new KnowledgeBase(root, { gitAutocommit: true });
  expect((await kb.ensureGitReady()).ok).toBe(true);
  // An orphan, so a dream has something to do.
  await kb.writeConcept("/stray.md", fm("Stray"), "# Stray\n", "Added stray.");
  generateText.mockReset();
  delete process.env.DREAM_MAX_CHANGES;
  process.env.LLM_API_BASE_URL = "http://localhost:8080/v1";
  process.env.LLM_API_FORMAT = "openai";
  process.env.LLM_MODEL = "test-model";
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe("resolveDreamMode", () => {
  const env = (v?: string) => ({ DREAM_MODE: v }) as NodeJS.ProcessEnv;
  it("defaults to apply", () => {
    expect(resolveDreamMode(env())).toBe("apply");
    expect(resolveDreamMode(env(" "))).toBe("apply");
  });
  it("accepts review, case-insensitively", () => {
    expect(resolveDreamMode(env("Review"))).toBe("review");
  });
  it("throws on an unknown value rather than silently applying", () => {
    expect(() => resolveDreamMode(env("reveiw"))).toThrow(/Unknown DREAM_MODE "reveiw"/);
  });
});

describe("addedLogBullets", () => {
  it("returns only the dream's new bullets, newest first", () => {
    const base = "# Directory Update Log\n\n## 2026-10-13\n\n* **Creation**: Added stray.\n";
    const dream =
      "# Directory Update Log\n\n## 2026-10-14\n\n* **Update**: Linked stray.\n* **Creation**: Added hub.\n\n## 2026-10-13\n\n* **Creation**: Added stray.\n";
    expect(addedLogBullets(base, dream)).toEqual([
      { action: "Update", summary: "Linked stray." },
      { action: "Creation", summary: "Added hub." },
    ]);
  });
});

describe("review mode: running a dream", () => {
  it("changes nothing live and leaves a reviewable dream/* branch", async () => {
    const head = git("rev-parse", "HEAD").trim();
    modelWrites(["/hub.md", "# Hub\n\nSee [Stray](/stray.md).\n"]);

    const report = await reviewDream();

    expect(report).toMatchObject({ ran: true, outcome: "success" });
    expect(report.review?.branch).toMatch(/^dream\/\d{8}-\d{6}$/);
    expect(report.commits).toBeUndefined(); // they are on the branch, not live
    // Live bundle untouched.
    expect(git("rev-parse", "HEAD").trim()).toBe(head);
    expect(await exists("hub.md")).toBe(false);
    // Worktree cleaned up.
    expect(git("worktree", "list").trim().split("\n")).toHaveLength(1);

    const [review] = await new DreamReviews(kb).list();
    expect(review).toMatchObject({
      branch: report.review!.branch,
      filesChanged: ["/hub.md"],
      base: head,
      liveCommitsSince: 0,
    });
    expect(review.title).toMatch(/^dream: review: 1 concept\(s\): Wired the stray/);
    expect(review.summary).toMatch(/Signals: orphans 1/);

    const diff = await new DreamReviews(kb).diff(review.id);
    expect(diff).toContain("+++ b/hub.md");
    expect(diff).not.toContain("index.md");
    expect(diff).not.toContain("log.md");
  }, 30_000);

  it("keeps the run's trace in the live bundle", async () => {
    const before = await fs.readdir(path.join(root, ".traces")).catch(() => [] as string[]);
    modelWrites(["/hub.md", "# Hub\n"]);
    await reviewDream();
    const after = await fs.readdir(path.join(root, ".traces"));
    expect(after.length).toBe(before.length + 1);
  }, 30_000);

  it("leaves no branch when the dream changes nothing, fails, or is too broad", async () => {
    generateText.mockResolvedValueOnce({ text: "Nothing worth changing.", steps: [{}] });
    expect((await reviewDream()).review).toBeUndefined();

    generateText.mockRejectedValueOnce(new Error("model died"));
    expect((await reviewDream()).review).toBeUndefined();

    process.env.DREAM_MAX_CHANGES = "1";
    modelWrites(["/a.md", "# A\n"], ["/b.md", "# B\n"]);
    const tooBroad = await reviewDream();
    expect(tooBroad.outcome).toBe("too_broad");
    expect(tooBroad.review).toBeUndefined();

    expect(await new DreamReviews(kb).list()).toEqual([]);
    expect(git("worktree", "list").trim().split("\n")).toHaveLength(1);
  }, 60_000);

  it("skips the next dream while a review is pending", async () => {
    modelWrites(["/hub.md", "# Hub\n"]);
    const first = await reviewDream();
    generateText.mockReset();

    const second = await reviewDream();

    expect(second.ran).toBe(false);
    expect(second.reason).toContain(`review pending: ${first.review!.branch}`);
    expect(generateText).not.toHaveBeenCalled();
  }, 30_000);

  it("refuses without git, since a review is a branch", async () => {
    const plain = new KnowledgeBase(await fs.mkdtemp(path.join(os.tmpdir(), "ustory-review-nogit-")));
    await plain.writeConcept("/stray.md", fm("Stray"), "# Stray\n", "Added stray.");
    const report = await runDream(plain, { mode: "review" }, runner);
    expect(report.ran).toBe(false);
    expect(report.reason).toMatch(/needs GIT_AUTOCOMMIT=true/);
    await fs.rm(plain.bundle.root, { recursive: true, force: true });
  });
});

describe("review mode: accept and reject", () => {
  it("accept merges the dream into the live bundle and removes the branch", async () => {
    modelWrites(["/hub.md", "# Hub\n\nSee [Stray](/stray.md).\n"]);
    const { review } = await reviewDream();
    const id = review!.branch.slice("dream/".length);

    const result = await new DreamReviews(kb).accept(id);

    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.filesChanged).toEqual(["/hub.md"]);
    expect(result.revertCommand).toBe(`git revert -m 1 --no-edit ${result.commit}`);
    expect(await read("hub.md")).toContain("See [Stray]");
    expect(await read("index.md")).toContain("[hub](hub.md)");
    expect(await read("log.md")).toContain("Dream wrote /hub.md.");
    expect(git("log", "-1", "--format=%s")).toMatch(/^dream: accept dream\/\d{8}-\d{6} \(1 concept\(s\)\)/);
    expect(await new DreamReviews(kb).list()).toEqual([]);
  }, 30_000);

  it("accept merges cleanly after live edits, keeping both sides' log entries", async () => {
    modelWrites(["/hub.md", "# Hub\n"]);
    const { review } = await reviewDream();
    // A user mutation lands while the review is pending (log.md and index.md diverge).
    await kb.writeConcept("/user.md", fm("User"), "# User\n", "User added a fact.");
    expect((await new DreamReviews(kb).list())[0].liveCommitsSince).toBe(1);

    const result = await new DreamReviews(kb).accept(review!.branch.slice("dream/".length));

    expect(result.ok).toBe(true);
    const log = await read("log.md");
    expect(log).toContain("User added a fact.");
    expect(log).toContain("Dream wrote /hub.md.");
    expect(log).not.toMatch(/<<<<<<<|>>>>>>>/);
    const index = await read("index.md");
    expect(index).toContain("hub.md");
    expect(index).toContain("user.md");
    expect(index).not.toMatch(/<<<<<<<|>>>>>>>/);
    expect(git("status", "--porcelain", "--untracked-files=no").trim()).toBe("");
  }, 30_000);

  it("works on a bundle with never-committed files, and the dream sees them", async () => {
    // Content present on disk but never committed (e.g. copied in before git was set up).
    await fs.writeFile(path.join(root, "handwritten.md"), "---\ntype: note\ntitle: Handwritten\n---\n# Handwritten\n");
    let sawIt = false;
    generateText.mockImplementation(async () => {
      sawIt = await fs
        .access(path.join(dreamKb.bundle.root, "handwritten.md"))
        .then(() => true)
        .catch(() => false);
      await dreamKb.writeConcept("/hub.md", fm("Hub"), "# Hub\n", "Dream wrote /hub.md.");
      return { text: "done", steps: [{}] };
    });

    const { review } = await reviewDream();
    expect(sawIt).toBe(true);

    const result = await new DreamReviews(kb).accept(review!.branch.slice("dream/".length));
    expect(result.ok).toBe(true);
    expect(await exists("handwritten.md")).toBe(true);
    expect(await exists("hub.md")).toBe(true);
  }, 30_000);

  it("commits a hand edit made while the review was pending, then merges", async () => {
    modelWrites(["/hub.md", "# Hub\n"]);
    const { review } = await reviewDream();
    await fs.writeFile(path.join(root, "stray.md"), "---\ntype: note\ntitle: Stray\n---\n# Stray\n\nedited by hand\n");

    const result = await new DreamReviews(kb).accept(review!.branch.slice("dream/".length));

    expect(result.ok).toBe(true);
    expect(await read("stray.md")).toContain("edited by hand");
    expect(git("log", "--format=%s")).toContain("update: uncommitted changes before accepting a dream review");
  }, 30_000);

  it("refuses a concept conflict and leaves both sides intact", async () => {
    await kb.writeConcept("/shared.md", fm("Shared"), "# Shared\n\noriginal\n", "Added shared.");
    modelWrites(["/shared.md", "# Shared\n\ndream version\n"]);
    const { review } = await reviewDream();
    const id = review!.branch.slice("dream/".length);
    await kb.writeConcept("/shared.md", fm("Shared"), "# Shared\n\nuser version\n", "User edited shared.");
    const head = git("rev-parse", "HEAD").trim();

    const result = await new DreamReviews(kb).accept(id);

    expect(result).toEqual({ ok: false, reason: "conflict", conflicts: ["/shared.md"] });
    expect(await read("shared.md")).toContain("user version");
    expect(git("rev-parse", "HEAD").trim()).toBe(head);
    expect(git("status", "--porcelain", "--untracked-files=no").trim()).toBe("");
    expect((await new DreamReviews(kb).list()).map((r) => r.id)).toEqual([id]);
  }, 30_000);

  it("reject discards the review and lets the next dream run", async () => {
    modelWrites(["/hub.md", "# Hub\n"]);
    const { review } = await reviewDream();
    const reviews = new DreamReviews(kb);

    expect(await reviews.reject(review!.branch.slice("dream/".length))).toBe(true);

    expect(await reviews.list()).toEqual([]);
    expect(await exists("hub.md")).toBe(false);
    modelWrites(["/hub.md", "# Hub\n"]);
    expect((await reviewDream()).review).toBeDefined();
  }, 30_000);

  it("treats unknown or malformed ids as not found", async () => {
    const reviews = new DreamReviews(kb);
    expect(await reviews.get("../../etc")).toBeNull();
    expect(await reviews.diff("20990101-000000")).toBeNull();
    expect(await reviews.accept("--force")).toEqual({ ok: false, reason: "not_found" });
    expect(await reviews.reject("main")).toBe(false);
  });
});
