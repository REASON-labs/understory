import type { KnowledgeBase } from "../okf/index.js";
import { normalizeSources, type ConceptSource } from "../okf/sources.js";
import { TraceStore, type QueryTrace } from "./trace.js";

/** A source plus, when it points at an understory run, what that run was. */
export interface ExplainedSource extends ConceptSource {
  /** Present for `trace:<id>` refs whose trace file still exists. */
  run?: { kind: QueryTrace["kind"]; input: string; outcome: string; startedAt: string };
}

export interface ExplainedChange {
  date: string;
  summary: string;
  /** Short commit hash; only when the history came from git. */
  commit?: string;
}

export interface ConceptExplanation {
  path: string;
  title?: string;
  type?: string;
  description?: string;
  sources: ExplainedSource[];
  /** Newest first. From git when autocommit is on, otherwise from log.md. */
  changes: ExplainedChange[];
  changesFrom: "git" | "log" | "none";
  links: { outbound: string[]; inbound: string[] };
  /** Plain-language gaps in the evidence, so a caller knows what NOT to trust. */
  notes: string[];
}

const MAX_CHANGES = 20;

/**
 * Deterministic (no LLM) account of why the bundle holds a concept: where it
 * came from, how it has changed, and what it is connected to. Missing
 * evidence is reported, never invented.
 */
export async function explainConcept(
  kb: KnowledgeBase,
  conceptPath: string
): Promise<ConceptExplanation> {
  const canonical = kb.bundle.toBundlePath(conceptPath);
  const concept = await kb.readConcept(canonical);
  const fm = concept.frontmatter;
  const notes: string[] = [];

  // Sources, resolving run citations against the trace store.
  const traces = new Map((await new TraceStore(kb.bundle.root).list()).map((t) => [t.id, t]));
  const sources: ExplainedSource[] = normalizeSources(fm.sources).map((s) => {
    if (!s.ref.startsWith("trace:")) return s;
    const t = traces.get(s.ref.slice("trace:".length));
    return t
      ? { ...s, run: { kind: t.kind, input: t.input, outcome: t.outcome, startedAt: t.startedAt } }
      : s;
  });
  if (sources.length === 0) {
    notes.push("No sources recorded: this concept predates provenance or was edited outside the agent.");
  } else if (sources.every((s) => s.ref.startsWith("trace:"))) {
    notes.push("Only run citations; no external origin (URL, document, person) is recorded.");
  }
  const lostRuns = sources.filter((s) => s.ref.startsWith("trace:") && !s.run).length;
  if (lostRuns > 0) {
    notes.push(`${lostRuns} cited run(s) no longer have a trace file (old traces are pruned).`);
  }

  // Change history: git when available, else the update log.
  let changes: ExplainedChange[] = await kb.history(canonical, MAX_CHANGES);
  let changesFrom: ConceptExplanation["changesFrom"] = changes.length ? "git" : "none";
  if (changes.length === 0) {
    const name = canonical.split("/").pop() ?? canonical;
    changes = (await kb.readLog())
      .filter((e) => e.summary.includes(canonical) || e.summary.includes(`(${name})`))
      .slice(0, MAX_CHANGES)
      .map((e) => ({ date: e.date, summary: `${e.action}: ${e.summary}` }));
    if (changes.length) changesFrom = "log";
  }
  if (changesFrom === "none") notes.push("No change history found (autocommit off and log.md has no entry).");

  const { edges } = await kb.graph();
  const links = {
    outbound: [...new Set(edges.filter((e) => e.source === canonical).map((e) => e.target))].sort(),
    inbound: [...new Set(edges.filter((e) => e.target === canonical).map((e) => e.source))].sort(),
  };

  return {
    path: canonical,
    title: fm.title,
    type: fm.type,
    description: fm.description,
    sources,
    changes,
    changesFrom,
    links,
    notes,
  };
}

/** Plain-text rendering for MCP clients and logs. */
export function formatExplanation(x: ConceptExplanation): string {
  const lines: string[] = [`# ${x.title ?? x.path}`, `${x.path}${x.type ? `  [${x.type}]` : ""}`];
  if (x.description) lines.push(x.description);

  lines.push("", "## Sources");
  if (x.sources.length === 0) lines.push("- (none recorded)");
  for (const s of x.sources) {
    const run = s.run
      ? ` — ${s.run.kind} run (${s.run.outcome}) "${s.run.input}"`
      : "";
    lines.push(`- ${s.ref}${s.at ? ` (${s.at})` : ""}${run}`);
    if (s.quote) lines.push(`  > ${s.quote}`);
  }

  lines.push("", `## Changes (${x.changesFrom})`);
  if (x.changes.length === 0) lines.push("- (none found)");
  for (const c of x.changes) lines.push(`- ${c.date}${c.commit ? ` ${c.commit}` : ""} ${c.summary}`);

  lines.push("", "## Links");
  lines.push(`- links to: ${x.links.outbound.join(", ") || "(none)"}`);
  lines.push(`- linked from: ${x.links.inbound.join(", ") || "(none)"}`);

  if (x.notes.length) {
    lines.push("", "## Caveats", ...x.notes.map((n) => `- ${n}`));
  }
  return lines.join("\n");
}
