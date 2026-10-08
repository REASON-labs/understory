/**
 * Supersession record (issue #14): what a concept used to say when a fact
 * changed.
 *
 * The body must never assert two contradictory facts, so the old value cannot
 * live there. It goes in a capped `history` frontmatter list instead, which
 * keeps "why did this change?" answerable without digging through git.
 */
export interface Supersession {
  /** Date (YYYY-MM-DD) the change was made. */
  date: string;
  /** The statement that was replaced, kept short. */
  was: string;
  /** Why it changed, if known. */
  reason?: string;
  /** What prompted the change: usually `trace:<id>`. */
  source?: string;
}

/** Keep the newest N; this is a hint trail, not an audit log (git is the log). */
export const MAX_HISTORY = 5;
const MAX_WAS = 200;
const MAX_REASON = 200;

/** Permissive coercion of whatever sits under `history`; malformed entries are dropped. */
export function normalizeHistory(raw: unknown): Supersession[] {
  if (!Array.isArray(raw)) return [];
  const out: Supersession[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { date, was, reason, source } = item as Record<string, unknown>;
    if (typeof was !== "string" || !was.trim()) continue;
    const d =
      typeof date === "string" && date.trim()
        ? date.trim()
        : date instanceof Date
          ? date.toISOString().slice(0, 10)
          : undefined;
    if (!d) continue;
    const entry: Supersession = { date: d, was: was.trim().slice(0, MAX_WAS) };
    if (typeof reason === "string" && reason.trim()) entry.reason = reason.trim().slice(0, MAX_REASON);
    if (typeof source === "string" && source.trim()) entry.source = source.trim();
    out.push(entry);
  }
  return out;
}

/**
 * Append new supersessions to an existing list, newest last, capped at
 * MAX_HISTORY. An entry identical to an existing one (same `was` on the same
 * date) is not repeated, so retrying a run does not stack duplicates.
 */
export function appendHistory(
  existing: unknown,
  incoming: Omit<Supersession, "date">[],
  today: string = new Date().toISOString().slice(0, 10)
): Supersession[] {
  const merged = normalizeHistory(existing);
  for (const i of incoming) {
    const [entry] = normalizeHistory([{ ...i, date: today }]);
    if (!entry) continue;
    if (merged.some((m) => m.date === entry.date && m.was === entry.was)) continue;
    merged.push(entry);
  }
  return merged.slice(-MAX_HISTORY);
}
