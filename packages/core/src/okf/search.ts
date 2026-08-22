import type { Bundle } from "./bundle.js";
import type { ConceptFrontmatter, SearchHit } from "./types.js";

export interface SearchOptions {
  type?: string;
  tags?: string[];
  limit?: number;
  /**
   * Restrict the search to one directory subtree (bundle-relative, e.g.
   * "/services"). Narrows the scan itself rather than filtering after the
   * fact, so a scoped search is cheaper as well as more precise.
   */
  directory?: string;
}

/**
 * Does a concept satisfy the type/tags filters?
 *
 * Extracted so hot memory can apply exactly the same predicate as the search
 * scan. If these two drifted, a scoped query could be answered from hot
 * memory by a concept the equivalent search would have excluded — a silent
 * correctness bug, and the reason this lives in one place.
 *
 * Directory is not handled here: the scan narrows by directory up front via
 * listConceptPaths(), and callers filtering a path list check the prefix
 * themselves with inDirectory().
 */
export function matchesFilters(
  frontmatter: ConceptFrontmatter,
  options: Pick<SearchOptions, "type" | "tags">
): boolean {
  if (options.type && frontmatter.type?.toLowerCase() !== options.type.toLowerCase()) {
    return false;
  }
  if (options.tags?.length) {
    const conceptTags = (Array.isArray(frontmatter.tags) ? frontmatter.tags : []).map((t) =>
      String(t).toLowerCase()
    );
    if (!options.tags.every((t) => conceptTags.includes(t.toLowerCase()))) return false;
  }
  return true;
}

/** Is a bundle path inside a directory subtree? Both are bundle-relative. */
export function inDirectory(conceptPath: string, directory: string | undefined): boolean {
  if (!directory) return true;
  const dir = ("/" + directory.replace(/^\/+/, "").replace(/\/+$/, "")).toLowerCase();
  if (dir === "/") return true;
  return conceptPath.toLowerCase().startsWith(dir + "/");
}

/**
 * Naive in-memory scan over all concepts — fine into the thousands of files.
 * Scores: title match > description/tag match > body match.
 */
export async function searchBundle(
  bundle: Bundle,
  query: string,
  options: SearchOptions = {}
): Promise<SearchHit[]> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  // Narrow the scan up front rather than filtering results: a directory-scoped
  // search reads fewer files, which matters because this is a full scan.
  const paths = await bundle.listConceptPaths(options.directory ?? "/");
  const hits: SearchHit[] = [];

  for (const conceptPath of paths) {
    let concept;
    try {
      concept = await bundle.readConcept(conceptPath);
    } catch {
      continue; // Permissive: skip unreadable files.
    }
    const fm = concept.frontmatter;

    if (!matchesFilters(fm, options)) continue;

    const title = (fm.title ?? "").toString().toLowerCase();
    const description = (fm.description ?? "").toString().toLowerCase();
    const tags = (Array.isArray(fm.tags) ? fm.tags : []).join(" ").toLowerCase();
    const body = concept.body.toLowerCase();
    const pathLower = conceptPath.toLowerCase();

    let score = 0;
    let firstBodyMatch = -1;
    for (const term of terms) {
      if (title.includes(term)) score += 10;
      if (pathLower.includes(term)) score += 6;
      if (description.includes(term)) score += 5;
      if (tags.includes(term)) score += 5;
      const bodyIdx = body.indexOf(term);
      if (bodyIdx !== -1) {
        score += 2;
        if (firstBodyMatch === -1) firstBodyMatch = bodyIdx;
      }
    }
    // Empty query with type/tag filters = browse mode: include everything that passed filters.
    if (terms.length === 0) score = 1;
    if (score === 0) continue;

    hits.push({
      path: conceptPath,
      type: fm.type ?? "unknown",
      title: fm.title as string | undefined,
      description: fm.description as string | undefined,
      snippet:
        firstBodyMatch >= 0
          ? concept.body
              .slice(Math.max(0, firstBodyMatch - 60), firstBodyMatch + 120)
              .replace(/\s+/g, " ")
              .trim()
          : undefined,
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, options.limit ?? 20);
}

/** Distinct `type` values in use across the bundle (fed to the agent's system prompt). */
export async function listTypes(bundle: Bundle): Promise<string[]> {
  const paths = await bundle.listConceptPaths();
  const types = new Set<string>();
  for (const p of paths) {
    try {
      const { frontmatter } = await bundle.readConcept(p);
      if (frontmatter.type) types.add(frontmatter.type);
    } catch {
      // skip
    }
  }
  return [...types].sort();
}
