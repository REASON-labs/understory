/**
 * Per-fact provenance (issue #13): where a concept's knowledge came from.
 *
 * Stored as a `sources` list in concept frontmatter. OKF only requires `type`,
 * so this is a producer-defined key: older bundles without it stay valid, and
 * other OKF tools simply preserve it.
 */
export interface ConceptSource {
  /** What the fact came from: a URL, `trace:<id>` for an understory run, or a bundle path. */
  ref: string;
  /** Optional verbatim excerpt that supports the fact. */
  quote?: string;
  /** Date (YYYY-MM-DD) the source was recorded. */
  at?: string;
}

/** Keep the newest N; a long-lived concept must not grow unbounded frontmatter. */
export const MAX_SOURCES = 50;
const MAX_QUOTE = 300;

/**
 * Permissive coercion of whatever a model or hand-edited file put under
 * `sources`: bare strings become `{ref}`, malformed entries are dropped.
 */
export function normalizeSources(raw: unknown): ConceptSource[] {
  if (!Array.isArray(raw)) return [];
  const out: ConceptSource[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push({ ref: item.trim() });
    } else if (item && typeof item === "object") {
      const { ref, quote, at } = item as Record<string, unknown>;
      if (typeof ref !== "string" || !ref.trim()) continue;
      const s: ConceptSource = { ref: ref.trim() };
      if (typeof quote === "string" && quote.trim()) s.quote = quote.trim().slice(0, MAX_QUOTE);
      if (typeof at === "string" && at.trim()) s.at = at.trim();
      else if (at instanceof Date) s.at = at.toISOString().slice(0, 10);
      out.push(s);
    }
  }
  return out;
}

/**
 * Append `incoming` to `existing`, deduplicating by `ref` (the first entry
 * wins, but gains a quote if it had none) and stamping `at` on new entries.
 */
export function mergeSources(
  existing: unknown,
  incoming: ConceptSource[],
  today: string = new Date().toISOString().slice(0, 10)
): ConceptSource[] {
  const merged = normalizeSources(existing);
  const byRef = new Map(merged.map((s) => [s.ref, s]));
  for (const s of incoming) {
    const seen = byRef.get(s.ref);
    if (seen) {
      if (!seen.quote && s.quote) seen.quote = s.quote;
      continue;
    }
    const added = { ...s, at: s.at ?? today };
    byRef.set(added.ref, added);
    merged.push(added);
  }
  return merged.slice(-MAX_SOURCES);
}
