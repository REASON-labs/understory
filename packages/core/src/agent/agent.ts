import { generateText, streamText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import type { KnowledgeBase, RollbackReport, RunScope } from "../okf/index.js";
import {
  createModel,
  resolveFallbackConfig,
  resolveModelConfig,
  type ModelConfig,
} from "../providers/index.js";
import { withFallback } from "../providers/fallback.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { buildReadTools, buildWriteTools, formatTree, type QueryScope } from "./tools.js";
import { TraceRecorder, TraceStore, type TraceUsage } from "./trace.js";
import type { RunInfo } from "./dream-verify.js";
import {
  deadlinePhase,
  deadlineStep,
  laterPhase,
  resolveMutationDeadline,
  type DeadlinePhase,
} from "./deadline.js";
import { parseDuration } from "../util/duration.js";

const DEFAULT_MAX_STEPS = 12;

export interface AgentOptions {
  model?: string;
  /** Cancel the model run when the caller disconnects or explicitly aborts. */
  abortSignal?: AbortSignal;
  /** Total deadline for the model run. Defaults to LLM_TIMEOUT; no deadline when neither is set. */
  timeoutMs?: number;
  /**
   * Caller-imposed retrieval scope, supplied by an MCP client through
   * memory_query. Honoured by runQuery only: a mutation must be able to write
   * anywhere in the bundle, so scoping one would be actively harmful.
   */
  scope?: QueryScope;
  /**
   * Per-run step cap override. Falls back to AGENT_MAX_STEPS, then 12. The
   * dreamer sets this higher so a long consolidation isn't clipped at the
   * interactive default.
   */
  maxSteps?: number;
  /** Mutation only: prefix for every git commit the run makes (the dreamer uses "dream:"). */
  commitPrefix?: string;
  /**
   * Mutation only: a run that changes more concepts than this is rolled back
   * as too broad (issue #20). Unset means no limit.
   */
  maxConceptsChanged?: number;
  /**
   * Mutation only: after the agent finishes, INSIDE the transaction, return the
   * reasons this run must not be kept. Any reason rolls the whole run back
   * (issue #19). Gets the knowledge base the run used (a review dream runs on a
   * worktree) and what the run did to it.
   */
  verifyRun?: (kb: KnowledgeBase, run: RunInfo) => Promise<string[]>;
  /**
   * Mutation only: a run cut off by the step limit is rolled back instead of
   * kept as "partial". For unattended runs: nobody is there to review a
   * half-formed edit.
   */
  rollbackOnStepLimit?: boolean;
  /**
   * Mutation only: concepts this run creates are stamped `derived: true` and
   * cite the concepts they link to (issue #17). For runs whose only job is to
   * synthesize overviews.
   */
  deriveNewConcepts?: boolean;
  /**
   * Mutation only: the time by which the run must be finished (see deadline.ts).
   * Past 65% of it the run may only write; past 90% it gets no tools. undefined
   * means AGENT_MUTATION_DEADLINE; null (or 0) switches the deadline off, which
   * is what unattended runs (dreams, forget) use.
   */
  deadlineMs?: number | null;
}

/** Thrown inside the mutation transaction so an over-budget run rolls back. */
class TooBroadError extends Error {
  constructor(
    readonly changed: string[],
    readonly limit: number
  ) {
    super(
      `Too broad: the run changed ${changed.length} concepts, over the limit of ${limit}.`
    );
    this.name = "TooBroadError";
  }
}

/** Thrown inside the mutation transaction so a step-limited unattended run rolls back. */
class StepLimitRollback extends Error {
  constructor(readonly limit: number) {
    super(`The run used all ${limit} steps and was stopped before it finished; it was rolled back.`);
    this.name = "StepLimitRollback";
  }
}

/** Thrown inside the mutation transaction when verifyRun rejects the run. */
class UnverifiedError extends Error {
  constructor(readonly failures: string[]) {
    super(`Verification failed (${failures.length}): ${failures.join("; ")}`);
    this.name = "UnverifiedError";
  }
}

export interface QueryResult {
  answer: string;
  steps: number;
  traceId: string;
  /** True when the run used every step without reaching an answer; `answer` then says so. */
  stepLimited?: boolean;
}

export interface MutationResult {
  summary: string;
  filesChanged: string[];
  steps: number;
  traceId: string;
  /** Git commits the run made, oldest first. Empty without GIT_AUTOCOMMIT. */
  commits: string[];
}

export type MutationOutcome =
  | { ok: true; result: MutationResult }
  /**
   * The run failed after writing, and every write was undone. The bundle is
   * exactly as it was before the instruction. This is the normal failure
   * mode now that mutations are transactional.
   */
  | {
      ok: false;
      status: "rolled_back";
      filesReverted: string[];
      error: string;
      traceId: string;
      /** Set when the run was rolled back for exceeding maxConceptsChanged. */
      tooBroad?: { changed: string[]; limit: number };
      /** Set when an unattended run was rolled back for hitting the step limit. */
      stepLimited?: { limit: number };
      /** Set when the run was rolled back because verifyRun rejected it. */
      unverified?: string[];
    }
  /**
   * The run left files changed that were not undone: it hit the step limit
   * after writing, or it failed AND rollback could not fully restore the
   * bundle, or rollback was disabled via MUTATION_ROLLBACK=false.
   * `filesChanged` are on disk. This is the case that needs a human.
   */
  | {
      ok: false;
      status: "partial";
      filesChanged: string[];
      filesUnrestored?: string[];
      error: string;
      traceId: string;
    }
  | { ok: false; status: "failed"; error: string };

/** Rollback is on by default; MUTATION_ROLLBACK=false restores the old behaviour. */
function rollbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MUTATION_ROLLBACK !== "false";
}

