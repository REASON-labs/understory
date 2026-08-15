import type { KnowledgeBase } from "../okf/index.js";
import type { GraphNode } from "../okf/graph.js";
import { runMutation, type AgentOptions } from "./agent.js";

/** The deterministic signals that can trigger a consolidation pass. */
export const DREAM_SIGNAL_KINDS = [
  "orphans",
  "links",
  "duplicates",
  "oversized",
  "insights",
] as const;

export type DreamSignalKind = (typeof DREAM_SIGNAL_KINDS)[number];

/**
 * Default signal set: everything except `duplicates`.
 *
 * Duplicate-merge is the only signal that authorises DELETION, and it fires on
 * title/description string similarity — which is exactly the measure most
 * likely to be wrong. Mutations are transactional and git-committed now, so a
 * bad merge is revertible, but only if someone notices. Opt in with
 * DREAM_SIGNALS once you trust the other signals on your bundle.
 */
export const DEFAULT_DREAM_SIGNALS: DreamSignalKind[] = [
  "orphans",
  "links",
  "oversized",
  "insights",
];

export interface DreamSignal {
  kind: DreamSignalKind;
  /** How many items triggered it — the cheap "is anything pending" number. */
  count: number;
  /** The instruction text this signal contributes to the agent prompt. */
  instruction: string;
}

export interface DreamReport {
  ran: boolean;
  /** Why the dream was skipped (when ran=false). */
  reason?: string;
  summary?: string;
  filesChanged?: string[];
  /** Signals that fired this pass — populated for dry runs too. */
  signals?: DreamSignal[];
  /** Signals suppressed by DREAM_SIGNALS, with their counts. */
  suppressed?: { kind: DreamSignalKind; count: number }[];
  /** Outcome of the underlying mutation, when one ran. */
  outcome?: "success" | "rolled_back" | "partial" | "failed";
}

export interface DreamOptions extends AgentOptions {
  /**
   * Detect signals and build the plan, but do not run the agent. Costs no
   * tokens and writes nothing — the way to see what a scheduled dream would
   * do before, or between, its runs.
   */
  dryRun?: boolean;
}

/**
 * Which signals are enabled. DREAM_SIGNALS is a comma list (or "all"); unset
 * means DEFAULT_DREAM_SIGNALS. DREAM_INSIGHTS=false still removes insights,
 * for backward compatibility with the upstream flag.
 */
export function resolveDreamSignals(env: NodeJS.ProcessEnv = process.env): Set<DreamSignalKind> {
  const raw = env.DREAM_SIGNALS?.trim();
  let enabled: DreamSignalKind[];

  if (!raw) {
    enabled = [...DEFAULT_DREAM_SIGNALS];
  } else if (raw.toLowerCase() === "all") {
    enabled = [...DREAM_SIGNAL_KINDS];
  } else {
    const requested = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const unknown = requested.filter(
      (r) => !DREAM_SIGNAL_KINDS.includes(r as DreamSignalKind)
    );
    if (unknown.length > 0) {
      // Fail loudly rather than silently dreaming with fewer signals than the
      // operator thinks — a typo here is invisible otherwise.
      throw new Error(
        `Unknown DREAM_SIGNALS value(s): ${unknown.join(", ")}. ` +
          `Valid: ${DREAM_SIGNAL_KINDS.join(", ")} (or "all").`
      );
    }
    enabled = requested as DreamSignalKind[];
  }

  if (env.DREAM_INSIGHTS === "false") enabled = enabled.filter((k) => k !== "insights");
  return new Set(enabled);
}

export interface DuplicateCandidate {
  a: string;
  b: string;
  similarity: number;
}

/**
 * Dreaming: an autonomous consolidation pass over the memory — what a brain
 * does during sleep. Deterministic signals decide whether there is anything
 * to dream about (orphans, broken links, likely duplicates, recent activity
 * worth abstracting); the agent then consolidates. No signals → no run, no
 * tokens.
 */
