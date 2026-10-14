import matter from "gray-matter";
import type { ConceptFrontmatter } from "./types.js";

export interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Permissive parse (spec §9: consumers must not reject unknown keys/types).
 * Throws only if the YAML itself is unparseable.
 */
export function parseDoc(raw: string): ParsedDoc {
  const parsed = matter(raw);
  return { frontmatter: parsed.data ?? {}, body: parsed.content.replace(/^\n/, "") };
}

export function serializeDoc(frontmatter: ConceptFrontmatter, body: string): string {
  return matter.stringify(body.endsWith("\n") ? body : body + "\n", frontmatter);
}

export function hasNonEmptyType(frontmatter: Record<string, unknown>): boolean {
  return typeof frontmatter.type === "string" && frontmatter.type.trim().length > 0;
}

/**
 * True if the value is a plain object (or contains one inside arrays).
 * Dates count as scalars: js-yaml serializes them as ISO timestamps.
 */
export function containsPlainObject(value: unknown): boolean {
  if (value instanceof Date) return false;
  if (Array.isArray(value)) return value.some(containsPlainObject);
  return typeof value === "object" && value !== null;
}

/**
 * Keys whose values are tool-managed lists of small records (provenance
 * `sources`, supersession `history`). They are written by code that validates
 * and normalizes them, so the plain-object guard below must not reject them.
 */
export const STRUCTURED_KEYS: ReadonlySet<string> = new Set(["sources", "history"]);

/** Top-level frontmatter keys whose values contain plain objects (never serializable as OKF scalars/lists). */
export function findPlainObjectKeys(frontmatter: Record<string, unknown>): string[] {
  return Object.entries(frontmatter)
    .filter(([k, v]) => !STRUCTURED_KEYS.has(k) && containsPlainObject(v))
    .map(([k]) => k);
}
