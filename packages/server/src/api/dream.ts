import express, { type Router } from "express";
import { DREAM_COMMIT_PREFIX, runDream, type KnowledgeBase } from "@understory/core";
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

  /**
   * Config, schedule, the recent run history, and this memory's recent dream
   * commits. One `git log`, no concept reads. The run history resets with the
   * process; `commits` comes from git, so it survives restarts.
   */
  router.get("/dream/status", async (_req, res) => {
    const commits = await kb.commitsWithPrefix(DREAM_COMMIT_PREFIX, 20);
    res.json({
      ...getDreamStatus(),
      commits,
      undo:
        "Each history entry with commits has a revertCommand that undoes exactly that run; " +
        "run it in the bundle directory. A single commit reverts with `git revert <commit>`.",
    });
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
