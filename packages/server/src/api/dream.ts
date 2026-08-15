import express, { type Router } from "express";
import { runDream, type KnowledgeBase } from "@understory/core";
import { getDreamStatus } from "../dreamer.js";

/**
 * Operator surface for the background dreamer.
 *
 * Dreaming is the one part of understory that mutates the bundle with nobody
 * watching, on a timer, hours apart. Two questions were previously
 * unanswerable without reading stdout: "is it actually running, and how did
 * the last few runs go", and "what would it do if it ran right now".
 *
 * Both routes sit under /api, so AUTH_TOKEN protects them when set.
 */
export function dreamRouter(kb: KnowledgeBase): Router {
  const router = express.Router();

  /** Config, schedule, and the recent run history. Cheap — no bundle reads. */
  router.get("/dream/status", (_req, res) => {
    res.json(getDreamStatus());
  });

  /**
   * Dry run: detect signals and report what a dream would work through,
   * without invoking the agent. No tokens, no writes. Safe to poll, though it
   * does lint + graph + a full concept scan, so don't poll it hard.
   */
  router.get("/dream/preview", async (_req, res) => {
    try {
      const report = await runDream(kb, { dryRun: true });
      res.json({
        wouldRun: (report.signals?.length ?? 0) > 0,
        reason: report.reason,
        signals: report.signals ?? [],
        suppressed: report.suppressed ?? [],
      });
    } catch (err) {
      // Most likely an invalid DREAM_SIGNALS value; the message names it.
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
