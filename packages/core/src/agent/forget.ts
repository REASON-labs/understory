import { runMutation, type MutationOutcome } from "./agent.js";
import { clearHotMemory, recordHotDelete } from "./hot-memory.js";
import { clearQueryCache } from "./query-cache.js";
import { DreamReviews } from "./dream-review.js";
import { TraceStore } from "./trace.js";
import type { KnowledgeBase } from "../okf/index.js";
import { normalizeHistory } from "../okf/history.js";
import { normalizeSources } from "../okf/sources.js";
import { addTombstones } from "../okf/tombstone.js";

/** Neutral text for every log line and commit this feature writes. */
const NEUTRAL = "Removed material at the owner's request.";

export interface ForgetTarget {
  /** Forget everything derived from this source ref (URL, `trace:<id>`, bundle path). */
  source?: string;
  /** Forget one concept, and everything derived from it. */
  path?: string;
}

export interface ForgetPlan {
  /** Refs being retracted: the target plus every concept deleted by the cascade. */
  refs: string[];
  /** Concepts whose only provenance is forgotten: deleted outright. */
  delete: string[];
  /** Concepts mixing forgotten and other provenance, or linking to deleted ones: an agent rewrites them. */
  redact: string[];
  /** Concepts whose prose is untouched but whose `history` trail names a forgotten run. */
  scrubHistory: string[];
  /**
   * Pending dream reviews (dream/<id> branches) that would bring this back if accepted later: they
   * change an affected concept or one citing a forgotten ref. Rejected on apply.
   */
  dreamReviews: string[];
  /** Run traces that cite or touched affected concepts; deleted because they store instruction/answer text. */
  traces: string[];
}

export interface ForgetResult {
  status: "dry_run" | "forgotten" | "aborted";
  plan: ForgetPlan;
  error?: string;
  /** Things a human should check, e.g. a quote still present after redaction. */
  warnings: string[];
}

type Runner = (
  kb: KnowledgeBase,
  instruction: string,
  options?: { maxSteps?: number; deadlineMs?: number | null }
) => Promise<MutationOutcome>;

/**
 * Step cap for the rewrite. The default (12) is sized for one concept; a
 * redaction reads and rewrites several, and a run that hits the cap keeps its
 * partial writes, which is the one outcome forget must not leave unexplained.
 */
function redactionStepCap(concepts: number): number {
  return Math.min(60, Math.max(24, concepts * 8));
}

export async function planForget(kb: KnowledgeBase, target: ForgetTarget): Promise<ForgetPlan> {
  if (!!target.source === !!target.path) {
    throw new Error("Provide exactly one of `source` or `path`.");
  }

  const known = new Map<string, { refs: string[]; history: ReturnType<typeof normalizeHistory> }>();
  for (const p of await kb.bundle.listConceptPaths()) {
    try {
      const c = await kb.readConcept(p);
      known.set(p, {
        refs: normalizeSources(c.frontmatter.sources).map((s) => s.ref),
        history: normalizeHistory(c.frontmatter.history),
      });
    } catch {
      // Unreadable files cannot be cited from; skip.
    }
  }

  const refs = new Set<string>();
  const deleted = new Set<string>();
  if (target.path) {
    const canonical = kb.bundle.toBundlePath(target.path);
    if (!known.has(canonical)) throw new Error(`No such concept: ${canonical}`);
    deleted.add(canonical);
    refs.add(canonical);
  } else {
    refs.add(target.source!.trim());
  }

  // Cascade to a fixpoint: deleting a concept forgets it as a source too, so
  // anything derived solely from it goes next.
  const redactBySource = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [p, info] of known) {
      if (deleted.has(p)) continue;
      const hits = info.refs.filter((r) => refs.has(r));
      if (hits.length === 0) continue;
      // Every agent-written concept also cites the run that wrote it
      // (`trace:<id>`). That records HOW it was written, not an independent
      // origin, so it must not keep a concept alive once every real origin is
      // forgotten. Only a trace-only concept is judged by its trace refs.
      const origins = info.refs.filter((r) => !r.startsWith("trace:"));
      const judged = origins.length > 0 ? origins : info.refs;
      if (judged.every((r) => refs.has(r))) {
        deleted.add(p);
        refs.add(p);
        redactBySource.delete(p);
        changed = true;
      } else {
        redactBySource.add(p);
      }
    }
  }

  // Survivors that link to a deleted concept still mention it.
  const redact = new Set(redactBySource);
  const { edges } = await kb.graph();
  for (const e of edges) {
    if (deleted.has(e.target) && !deleted.has(e.source)) redact.add(e.source);
  }

  const scrubHistory = [...known]
    .filter(([p, info]) => !deleted.has(p) && info.history.some((h) => h.source && refs.has(h.source)))
    .map(([p]) => p);

  const touched = new Set([...deleted, ...redact, ...scrubHistory]);
  const traceIds = new Set([...refs].filter((r) => r.startsWith("trace:")).map((r) => r.slice(6)));
  for (const t of await new TraceStore(kb.bundle.root).list()) {
    if (traceIds.has(t.id) || t.steps.some((s) => s.paths.some((p) => touched.has(p)))) {
      traceIds.add(t.id);
    }
  }

  // Review-mode dreams wait on a git branch holding a full copy from before this
  // forget. Accepting one later would merge derived material back in.
  let dreamReviews: string[] = [];
  try {
    dreamReviews = await new DreamReviews(kb).touching(touched, refs);
  } catch {
    // Not a git repo (autocommit off): there are no review branches.
  }

  return {
    refs: [...refs].sort(),
    dreamReviews: dreamReviews.sort(),
    delete: [...deleted].sort(),
    redact: [...redact].sort(),
    scrubHistory: scrubHistory.filter((p) => !redact.has(p)).sort(),
    traces: [...traceIds].sort(),
  };
}

