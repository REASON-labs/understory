import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";
import {
  DEFAULT_DREAM_SIGNALS,
  detectSignals,
  resolveDreamSignals,
  runDream,
} from "../src/agent/dream.js";

let root: string;
let kb: KnowledgeBase;

const env = (over: Record<string, string | undefined> = {}) => over as NodeJS.ProcessEnv;

/**
 * A bundle that trips several signals at once: two near-identical concepts
 * (duplicates), one concept nobody links to (orphan), and a dangling link.
 */
async function seedMessyBundle(kb: KnowledgeBase): Promise<void> {
  await kb.writeConcept(
    "/billing-rate-limits.md",
    { type: "policy", title: "Billing API rate limits", description: "100 requests per minute per client" },
    "# Limits\n\n100 rpm.\n",
    "Added limits."
  );
  await kb.writeConcept(
    "/api-rate-limits-billing.md",
    { type: "policy", title: "API rate limits for billing", description: "per client limit of 100 requests per minute" },
    "# Limits\n\nSame thing, worded differently.\n",
    "Added duplicate."
  );
  await kb.writeConcept(
    "/has-broken-link.md",
    { type: "note", title: "Points nowhere", description: "dangling" },
    "# Note\n\nSee [missing](/does-not-exist.md).\n",
    "Added note."
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-dreamctl-"));
  kb = new KnowledgeBase(root);
  delete process.env.DREAM_SIGNALS;
  delete process.env.DREAM_INSIGHTS;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  delete process.env.DREAM_SIGNALS;
  delete process.env.DREAM_INSIGHTS;
});

describe("resolveDreamSignals", () => {
  it("defaults to everything except duplicates", () => {
    const signals = resolveDreamSignals(env());
    expect([...signals].sort()).toEqual([...DEFAULT_DREAM_SIGNALS].sort());
    // The safety property this default exists for.
    expect(signals.has("duplicates")).toBe(false);
  });

  it('enables everything for "all"', () => {
    expect(resolveDreamSignals(env({ DREAM_SIGNALS: "all" })).has("duplicates")).toBe(true);
  });

  it("accepts an explicit comma list, trimmed and case-insensitive", () => {
    const signals = resolveDreamSignals(env({ DREAM_SIGNALS: " Orphans , LINKS " }));
    expect([...signals].sort()).toEqual(["links", "orphans"]);
  });

  it("throws on an unknown value rather than silently dreaming with fewer signals", () => {
    expect(() => resolveDreamSignals(env({ DREAM_SIGNALS: "orphans,typo" }))).toThrow(
      /Unknown DREAM_SIGNALS value\(s\): typo/
    );
  });

  it("still honours the legacy DREAM_INSIGHTS=false flag", () => {
    expect(resolveDreamSignals(env({ DREAM_INSIGHTS: "false" })).has("insights")).toBe(false);
    expect(
      resolveDreamSignals(env({ DREAM_SIGNALS: "all", DREAM_INSIGHTS: "false" })).has("insights")
    ).toBe(false);
  });
});

describe("detectSignals", () => {
  it("separates enabled signals from suppressed ones, keeping counts for both", async () => {
    await seedMessyBundle(kb);

    const { signals, suppressed } = await detectSignals(kb, resolveDreamSignals(env()));

    expect(signals.map((s) => s.kind)).toContain("links");
    // Suppressed signals must still be counted — hiding them would hide the
    // cost of leaving duplicate-merge off.
    expect(suppressed.map((s) => s.kind)).toContain("duplicates");
    expect(suppressed.find((s) => s.kind === "duplicates")!.count).toBeGreaterThan(0);
  });

  it("surfaces duplicates as an enabled signal when explicitly turned on", async () => {
    await seedMessyBundle(kb);

    const { signals, suppressed } = await detectSignals(
      kb,
      resolveDreamSignals(env({ DREAM_SIGNALS: "all" }))
    );

    expect(signals.map((s) => s.kind)).toContain("duplicates");
    expect(suppressed).toEqual([]);
  });
});

