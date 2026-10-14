import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { KnowledgeBase } from "@understory/core";

const runDream = vi.hoisted(() => vi.fn());
vi.mock("@understory/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runDream,
}));

const { dreamRouter } = await import("../src/api/dream.js");
const { startDreamer, getDreamStatus, resetDreamState } = await import("../src/dreamer.js");

const commitsWithPrefix = vi.fn();
let server: Server;
let baseUrl: string;
let bundleRoot: string;

function start(): Promise<void> {
  const app = express();
  app.use("/api", dreamRouter({ commitsWithPrefix } as unknown as KnowledgeBase));
  return new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

beforeEach(async () => {
  bundleRoot = mkdtempSync(path.join(tmpdir(), "understory-dream-"));
  runDream.mockReset();
  commitsWithPrefix.mockReset().mockResolvedValue([]);
  resetDreamState();
  delete process.env.DREAM_MAX_CHANGES;
  delete process.env.DREAM_INTERVAL;
  delete process.env.DREAM_SIGNALS;
  delete process.env.DREAM_INSIGHTS;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  rmSync(bundleRoot, { recursive: true, force: true });
});

describe("GET /api/dream/preview", () => {
  it("reports what a dream would do, as a dry run", async () => {
    runDream.mockResolvedValue({
      ran: false,
      reason: "dry run — no agent invoked, no tokens spent, nothing written",
      signals: [{ kind: "links", count: 2, instruction: "BROKEN LINKS…" }],
      suppressed: [{ kind: "duplicates", count: 1 }],
    });

    const body = await (await fetch(`${baseUrl}/api/dream/preview`)).json();

    expect(body.wouldRun).toBe(true);
    expect(body.signals[0].kind).toBe("links");
    expect(body.suppressed[0]).toEqual({ kind: "duplicates", count: 1 });
    // The point of a preview: it must not be able to write.
    expect(runDream).toHaveBeenCalledWith(expect.anything(), { dryRun: true });
  });

  it("reports wouldRun false for a healthy bundle", async () => {
    runDream.mockResolvedValue({ ran: false, reason: "memory healthy", signals: [], suppressed: [] });
    const body = await (await fetch(`${baseUrl}/api/dream/preview`)).json();
    expect(body.wouldRun).toBe(false);
  });

  it("returns 400 with the offending value when DREAM_SIGNALS is invalid", async () => {
    runDream.mockRejectedValue(new Error("Unknown DREAM_SIGNALS value(s): typo"));
    const res = await fetch(`${baseUrl}/api/dream/preview`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/typo/);
  });
});

describe("GET /api/dream/status", () => {
  it("reports dreaming as disabled when DREAM_INTERVAL is unset", async () => {
    startDreamer(async () => [{ kb: {} as KnowledgeBase, label: null }]);
    const body = await (await fetch(`${baseUrl}/api/dream/status`)).json();
    expect(body.enabled).toBe(false);
    expect(body.lastRun).toBeNull();
  });

  it("reports the schedule and the resolved signal set once enabled", async () => {
    process.env.DREAM_INTERVAL = "6h";
    startDreamer(async () => [{ kb: {} as KnowledgeBase, label: null }]);

    const body = await (await fetch(`${baseUrl}/api/dream/status`)).json();
    expect(body.enabled).toBe(true);
    expect(body.interval).toBe("6h");
    expect(body.clamped).toBe(false);
    expect(body.signals).toEqual(["insights", "links", "oversized", "orphans"].sort());
    expect(body.signals).not.toContain("duplicates");
    expect(body.nextRunAt).toBeTruthy();
  });

  it("reports the change budget and the memory's dream commits from git (#20)", async () => {
    process.env.DREAM_MAX_CHANGES = "8";
    commitsWithPrefix.mockResolvedValue([
      { commit: "abc1234", date: "2026-10-13T10:00:00Z", message: "dream: update: wired orphan" },
    ]);

    const body = await (await fetch(`${baseUrl}/api/dream/status`)).json();

    expect(body.maxChanges).toBe(8);
    expect(commitsWithPrefix).toHaveBeenCalledWith("dream:", 20);
    expect(body.commits).toEqual([
      { commit: "abc1234", date: "2026-10-13T10:00:00Z", message: "dream: update: wired orphan" },
    ]);
    expect(body.undo).toMatch(/revertCommand/);
  });

  it("reports the 5-minute clamp rather than hiding it", async () => {
    process.env.DREAM_INTERVAL = "30s";
    startDreamer(async () => [{ kb: {} as KnowledgeBase, label: null }]);

    const body = await (await fetch(`${baseUrl}/api/dream/status`)).json();
    expect(body.clamped).toBe(true);
    expect(body.intervalMs).toBe(5 * 60_000);
  });
});

describe("startDreamer config validation", () => {
  it("refuses to start on an invalid DREAM_SIGNALS value", () => {
    // Catching a typo at startup, not one interval later when the run
    // silently does less than the operator expects.
    process.env.DREAM_INTERVAL = "6h";
    process.env.DREAM_SIGNALS = "orphans,typo";

    startDreamer(async () => [{ kb: {} as KnowledgeBase, label: null }]);

    expect(getDreamStatus().enabled).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/typo/));
  });

  it("warns on an invalid DREAM_MAX_CHANGES and keeps the default, never unlimited", () => {
    process.env.DREAM_INTERVAL = "6h";
    process.env.DREAM_MAX_CHANGES = "lots";

    startDreamer(async () => [{ kb: {} as KnowledgeBase, label: null }]);

    expect(getDreamStatus().enabled).toBe(true);
    expect(getDreamStatus().maxChanges).toBe(15);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/DREAM_MAX_CHANGES="lots"/));
  });

  it("refuses to start when DREAM_SIGNALS enables nothing", () => {
    process.env.DREAM_INTERVAL = "6h";
    process.env.DREAM_SIGNALS = "insights";
    process.env.DREAM_INSIGHTS = "false";

    startDreamer(async () => [{ kb: {} as KnowledgeBase, label: null }]);

    expect(getDreamStatus().enabled).toBe(false);
  });

  it("stays disabled on an unparseable interval", () => {
    process.env.DREAM_INTERVAL = "banana";
    startDreamer(async () => [{ kb: {} as KnowledgeBase, label: null }]);
    expect(getDreamStatus().enabled).toBe(false);
  });
});