/**
 * Cascading retraction. Defaults to a dry run; only `dryRun: false` changes
 * anything. Order matters: the agent rewrite happens first, while the
 * evidence of what to rewrite still exists, and is itself transactional, so a
 * failure leaves the bundle exactly as it was and the tombstone unwritten.
 */
export async function runForget(
  kb: KnowledgeBase,
  target: ForgetTarget,
  options: { dryRun?: boolean; runner?: Runner } = {}
): Promise<ForgetResult> {
  const plan = await planForget(kb, target);
  const warnings: string[] = [];
  if (options.dryRun !== false) return { status: "dry_run", plan, warnings };

  const runner: Runner = options.runner ?? ((k, instruction, o) => runMutation(k, instruction, o));
  const refSet = new Set(plan.refs);
  const traceStore = new TraceStore(kb.bundle.root);

  // Phase 1: have the agent rewrite prose that mixes in forgotten material.
  const quotes: string[] = [];
  // The rewrite run cites itself on what it touches; its trace is deleted below, so drop that citation too.
  const dropRefs = new Set(refSet);
  if (plan.redact.length > 0) {
    const lines: string[] = [];
    for (const p of plan.redact) {
      const c = await kb.readConcept(p);
      for (const s of normalizeSources(c.frontmatter.sources)) {
        if (refSet.has(s.ref) && s.quote) quotes.push(s.quote);
      }
      lines.push(`- ${p}`);
    }
    const instruction =
      `REDACTION TASK (owner request). Remove material from the concepts below. Use the write tools.\n\n` +
      `Remove every statement, detail and link in these concepts that came from the forgotten source(s) ` +
      `${plan.refs.map((r) => JSON.stringify(r)).join(", ")}, or that refers to the deleted concept(s) ` +
      `${plan.delete.map((r) => JSON.stringify(r)).join(", ") || "(none)"}.` +
      (quotes.length ? `\nKnown excerpts to remove:\n${quotes.map((q) => `- ${JSON.stringify(q)}`).join("\n")}` : "") +
      `\n\nConcepts to rewrite:\n${lines.join("\n")}\n\n` +
      `Rules: keep everything unrelated. Do NOT restate removed content anywhere (not in log_summary, not in "replaced", ` +
      `not in sources). Set every log_summary to exactly: ${JSON.stringify(NEUTRAL)}. Do not create or delete concepts.`;
    const outcome = await runner(kb, instruction, { maxSteps: redactionStepCap(plan.redact.length), deadlineMs: null });
    // The run's trace stores the instruction (with excerpts): never keep it.
    if (outcome.ok) {
      await traceStore.remove([outcome.result.traceId]);
      dropRefs.add(`trace:${outcome.result.traceId}`);
    } else if ("traceId" in outcome && outcome.traceId) await traceStore.remove([outcome.traceId]);
    if (!outcome.ok) {
      // "partial" means files were changed and kept (the run hit its step
      // limit, or a rollback could not restore everything). Saying "nothing
      // was changed" there would be false, and the caller must know what to
      // review. Re-running is safe: sources are only stripped after a clean
      // rewrite, so the same plan is found again.
      if (outcome.status === "partial") {
        return {
          status: "aborted",
          plan,
          error:
            `Redaction did not finish and may have partly rewritten: ${outcome.filesChanged.join(", ") || "(unknown)"}. ` +
            `Nothing was deleted and nothing was tombstoned. Review those files, then run forget again. ` +
            `Cause: ${outcome.error}`,
          warnings,
        };
      }
      return {
        status: "aborted",
        plan,
        error: `Redaction failed, nothing was changed: ${outcome.error}`,
        warnings,
      };
    }
    for (const p of plan.redact) {
      const body = (await kb.readConcept(p)).body.toLowerCase();
      for (const q of quotes) {
        if (body.includes(q.toLowerCase())) warnings.push(`${p} still contains a known excerpt; review it.`);
      }
    }
  }

  // Phase 2: deterministic removal, atomically.
  try {
    await kb.transaction(async () => {
      for (const p of plan.delete) await kb.deleteConcept(p, NEUTRAL);
      for (const p of [...plan.redact, ...plan.scrubHistory]) {
        const c = await kb.readConcept(p);
        const sources = normalizeSources(c.frontmatter.sources).filter((s) => !dropRefs.has(s.ref));
        const history = normalizeHistory(c.frontmatter.history).filter((h) => !(h.source && dropRefs.has(h.source)));
        await kb.patchConcept(
          p,
          { frontmatter: { sources: sources.length ? sources : null, history: history.length ? history : null } },
          NEUTRAL
        );
      }
    });
  } catch (err) {
    return { status: "aborted", plan, error: `Removal failed and was rolled back: ${(err as Error).message}`, warnings };
  }

  // Housekeeping that lives outside the transaction. Tombstone last: it must
  // only exist once the removal has really happened.
  // A pending dream that predates this forget would undo it when accepted.
  if (plan.dreamReviews.length > 0) {
    const reviews = new DreamReviews(kb);
    for (const id of plan.dreamReviews) await reviews.reject(id).catch(() => false);
  }
  await kb.scrubLog(plan.delete);
  await traceStore.remove(plan.traces);
  for (const p of plan.delete) recordHotDelete(kb, p);
  clearHotMemory(kb);
  clearQueryCache();
  await addTombstones(kb.bundle.root, plan.refs);
  await kb.commitPending(NEUTRAL);

  return { status: "forgotten", plan, warnings };
}

/** Plain-text rendering for MCP clients. */
export function formatForget(r: ForgetResult): string {
  const p = r.plan;
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `  - ${x}`).join("\n") : "  (none)");
  const head =
    r.status === "dry_run"
      ? "DRY RUN — nothing changed. Re-run with dry_run=false to apply."
      : r.status === "forgotten"
        ? "Forgotten."
        : `Aborted: ${r.error}`;
  return [
    head,
    `Delete (all provenance forgotten):\n${list(p.delete)}`,
    `Rewrite (mixed provenance or links to deleted concepts):\n${list(p.redact)}`,
    `Scrub history trail only:\n${list(p.scrubHistory)}`,
    `Pending dream reviews ${r.status === "forgotten" ? "rejected" : "to reject"} (accepting them would undo this):\n${list(p.dreamReviews)}`,
    `Run traces ${r.status === "forgotten" ? "deleted" : "to delete"}: ${p.traces.length}`,
    ...(r.warnings.length ? [`Warnings:\n${list(r.warnings)}`] : []),
    r.status === "forgotten"
      ? "Not erased: git history keeps earlier versions (rewrite it separately if required)."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
