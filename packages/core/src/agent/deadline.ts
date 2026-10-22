import { parseDuration } from "../util/duration.js";

/**
 * Deadline-aware mutations.
 *
 * An interactive memory_add / memory_update is usually called by an agent whose
 * own tool call times out after a fixed time (commonly 300 s). A model that keeps
 * searching and reading until then is aborted, the run is rolled back, and the
 * fact is never stored: all that time and tokens for nothing. With a deadline
 * the run is walked through three phases instead, so it finishes in time:
 *
 *   explore  0% .. 65%   everything allowed
 *   write   65% .. 90%   only write_concept / patch_concept, told to stop reading
 *   wrap    90% .. 100%  no tools at all, told to summarize and finish
 *
 * AGENT_MUTATION_DEADLINE is the time by which the run should be COMPLETELY
 * finished (set it a little under the caller's timeout). Unset means no deadline.
 */
export type DeadlinePhase = "explore" | "write" | "wrap";

export const WRITE_PHASE_AT = 0.65;
export const WRAP_PHASE_AT = 0.9;
/** Below this the phases would start before a single model step can finish. */
export const MIN_DEADLINE_MS = 30_000;

/** Tools a run may still call in the write phase. Deleting is never forced by a clock. */
export const DEADLINE_WRITE_TOOLS = ["write_concept", "patch_concept"] as const;

/** AGENT_MUTATION_DEADLINE ("270s", "4m"); a bad value means no deadline plus a warning. */
export function resolveMutationDeadline(env: NodeJS.ProcessEnv = process.env): {
  ms: number | null;
  warning?: string;
} {
  const raw = env.AGENT_MUTATION_DEADLINE;
  if (raw === undefined || raw.trim() === "") return { ms: null };
  const ms = parseDuration(raw);
  if (ms === null || ms <= 0) {
    return {
      ms: null,
      warning: `AGENT_MUTATION_DEADLINE="${raw}" is not a positive duration (use e.g. 270s or 4m) — no deadline applied`,
    };
  }
  if (ms < MIN_DEADLINE_MS) {
    return {
      ms: null,
      warning: `AGENT_MUTATION_DEADLINE="${raw}" is under ${MIN_DEADLINE_MS / 1000}s, too short for a model step to finish — no deadline applied`,
    };
  }
  return { ms };
}

export function deadlinePhase(elapsedMs: number, deadlineMs: number): DeadlinePhase {
  const used = elapsedMs / deadlineMs;
  if (used >= WRAP_PHASE_AT) return "wrap";
  if (used >= WRITE_PHASE_AT) return "write";
  return "explore";
}

const ORDER: Record<DeadlinePhase, number> = { explore: 0, write: 1, wrap: 2 };
/** The later of two phases; a run never moves back to an earlier one. */
export const laterPhase = (a: DeadlinePhase, b: DeadlinePhase): DeadlinePhase => (ORDER[b] > ORDER[a] ? b : a);

/**
 * What to change for the next step. `explore` changes nothing. The original
 * system prompt is kept and the guidance appended, so the rules the agent was
 * given stay in force.
 */
export function deadlineStep(
  phase: DeadlinePhase,
  hasWritten: boolean,
  remainingMs: number,
  originalSystem: string
): { system?: string; activeTools?: string[] } {
  if (phase === "explore") return {};
  const seconds = Math.max(0, Math.round(remainingMs / 1000));
  if (phase === "wrap") {
    return {
      system:
        `${originalSystem}\n\nTIME IS UP (about ${seconds}s left). Do not call any tool. In plain text, say exactly what you ` +
        `changed, or say clearly that nothing was stored. Then finish.`,
      activeTools: [],
    };
  }
  return {
    system:
      `${originalSystem}\n\nTIME LIMIT: about ${seconds}s remain. Stop searching and reading. ` +
      (hasWritten
        ? `Finish any remaining links with patch_concept, then conclude.`
        : `If you know where this belongs, write it now with write_concept or patch_concept. If it truly needs no change, say so and finish.`),
    activeTools: [...DEADLINE_WRITE_TOOLS],
  };
}