interface ResolvedAgentModel {
  model: LanguageModel;
  modelChain: string[];
}

async function promptContext(
  kb: KnowledgeBase,
  mode: "query" | "mutate" | "chat",
  scope?: QueryScope
) {
  // A directory-scoped query gets a directory-scoped tree. The full tree goes
  // into the system prompt on every turn, so this is also the cheapest handle
  // we have on prompt size.
  const [types, tree] = await Promise.all([kb.listTypes(), kb.listTree(scope?.directory)]);
  return { existingTypes: types, treeSummary: formatTree(tree), mode };
}

async function resolveAgentModel(
  options: AgentOptions,
  mode: "query" | "mutate" | "chat",
  env: NodeJS.ProcessEnv = process.env
): Promise<ResolvedAgentModel> {
  const primaryConfig = withModelOverride(resolveModelConfig(env), options.model);
  const primary = await createModel(primaryConfig);
  const fallbackConfig = resolveFallbackConfig(env);

  if (!fallbackConfig) {
    return { model: primary, modelChain: [modelLabel(primaryConfig)] };
  }

  const allowFor = resolveAllowFor(env.LLM_FALLBACK_ALLOW_FOR);
  if (allowFor && !allowFor.has(mode)) {
    return { model: primary, modelChain: [modelLabel(primaryConfig)] };
  }

  const fallback = await createModel(fallbackConfig);
  return {
    model: withFallback(primary, fallback, {
      retry429: env.LLM_FALLBACK_RETRY_429 === "true",
    }),
    modelChain: [modelLabel(primaryConfig), modelLabel(fallbackConfig)],
  };
}

