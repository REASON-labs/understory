import type { KnowledgeBase } from "../okf/index.js";
import { normalizeSources } from "../okf/sources.js";
import { forgottenInText, forgottenRefs } from "../okf/tombstone.js";

/** What a mutation run did to the bundle, as seen by the knowledge base (not the model). */
export interface RunInfo {
  /** Concept paths written, patched or deleted during the run. */
  touched: string[];
  /** Touched paths that did not exist when the run started and exist now. */
  created: string[];
  /** Touched paths that existed when the run started and no longer do. */
  deleted: string[];
}

export interface VerifyOptions {
  /** Deleting a concept is only authorized for the `duplicates` signal. */
  allowDelete: boolean;
  /** Broken links that existed before the run ("path\u0000target"); a dream is not blamed for them. */
  baselineBroken: Set<string>;
}

export const brokenKey = (b: { path: string; target: string }) => `${b.path}\u0000${b.target}`;

/** The links already broken before a run, so verification only blames what the run introduced. */
export async function baselineBrokenLinks(kb: KnowledgeBase): Promise<Set<string>> {
  return new Set((await kb.lint()).brokenLinks.map(brokenKey));
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Deterministic checks on an autonomous dream run, made INSIDE its transaction
 * so any failure rolls the whole run back (issue #19). No LLM: every check is
 * something the code can know.
 *
 * - no concept deleted unless duplicate merging was authorized;
 * - nothing written cites or mentions a forgotten source;
 * - the run introduced no new broken link;
 * - a concept marked `derived` cites the concepts it was derived from, those
 *   exist, and any quoted excerpt really appears in the concept it names.
 *
 * Returns human-readable failures; empty means the run may commit.
 */
export async function verifyDreamRun(
  kb: KnowledgeBase,
  run: RunInfo,
  options: VerifyOptions
): Promise<string[]> {
  const failures: string[] = [];
  const root = kb.bundle.root;

  if (!options.allowDelete && run.deleted.length > 0) {
    failures.push(
      `deleted ${run.deleted.join(", ")}: deleting is only authorized when duplicate merging is enabled (DREAM_SIGNALS=all)`
    );
  }

  const existing = new Set(await kb.bundle.listConceptPaths());
  const touched = new Set(run.touched);

  // Any link that was fine before the run and is broken now is the run's doing,
  // wherever it sits. Deleting a concept breaks links in pages the run never
  // opened (upstream issue #56), so this must not be limited to touched pages.
  for (const b of (await kb.lint()).brokenLinks) {
    if (options.baselineBroken.has(brokenKey(b))) continue;
    const removed = run.deleted.includes(b.target);
    failures.push(
      `${b.path}: now links to ${b.target}, which does not exist` +
        (removed && !touched.has(b.path) ? " (the run deleted it but did not fix this page)" : "")
    );
  }

  for (const p of run.touched.filter((x) => existing.has(x)).sort()) {
    const c = await kb.readConcept(p);
    const sources = normalizeSources(c.frontmatter.sources);
    const refs = sources.map((s) => s.ref);

    if ((await forgottenRefs(root, refs)).length > 0 || (await forgottenInText(root, c.body)).length > 0) {
      failures.push(`${p}: cites or mentions a source that was forgotten`);
    }

    if (c.frontmatter.derived === true) {
      const concepts = refs.filter((r) => r.startsWith("/") && r.endsWith(".md") && r !== p);
      if (concepts.length === 0) failures.push(`${p}: marked derived but cites no concept it was derived from`);
      for (const ref of concepts) {
        if (!existing.has(ref)) failures.push(`${p}: derived from ${ref}, which does not exist`);
      }
      for (const s of sources) {
        if (!s.quote || !existing.has(s.ref)) continue;
        const from = await kb.readConcept(s.ref);
        if (!squash(from.body).includes(squash(s.quote))) {
          failures.push(`${p}: quotes ${s.ref}, but that text is not there`);
        }
      }
    }
  }

  return failures;
}