describe("dream run history", () => {
  it("records each scheduled run, newest first", async () => {
    vi.useFakeTimers();
    try {
      process.env.DREAM_INTERVAL = "5m";
      runDream.mockResolvedValue({
        ran: true,
        outcome: "success",
        summary: "fixed 2 links",
        filesChanged: ["/a.md", "/b.md"],
        signals: [{ kind: "links", count: 2, instruction: "…" }],
        suppressed: [],
      });

      startDreamer(async () => [{ kb: {} as KnowledgeBase, label: null }]);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);

      const status = getDreamStatus();
      expect(status.history).toHaveLength(1);
      expect(status.lastRun).toMatchObject({
        ran: true,
        outcome: "success",
        filesChanged: ["/a.md", "/b.md"],
      });
      expect(status.lastRun!.signals).toEqual([{ kind: "links", count: 2 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a successful run with commits a command that reverts exactly that run", async () => {
    vi.useFakeTimers();
    try {
      process.env.DREAM_INTERVAL = "5m";
      runDream.mockResolvedValue({
        ran: true,
        outcome: "success",
        summary: "split a fat concept",
        filesChanged: ["/a.md", "/b.md"],
        commits: ["1111111", "2222222", "3333333"],
        signals: [],
        suppressed: [],
      });

      startDreamer(async () => [{ kb: {} as KnowledgeBase, label: null }]);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);

      expect(getDreamStatus().lastRun).toMatchObject({
        commits: ["1111111", "2222222", "3333333"],
        revertCommand: "git revert --no-edit 1111111^..3333333",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs a too-broad dream to stderr with its outcome", async () => {
    vi.useFakeTimers();
    try {
      process.env.DREAM_INTERVAL = "5m";
      runDream.mockResolvedValue({
        ran: true,
        outcome: "too_broad",
        summary: "dream rolled back as too broad: it changed 30 concepts",
        filesChanged: [],
        signals: [],
        suppressed: [],
      });

      startDreamer(async () => [{ kb: {} as KnowledgeBase, label: null }]);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);

      expect(getDreamStatus().lastRun).toMatchObject({ outcome: "too_broad" });
      expect(getDreamStatus().lastRun!.revertCommand).toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/dream too_broad/));
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a thrown dream as an error rather than losing it", async () => {
    vi.useFakeTimers();
    try {
      process.env.DREAM_INTERVAL = "5m";
      runDream.mockRejectedValue(new Error("provider unreachable"));

      startDreamer(async () => [{ kb: {} as KnowledgeBase, label: null }]);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);

      expect(getDreamStatus().lastRun).toMatchObject({
        ran: false,
        error: "provider unreachable",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