describe("runDream gating", () => {
  it("does not invoke the agent when only suppressed signals fired", async () => {
    // Only a duplicate pair — nothing the default signal set acts on.
    await kb.writeConcept(
      "/a.md",
      { type: "policy", title: "Billing API rate limits", description: "100 requests per minute" },
      "# A\n\nSee [B](/b.md).\n",
      "add a"
    );
    await kb.writeConcept(
      "/b.md",
      { type: "policy", title: "API rate limits billing", description: "per client 100 requests per minute" },
      "# B\n\nSee [A](/a.md).\n",
      "add b"
    );

    const runner = vi.fn();
    const report = await runDream(kb, {}, runner as never);

    expect(runner).not.toHaveBeenCalled();
    expect(report.ran).toBe(false);
    // The reason must name what was suppressed, or an operator watching logs
    // sees "nothing to do" while duplicates quietly pile up.
    expect(report.reason).toMatch(/suppressed by DREAM_SIGNALS/);
    expect(report.suppressed?.map((s) => s.kind)).toContain("duplicates");
  });

  it("passes only enabled signal instructions to the agent", async () => {
    await seedMessyBundle(kb);
    const runner = vi.fn().mockResolvedValue({
      ok: true,
      result: { summary: "fixed", filesChanged: ["/has-broken-link.md"], steps: 2, traceId: "t" },
    });

    await runDream(kb, {}, runner as never);

    const instruction = runner.mock.calls[0][1] as string;
    expect(instruction).toContain("BROKEN LINKS");
    expect(instruction).not.toContain("LIKELY DUPLICATES");
  });
});

describe("runDream dry run", () => {
  it("reports the plan without invoking the agent or writing anything", async () => {
    await seedMessyBundle(kb);
    const runner = vi.fn();

    const report = await runDream(kb, { dryRun: true }, runner as never);

    expect(runner).not.toHaveBeenCalled();
    expect(report.ran).toBe(false);
    expect(report.reason).toMatch(/dry run/);
    expect(report.signals!.length).toBeGreaterThan(0);
    expect(report.signals!.every((s) => s.count > 0)).toBe(true);
    // Instructions are included so a preview shows the actual prompt text.
    expect(report.signals!.map((s) => s.instruction).join()).toContain("BROKEN LINKS");
  });

  it("reports a healthy bundle as nothing to do", async () => {
    await kb.writeConcept(
      "/a.md",
      { type: "note", title: "Alpha topic", description: "first" },
      "See [B](/b.md).",
      "add a"
    );
    await kb.writeConcept(
      "/b.md",
      { type: "note", title: "Beta subject", description: "second" },
      "See [A](/a.md).",
      "add b"
    );

    const report = await runDream(kb, { dryRun: true }, vi.fn() as never);
    expect(report.signals).toEqual([]);
    expect(report.reason).toMatch(/healthy/);
  });
});

describe("runDream outcome reporting", () => {
  it("distinguishes a rolled-back dream from one that left damage", async () => {
    await seedMessyBundle(kb);
    const runner = vi.fn().mockResolvedValue({
      ok: false,
      status: "rolled_back",
      filesReverted: ["/has-broken-link.md", "/index.md"],
      error: "model died",
      traceId: "t",
    });

    const report = await runDream(kb, {}, runner as never);

    expect(report.outcome).toBe("rolled_back");
    expect(report.filesChanged).toEqual([]);
    expect(report.summary).toMatch(/rolled back \(2 file\(s\) restored\)/);
  });

  it("reports a partial dream with the files it left behind", async () => {
    await seedMessyBundle(kb);
    const runner = vi.fn().mockResolvedValue({
      ok: false,
      status: "partial",
      filesChanged: ["/has-broken-link.md"],
      error: "rollback failed",
      traceId: "t",
    });

    const report = await runDream(kb, {}, runner as never);

    expect(report.outcome).toBe("partial");
    expect(report.filesChanged).toEqual(["/has-broken-link.md"]);
  });
});