function resolveAllowFor(raw: string | undefined): Set<string> | null {
  if (!raw || raw === "*") return null;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function withModelOverride(config: ModelConfig, model: string | undefined): ModelConfig {
  return model ? { ...config, model } : config;
}

// No baseURL here by design: traces persist under <bundle>/.traces/, and a
// published bundle would otherwise leak internal hostnames/IPs/ports.
function modelLabel(config: ModelConfig): string {
  return `${config.format}:${config.model || "auto"}`;
}

function traceStore(kb: KnowledgeBase): TraceStore {
  return new TraceStore(kb.bundle.root);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The configured total deadline for one model run, from LLM_TIMEOUT
 * ("10m", "2h", ...). There is no deadline unless one is configured: healthy
 * runs on local hardware routinely take many minutes, so any default would
 * abort working setups. An unparseable value means no deadline plus a
 * warning, never a silent fallback.
 */
export function resolveLlmTimeout(env: NodeJS.ProcessEnv = process.env): {
  ms: number | null;
  warning?: string;
} {
  const raw = env.LLM_TIMEOUT;
  if (raw === undefined || raw.trim() === "") return { ms: null };
  const ms = parseDuration(raw);
  if (ms === null || ms <= 0) {
    return {
      ms: null,
      warning: `LLM_TIMEOUT="${raw}" is not a positive duration (use e.g. 300s, 10m, 2h) — no deadline applied`,
    };
  }
  return { ms };
}

/**
 * How many model steps one agent run may take, from AGENT_MAX_STEPS. A step
 * is one model call plus the tool calls it asks for. An unusable value means
 * the default plus a warning, never a silent fallback.
 */
export function resolveMaxSteps(env: NodeJS.ProcessEnv = process.env): {
  steps: number;
  warning?: string;
} {
  const raw = env.AGENT_MAX_STEPS;
  if (raw === undefined || raw.trim() === "") return { steps: DEFAULT_MAX_STEPS };
  const steps = Number(raw);
  if (!Number.isInteger(steps) || steps < 1) {
    return {
      steps: DEFAULT_MAX_STEPS,
      warning: `AGENT_MAX_STEPS="${raw}" is not a positive whole number — using ${DEFAULT_MAX_STEPS}`,
    };
  }
  return { steps };
}

/** The step cap for one run: a per-call override (the dreamer's) wins over AGENT_MAX_STEPS. */
function effectiveMaxSteps(options: AgentOptions): number {
  if (typeof options.maxSteps === "number" && options.maxSteps > 0) {
    return Math.floor(options.maxSteps);
  }
  return resolveMaxSteps().steps;
}

/**
 * A run that used every step and whose last step still asked for tools was
 * cut off by the budget. It did not finish, whatever it wrote on the way.
 */
function hitStepLimit(
  result: { steps: ReadonlyArray<unknown>; finishReason: string },
  maxSteps: number
): boolean {
  return result.steps.length >= maxSteps && result.finishReason === "tool-calls";
}

/**
 * Abort signal for a model run: fires when the caller cancels (always
 * honored) or when the configured deadline expires (opt-in). Undefined when
 * neither applies.
 */
export function modelAbortSignal(
  options: AgentOptions,
  env: NodeJS.ProcessEnv = process.env
): AbortSignal | undefined {
  const timeoutMs = options.timeoutMs ?? resolveLlmTimeout(env).ms;
  const signals: AbortSignal[] = [];
  if (options.abortSignal) signals.push(options.abortSignal);
  if (timeoutMs != null) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

/** Sum token usage across the run's steps (issue #15). Undefined when the provider reports none. */
function sumStepsUsage(
  steps: ReadonlyArray<{ usage?: { inputTokens?: number; outputTokens?: number } }>
): TraceUsage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let reported = false;
  for (const step of steps) {
    const u = step.usage;
    if (!u || (u.inputTokens == null && u.outputTokens == null)) continue;
    reported = true;
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
  }
  return reported ? { inputTokens, outputTokens } : undefined;
}

/** Read-only Q&A over the bundle. */
export async function runQuery(
  kb: KnowledgeBase,
  question: string,
  options: AgentOptions = {}
): Promise<QueryResult> {
  const ctx = await promptContext(kb, "query", options.scope);
  const recorder = new TraceRecorder();
  const maxSteps = effectiveMaxSteps(options);
  let modelChain: string[] = [];
  try {
    const resolved = await resolveAgentModel(options, "query");
    modelChain = resolved.modelChain;
    const result = await generateText({
      model: resolved.model,
      abortSignal: modelAbortSignal(options),
      system: buildSystemPrompt(ctx),
      prompt: question,
      tools: buildReadTools(kb, recorder, options.scope),
      stopWhen: stepCountIs(maxSteps),
    });
    if (hitStepLimit(result, maxSteps)) {
      const answer = `The search used all ${maxSteps} steps without reaching an answer. Raise AGENT_MAX_STEPS to let it look further.`;
      const trace = recorder.finalize("query", question, answer, "step-limit", modelChain, sumStepsUsage(result.steps));
      await traceStore(kb).save(trace);
      return { answer, steps: result.steps.length, traceId: trace.id, stepLimited: true };
    }
    const trace = recorder.finalize("query", question, result.text, "success", modelChain, sumStepsUsage(result.steps));
    await traceStore(kb).save(trace);
    return { answer: result.text, steps: result.steps.length, traceId: trace.id };
  } catch (err) {
    const trace = recorder.finalize("query", question, errorMessage(err), "failed", modelChain);
    await traceStore(kb).save(trace);
    throw err;
  }
}

/** Knowledge add/update — full toolset, low temperature. */
export async function runMutation(
  kb: KnowledgeBase,
  instruction: string,
  options: AgentOptions = {}
): Promise<MutationOutcome> {
  const ctx = await promptContext(kb, "mutate");
  const recorder = new TraceRecorder();
  const filesChanged = new Set<string>();
  const maxSteps = effectiveMaxSteps(options);
  let modelChain: string[] = [];
  const scope: RunScope = { commitPrefix: options.commitPrefix, touched: new Set(), commits: [] };
  const limit = options.maxConceptsChanged;
  const startedAt = Date.now();
  const deadlineMs = options.deadlineMs === undefined ? resolveMutationDeadline().ms : options.deadlineMs || null;
  const systemPrompt = buildSystemPrompt(ctx);
  const deadline = { reached: "explore" as DeadlinePhase };

  const runAgent = async () => {
    const resolved = await resolveAgentModel(options, "mutate");
    modelChain = resolved.modelChain;
    const before = options.verifyRun ? new Set(await kb.bundle.listConceptPaths()) : null;
    const tools = {
      ...buildReadTools(kb, recorder),
      ...buildWriteTools(kb, filesChanged, recorder, { deriveNew: options.deriveNewConcepts }),
    };
    const result = await generateText({
      model: resolved.model,
      abortSignal: modelAbortSignal(options),
      system: systemPrompt,
      prompt: instruction,
      tools,
      // With a deadline, walk the run explore -> write -> wrap so it finishes (and
      // stores something) before its caller gives up and aborts it.
      ...(deadlineMs
        ? {
            prepareStep: () => {
              const elapsed = Date.now() - startedAt;
              const phase = deadlinePhase(elapsed, deadlineMs);
              deadline.reached = laterPhase(deadline.reached, phase);
              const wrote = filesChanged.size > 0 || scope.touched.size > 0;
              const step = deadlineStep(phase, wrote, deadlineMs - elapsed, systemPrompt);
              return step as { system?: string; activeTools?: Array<keyof typeof tools> };
            },
          }
        : {}),
      stopWhen: stepCountIs(maxSteps),
      temperature: 0.2,
    });
    // An unattended run that ran out of steps has half-done work in it.
    if (options.rollbackOnStepLimit && hitStepLimit(result, maxSteps)) {
      throw new StepLimitRollback(maxSteps);
    }
    // Checked after the run, inside the transaction, so throwing undoes all
    // of it. Stopping at the limit instead would keep a half-done edit (a
    // split whose hub was never rewritten). Counted from the KB, not the
    // tool tracker, so every concept write is seen.
    if (limit !== undefined && scope.touched.size > limit) {
      throw new TooBroadError([...scope.touched].sort(), limit);
    }
    if (options.verifyRun && before) {
      const existing = new Set(await kb.bundle.listConceptPaths());
      const touched = [...scope.touched].sort();
      const failures = await options.verifyRun(kb, {
        touched,
        created: touched.filter((p) => existing.has(p) && !before.has(p)),
        deleted: touched.filter((p) => !existing.has(p) && before.has(p)),
      });
      if (failures.length > 0) throw new UnverifiedError(failures);
    }
    return result;
  };

  try {
    // The whole agent loop is one transaction: a model that dies at step 7
    // of 12 must not leave the first six writes behind.
    const result = await kb.withRunScope(scope, () =>
      rollbackEnabled() ? kb.transaction(runAgent) : runAgent()
    );
    if (hitStepLimit(result, maxSteps)) {
      // A step-limit stop does not throw, so the transaction commits what was
      // written. Report it as partial so a half-formed edit is not "success".
      // Counted from the KB as well as the tool tracker, like the success path:
      // a write the tracker missed must not turn a partial edit into "failed".
      const files = [...new Set([...filesChanged, ...scope.touched])].sort();
      const message =
        `The run used all ${maxSteps} steps and was stopped before it finished` +
        (files.length > 0 ? "; the files it changed may be incomplete" : " or changed any file") +
        `. Raise AGENT_MAX_STEPS to give it more room.`;
      const trace = recorder.finalize("mutation", instruction, message, "step-limit", modelChain, sumStepsUsage(result.steps));
      await traceStore(kb).save(trace);
      return files.length > 0
        ? { ok: false, status: "partial", filesChanged: files, error: message, traceId: trace.id }
        : { ok: false, status: "failed", error: message };
    }
    // Ran out of time with nothing stored: say so plainly. "Success" with an empty
    // file list would read as if the fact had been saved.
    if (deadline.reached === "wrap" && filesChanged.size === 0 && scope.touched.size === 0) {
      const message =
        `The run reached its ${Math.round((deadlineMs ?? 0) / 1000)}s deadline before storing anything, so nothing was saved. ` +
        `Try again with a narrower instruction, or raise AGENT_MUTATION_DEADLINE if the caller allows more time.`;
      const trace = recorder.finalize("mutation", instruction, message, "failed", modelChain, sumStepsUsage(result.steps));
      await traceStore(kb).save(trace);
      return { ok: false, status: "failed", error: message };
    }
    // A run that wrote nothing AND said nothing is a stalled/flaked model.
    // Writing nothing while explaining why (knowledge already present,
    // nothing genuinely related to link) is a legitimate outcome.
    if (filesChanged.size === 0 && result.text.trim() === "") {
      const message = "Mutation returned an empty response without changing any files.";
      const trace = recorder.finalize("mutation", instruction, message, "failed", modelChain, sumStepsUsage(result.steps));
      await traceStore(kb).save(trace);
      return { ok: false, status: "failed", error: message };
    }
    // A run pushed into its write phase stored what it had, but did less exploring
    // (fewer related concepts read or linked): tell the caller rather than hide it.
    const summary =
      deadline.reached === "explore"
        ? result.text
        : `${result.text}\n\n(Note: this run reached its time limit and was moved to a write-only phase, so it may have linked fewer related concepts than usual.)`;
    const trace = recorder.finalize("mutation", instruction, summary, "success", modelChain, sumStepsUsage(result.steps));
    await traceStore(kb).save(trace);
    return {
      ok: true,
      result: {
        summary,
        filesChanged: [...new Set([...filesChanged, ...scope.touched])].sort(),
        steps: result.steps.length,
        traceId: trace.id,
        commits: scope.commits,
      },
    };
  } catch (err) {
    const files = [...new Set([...filesChanged, ...scope.touched])].sort();
    const message = errorMessage(err);
    const rollback = (err as Error & { rollback?: RollbackReport }).rollback;

    // Key off the journal, not the tool-call tracker: `filesChanged` only
    // counts writes that went through the agent's write tools, while the
    // journal sees every byte that actually changed on disk (index.md and
    // log.md regeneration included).
    const reverted = rollback?.restored ?? [];

    // Clean rollback: the bundle is back to its pre-instruction state.
    if (rollback && rollback.failed.length === 0 && reverted.length > 0) {
      const summary = `Mutation failed and was rolled back (${reverted.length} file(s) restored). Error: ${message}`;
      const trace = recorder.finalize("mutation", instruction, summary, "rolled_back", modelChain);
      await traceStore(kb).save(trace);
      return {
        ok: false,
        status: "rolled_back",
        filesReverted: reverted,
        error: message,
        traceId: trace.id,
        ...(err instanceof TooBroadError ? { tooBroad: { changed: err.changed, limit: err.limit } } : {}),
        ...(err instanceof StepLimitRollback ? { stepLimited: { limit: err.limit } } : {}),
        ...(err instanceof UnverifiedError ? { unverified: err.failures } : {}),
      };
    }

    // Writes happened and could not be (fully) undone — the only case that
    // still needs a human to look at the bundle.
    if (files.length > 0 || (rollback?.failed.length ?? 0) > 0) {
      const unrestored = rollback?.failed ?? files;
      const summary = `Partial mutation: ${unrestored.length} file(s) left changed after a failed rollback. Error: ${message}`;
      const trace = recorder.finalize("mutation", instruction, summary, "partial", modelChain);
      await traceStore(kb).save(trace);
      return {
        ok: false,
        status: "partial",
        filesChanged: files,
        filesUnrestored: unrestored,
        error: message,
        traceId: trace.id,
      };
    }

    const trace = recorder.finalize("mutation", instruction, message, "failed", modelChain);
    await traceStore(kb).save(trace);
    return { ok: false, status: "failed", error: message };
  }
}

/** Interactive chat — full toolset, streaming. Caller converts to a UI stream response. */
export async function streamChat(
  kb: KnowledgeBase,
  messages: ModelMessage[],
  options: AgentOptions = {}
) {
  const ctx = await promptContext(kb, "chat");
  const recorder = new TraceRecorder();
  const filesChanged = new Set<string>();
  const maxSteps = effectiveMaxSteps(options);
  let modelChain: string[] = [];
  // The user turn that started this run, for the trace record.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const input =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : lastUser?.content
          ?.map((part) => (part.type === "text" ? part.text : ""))
          .join(" ")
          .trim() ?? "(chat)";

  try {
    const resolved = await resolveAgentModel(options, "chat");
    modelChain = resolved.modelChain;
    const result = streamText({
      model: resolved.model,
      abortSignal: modelAbortSignal(options),
      system: buildSystemPrompt(ctx),
      messages,
      tools: { ...buildReadTools(kb, recorder), ...buildWriteTools(kb, filesChanged, recorder) },
      stopWhen: stepCountIs(maxSteps),
      onFinish: async ({ text, totalUsage, steps, finishReason }) => {
        // Persist only turns that actually touched the bundle.
        if (recorder.steps.length > 0) {
          const usage =
            totalUsage && (totalUsage.inputTokens != null || totalUsage.outputTokens != null)
              ? { inputTokens: totalUsage.inputTokens ?? 0, outputTokens: totalUsage.outputTokens ?? 0 }
              : undefined;
          const outcome = hitStepLimit({ steps, finishReason }, maxSteps) ? "step-limit" : "success";
          await traceStore(kb).save(recorder.finalize("chat", input, text, outcome, modelChain, usage));
        }
      },
      // Mid-stream failures never reach the caller's try/catch — streamText
      // swallows them into the stream. Without this, a provider dying
      // halfway through a chat turn that already wrote files was recorded
      // as nothing at all.
      onError: async ({ error }) => {
        const outcome = filesChanged.size > 0 ? "partial" : "failed";
        await traceStore(kb)
          .save(recorder.finalize("chat", input, errorMessage(error), outcome, modelChain))
          .catch(() => {});
      },
      onAbort: async () => {
        const outcome = filesChanged.size > 0 ? "partial" : "failed";
        await traceStore(kb)
          .save(recorder.finalize("chat", input, "aborted by client", outcome, modelChain))
          .catch(() => {});
      },
    });
    return { result, filesChanged };
  } catch (err) {
    const outcome = filesChanged.size > 0 ? "partial" : "failed";
    await traceStore(kb).save(recorder.finalize("chat", input, errorMessage(err), outcome, modelChain));
    throw err;
  }
}
