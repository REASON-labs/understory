import express, { type Router } from "express";
import { DREAM_COMMIT_PREFIX, DreamReviews, runDream, type KnowledgeBase } from "@understory/core";
import { getDreamStatus } from "../dreamer.js";

/**
 * Operator surface for the background dreamer.
 *
 * Dreaming is the one part of understory that mutates the bundle with nobody
 * watching, on a timer, hours apart. Two questions were previously
 * unanswerable without reading stdout: "is it actually running, and how did
 * the last few runs go", and "what would it do if it ran right now".
 * With DREAM_MODE=review (issue #34) a dream's changes wait on a branch, and
 * the review routes below are how a human reads, accepts or rejects them.
 *
 * All routes sit under /api, so AUTH_TOKEN protects them when set.
 */
export function dreamRouter(kb: KnowledgeBase): Router {
  const router = express.Router();
  // Reviews are git branches; without autocommit there are none.
  const reviews = () => (kb.gitEnabled ? new DreamReviews(kb) : null);

  /**
   * Config, schedule, the recent run history, this memory's recent dream
   * commits and pending reviews. A few git calls, no concept reads. The run
   * history resets with the process; commits and reviews come from git, so
   * they survive restarts.
   */
  router.get("/dream/status", async (_req, res) => {
    const commits = await kb.commitsWithPrefix(DREAM_COMMIT_PREFIX, 20);
    const pending = (await reviews()?.list()) ?? [];
    res.json({
      // Only this memory's runs: with profiles the history is process-wide.
      ...getDreamStatus(kb.bundle.root),
      commits,
      reviews: pending,
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

  /** Pending dream reviews, newest first. */
  router.get("/dream/reviews", async (_req, res) => {
    res.json((await reviews()?.list()) ?? []);
  });

  router.get("/dream/reviews/:id", async (req, res) => {
    const review = await reviews()?.get(req.params.id);
    if (!review) return void res.status(404).json({ error: "no such review" });
    res.json(review);
  });

  /** The review's changes as a plain-text unified diff (readable with curl). */
  router.get("/dream/reviews/:id/diff", async (req, res) => {
    const diff = await reviews()?.diff(req.params.id);
    if (diff == null) return void res.status(404).json({ error: "no such review" });
    res.type("text/plain").send(diff || "(no concept changes)\n");
  });

  /** Merge the review into the live memory. 409 when the dream and the live memory changed the same concept. */
  router.post("/dream/reviews/:id/accept", async (req, res) => {
    const r = reviews();
    if (!r) return void res.status(404).json({ error: "no such review" });
    const result = await r.accept(req.params.id);
    if (result.ok) return void res.json(result);
    const status = result.reason === "not_found" ? 404 : result.reason === "error" ? 500 : 409;
    res.status(status).json(result);
  });

  /** Discard the review. */
  router.post("/dream/reviews/:id/reject", async (req, res) => {
    const rejected = (await reviews()?.reject(req.params.id)) ?? false;
    if (!rejected) return void res.status(404).json({ error: "no such review" });
    res.json({ ok: true, rejected: `dream/${req.params.id}` });
  });

  return router;
}