export async function runDream(
  kb: KnowledgeBase,
  options: DreamOptions = {},
  // Injectable for tests.
  runner: typeof runMutation = runMutation
): Promise<DreamReport> {
  const enabled = resolveDreamSignals();
  const { signals, suppressed } = await detectSignals(kb, enabled);

  if (signals.length === 0) {
    const reason =
      suppressed.length > 0
        ? `nothing to consolidate from the enabled signals (${suppressed
            .map((s) => `${s.count} ${s.kind}`)
            .join(", ")} suppressed by DREAM_SIGNALS)`
        : "memory healthy — nothing to consolidate";
    return { ran: false, reason, signals: [], suppressed };
  }

  if (options.dryRun) {
    return {
      ran: false,
      reason: "dry run — no agent invoked, no tokens spent, nothing written",
      signals,
      suppressed,
    };
  }

  const result = await runner(kb, buildDreamInstruction(signals), options);
  return { ran: true, signals, suppressed, ...normalizeMutation(result) };
}

/**
 * Run every deterministic detector, then split the results by whether the
 * signal is enabled. Suppressed signals still report their counts: silently
 * dropping them would hide the cost of having them off.
 */
export async function detectSignals(
  kb: KnowledgeBase,
  enabled: Set<DreamSignalKind> = resolveDreamSignals()
): Promise<{ signals: DreamSignal[]; suppressed: { kind: DreamSignalKind; count: number }[] }> {
  const [lint, graph, log, fat] = await Promise.all([
    kb.lint(),
    kb.graph(),
    kb.readLog(),
    oversizedConcepts(kb),
  ]);
  const dupes = duplicateCandidates(graph.nodes);

  const all: DreamSignal[] = [];

  if (lint.orphans.length > 0) {
    all.push({
      kind: "orphans",
      count: lint.orphans.length,
      instruction:
        `ORPHANED CONCEPTS (nothing links to them). Read each and wire it into genuinely ` +
        `related concepts; if it relates to nothing, leave it alone:\n` +
        lint.orphans.map((o) => `- ${o.path}${o.title ? ` (${o.title})` : ""}`).join("\n"),
    });
  }
  if (lint.brokenLinks.length > 0) {
    all.push({
      kind: "links",
      count: lint.brokenLinks.length,
      instruction:
        `BROKEN LINKS (target missing). Fix the path if the target moved, remove the link if it is gone:\n` +
        lint.brokenLinks.map((b) => `- ${b.path} → ${b.target}`).join("\n"),
    });
  }
  if (dupes.length > 0) {
    all.push({
      kind: "duplicates",
      count: dupes.length,
      instruction:
        `LIKELY DUPLICATES (title/description similarity). Read each pair; if they cover the ` +
        `same thing, merge the content into the better-placed concept, update anything that ` +
        `linked to the removed one, and delete the duplicate (deletion IS authorized for true ` +
        `duplicates after merging). If they are genuinely distinct, cross-link them instead:\n` +
        dupes.map((d) => `- ${d.a} ↔ ${d.b}`).join("\n"),
    });
  }
  if (fat.length > 0) {
    all.push({
      kind: "oversized",
      count: fat.length,
      instruction:
        `OVERSIZED CONCEPTS (grown too large through repeated enrichment). For each: if the ` +
        `body contains genuinely separable topics, extract each into its OWN concept (proper ` +
        `type/title/description, back-linked per the rules), then rewrite the ORIGINAL file ` +
        `as a hub — a short summary that links to every extracted concept. NEVER delete or ` +
        `rename the original path; other concepts link to it. If the content is one ` +
        `indivisible topic, leave it alone:\n` +
        fat.map((f) => `- ${f.path} (${f.chars} chars, ${f.sections} sections)`).join("\n"),
    });
  }
  if (log.length >= 5) {
    all.push({
      kind: "insights",
      count: log.length,
      instruction:
        `CONSOLIDATION (optional). Review the recent activity below. If several concepts now ` +
        `describe one theme that has no overview concept, create ONE overview concept that ` +
        `summarizes and links them (and back-link per the rules). If nothing meaningful ` +
        `emerges, skip this — do not force an insight.\n` +
        log.slice(0, 10).map((e) => `- ${e.date} ${e.action}: ${e.summary}`).join("\n"),
    });
  }

  return {
    signals: all.filter((s) => enabled.has(s.kind)),
    suppressed: all
      .filter((s) => !enabled.has(s.kind))
      .map((s) => ({ kind: s.kind, count: s.count })),
  };
}

