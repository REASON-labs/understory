import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Tombstones for forgotten sources (issue #16).
 *
 * Forgetting removes material, but nothing stops the same source from being
 * cited again by a later dream pass or a replayed instruction. The tombstone
 * file records WHAT was forgotten as hashes only, so it can block re-citation
 * without itself retaining the forgotten reference.
 */
const FILE = ".forgotten.json";

export interface TombstoneFile {
  version: 1;
  entries: { hash: string; at: string }[];
}

export function hashRef(ref: string): string {
  return createHash("sha256").update(ref.trim()).digest("hex");
}

async function load(root: string): Promise<TombstoneFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, FILE), "utf-8"));
    if (parsed && Array.isArray(parsed.entries)) return parsed as TombstoneFile;
  } catch {
    // Missing or unreadable: treat as empty rather than blocking writes.
  }
  return { version: 1, entries: [] };
}

export async function addTombstones(root: string, refs: string[]): Promise<void> {
  const file = await load(root);
  const known = new Set(file.entries.map((e) => e.hash));
  const at = new Date().toISOString().slice(0, 10);
  for (const ref of refs) {
    const hash = hashRef(ref);
    if (!known.has(hash)) {
      known.add(hash);
      file.entries.push({ hash, at });
    }
  }
  await fs.writeFile(path.join(root, FILE), JSON.stringify(file, null, 2) + "\n", "utf-8");
}

/** Which of these refs have been forgotten? */
export async function forgottenRefs(root: string, refs: string[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const known = new Set((await load(root)).entries.map((e) => e.hash));
  return refs.filter((r) => known.has(hashRef(r)));
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const PATH_RE = /\/[\w\-./]+\.md\b/g;

/**
 * Forgotten refs mentioned in free text (an incoming memory_add/memory_update).
 * The write-tool guard only fires when a model cites the source; a model that
 * records the same fact without citing it would slip past, so also check the
 * instruction itself. Candidates are URLs and bundle paths, tried with and
 * without trailing punctuation ("…/orion." is how people write them).
 */
export async function forgottenInText(root: string, text: string): Promise<string[]> {
  const candidates = new Set<string>();
  for (const m of [...(text.match(URL_RE) ?? []), ...(text.match(PATH_RE) ?? [])]) {
    candidates.add(m);
    const trimmed = m.replace(/[.,;:!?)\]}]+$/, "");
    if (trimmed) candidates.add(trimmed);
  }
  return forgottenRefs(root, [...candidates]);
}