export function buildDreamInstruction(signals: DreamSignal[]): string {
  return (
    `DREAM: autonomous memory consolidation (maintenance run, no user waiting).\n\n` +
    signals.map((s) => s.instruction).join("\n\n") +
    `\n\nWork through the applicable items above. Be conservative: prefer small, clearly ` +
    `justified edits over sweeping rewrites. Summarize exactly what changed.`
  );
}

/**
 * PR #5 changes runMutation's return shape from MutationResult to a
 * MutationOutcome union — accept both so this file needs no edits (and no
 * conflicts) whichever lands first.
 */
function normalizeMutation(result: unknown): {
  summary: string;
  filesChanged: string[];
  outcome: DreamReport["outcome"];
} {
  const r = result as Record<string, unknown>;
  if (r && typeof r === "object" && "ok" in r) {
    if (r.ok === true) {
      const inner = r.result as { summary: string; filesChanged: string[] };
      return { summary: inner.summary, filesChanged: inner.filesChanged, outcome: "success" };
    }
    const status = String(r.status ?? "failed") as DreamReport["outcome"];
    // A rolled-back dream is a materially different event from a partial one:
    // the first left the bundle untouched, the second needs a human. Don't
    // flatten them into "failed".
    if (status === "rolled_back") {
      const reverted = Array.isArray(r.filesReverted) ? (r.filesReverted as string[]) : [];
      return {
        summary: `dream failed and was rolled back (${reverted.length} file(s) restored): ${String(r.error ?? "unknown error")}`,
        filesChanged: [],
        outcome: "rolled_back",
      };
    }
    return {
      summary: `dream run ${status}: ${String(r.error ?? "unknown error")}`,
      filesChanged: Array.isArray(r.filesChanged) ? (r.filesChanged as string[]) : [],
      outcome: status,
    };
  }
  const m = r as { summary?: string; filesChanged?: string[] };
  return { summary: m.summary ?? "", filesChanged: m.filesChanged ?? [], outcome: "success" };
}

export interface OversizedConcept {
  path: string;
  chars: number;
  sections: number;
}

const SPLIT_CHARS = 6000;
const SPLIT_SECTIONS = 6;
const MAX_SPLITS_PER_DREAM = 3;

/**
 * Deterministic bloat detection — the counterpart of duplicate detection.
 * Enrich-over-create makes concepts grow forever; flag ones whose body is
 * very long or has sprouted many top-level sections, so the dream can split
 * them hub-and-spoke (original path preserved, so inbound links never break).
 */
export async function oversizedConcepts(kb: KnowledgeBase): Promise<OversizedConcept[]> {
  const paths = await kb.bundle.listConceptPaths();
  const out: OversizedConcept[] = [];
  for (const p of paths) {
    try {
      const c = await kb.readConcept(p);
      const sections = (c.body.match(/^#\s+/gm) ?? []).length;
      if (c.body.length >= SPLIT_CHARS || sections >= SPLIT_SECTIONS) {
        out.push({ path: p, chars: c.body.length, sections });
      }
    } catch {
      // Permissive: unreadable concepts are lint's problem, not the dream's.
    }
  }
  return out.sort((a, b) => b.chars - a.chars).slice(0, MAX_SPLITS_PER_DREAM);
}

/**
 * Deterministic duplicate detection: token-set similarity over title +
 * description. O(n²) — fine at personal-memory scale.
 */
export function duplicateCandidates(nodes: GraphNode[], threshold = 0.65): DuplicateCandidate[] {
  const tokenized = nodes
    .map((n) => ({ path: n.path, tokens: tokens(`${n.title ?? ""} ${n.description ?? ""}`) }))
    .filter((n) => n.tokens.size >= 2);
  const out: DuplicateCandidate[] = [];
  for (let i = 0; i < tokenized.length; i++) {
    for (let j = i + 1; j < tokenized.length; j++) {
      const similarity = jaccard(tokenized[i].tokens, tokenized[j].tokens);
      if (similarity >= threshold) {
        out.push({ a: tokenized[i].path, b: tokenized[j].path, similarity });
      }
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity).slice(0, 5);
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
