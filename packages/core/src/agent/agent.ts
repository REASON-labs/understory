import { generateText, streamText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import type { KnowledgeBase, RollbackReport } from "../okf/index.js";
import {
  createModel,
  resolveFallbackConfig,
  resolveModelConfig,
  type ModelConfig,
} from "../providers/index.js";
import { withFallback } from "../providers/fallback.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { buildReadTools, buildWriteTools, formatTree, type QueryScope } from "./tools.js";
import { TraceRecorder, TraceStore } from "./trace.js";

const DEFAULT_MAX_STEPS = 12;

/**
 * Per-run step cap. A small local model that wanders can hit this; when it does,
 * generateText/streamText just *return* what they have — no throw — so a
 * truncated run was indistinguishable from a real completion (and, for a
 * mutation, its partial writes committed as "success"). Configurable via
 * AGENT_MAX_STEPS, or per-call via AgentOptions.maxSteps (the dreamer passes a
 * higher cap so a long consolidation isn't clipped at the interactive default).
 */
function resolveMaxSteps(
  options: AgentOptions = {},
  env: NodeJS.ProcessEnv = process.env
): number {
  if (typeof options.maxSteps === "number" && options.maxSteps > 0) {
    return Math.floor(options.maxSteps);
  }
  const parsed = env.AGENT_MAX_STEPS ? Number(env.AGENT_MAX_STEPS) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_STEPS;
}

/**
 * Distinguish a step-limit stop from the model choosing to finish. The AI SDK
 * reports finishReason on the aggregate result; when stopWhen fires the model
 * was mid-thought, so finishReason is anything but "stop" and the whole step
 * budget was spent.
 */
function wasTruncated(
  result: { steps: readonly unknown[]; finishReason?: string },
  maxSteps: number
): boolean {
  return result.steps.length >= maxSteps && result.finishReason !== "stop";
}

export interface AgentOptions {
  model?: string;
  /**
   * Caller-imposed retrieval scope, supplied by an MCP client through
   * memory_query. Honoured by runQuery only: a mutation must be able to write
   * anywhere in the bundle, so scoping one would be actively harmful.
   */
  scope?: QueryScope;
  /**
   * Aborts the underlying model call. The chat endpoint wires this to the
   * HTTP request so a client disconnect stops the agent loop instead of
   * letting it keep spending tokens on a stream nobody is reading.
   */
  abortSignal?: AbortSignal;
  /**
   * Per-run step cap override. Falls back to AGENT_MAX_STEPS, then 12. The
   * dreamer sets this higher so a long consolidation isn't clipped at the
   * interactive default.
   */
  maxSteps?: number;
}

export interface QueryResult {
  answer: string;
  steps: number;
  traceId: string;
  /** True if the run hit the step cap rather than the model finishing. */
  truncated: boolean;
}

export interface MutationResult {
  summary: string;
  filesChanged: string[];
  steps: number;
  traceId: string;
  /**
   * True if the run hit the step cap rather than the model finishing. The
   * writes still committed (a step-limit stop doesn't throw, so the transaction
   * saw success) — this flags that the edit may be half-formed.
   */
  truncated: boolean;
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
    }
  /**
   * The run failed AND rollback could not fully restore the bundle, or
   * rollback was disabled via MUTATION_ROLLBACK=false. `filesChanged` are
   * left on disk. This is the case that needs a human.
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

/** Read-only Q&A over the bundle. */
export async function runQuery(
  kb: KnowledgeBase,
  question: string,
  options: AgentOptions = {}
): Promise<QueryResult> {
  const ctx = await promptContext(kb, "query", options.scope);
  const recorder = new TraceRecorder();
  let modelChain: string[] = [];
  try {
    const resolved = await resolveAgentModel(options, "query");
    modelChain = resolved.modelChain;
    const maxSteps = resolveMaxSteps(options);
    const result = await generateText({
      model: resolved.model,
      system: buildSystemPrompt(ctx),
      prompt: question,
      tools: buildReadTools(kb, recorder, options.scope),
      stopWhen: stepCountIs(maxSteps),
    });
    const truncated = wasTruncated(result, maxSteps);
    const trace = recorder.finalize(
      "query",
      question,
      result.text,
      truncated ? "truncated" : "success",
      modelChain
    );
    await traceStore(kb).save(trace);
    return { answer: result.text, steps: result.steps.length, traceId: trace.id, truncated };
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
  let modelChain: string[] = [];
  const maxSteps = resolveMaxSteps(options);

  const runAgent = async () => {
    const resolved = await resolveAgentModel(options, "mutate");
    modelChain = resolved.modelChain;
    return generateText({
      model: resolved.model,
      system: buildSystemPrompt(ctx),
      prompt: instruction,
      tools: { ...buildReadTools(kb, recorder), ...buildWriteTools(kb, filesChanged, recorder) },
      stopWhen: stepCountIs(maxSteps),
      temperature: 0.2,
    });
  };

  try {
    // The whole agent loop is one transaction: a model that dies at step 7
    // of 12 must not leave the first six writes behind.
    const result = rollbackEnabled() ? await kb.transaction(runAgent) : await runAgent();
    // A step-limit stop doesn't throw, so its partial writes commit like any
    // success. We can only tell truncation from completion by the step budget —
    // record it distinctly so a clipped mutation is visible in the trace
    // instead of masquerading as a clean run. (Whether to *roll back* on
    // truncation is a later decision; here we surface, not discard.)
    const truncated = wasTruncated(result, maxSteps);
    const trace = recorder.finalize(
      "mutation",
      instruction,
      result.text,
      truncated ? "truncated" : "success",
      modelChain
    );
    await traceStore(kb).save(trace);
    return {
      ok: true,
      result: {
        summary: result.text,
        filesChanged: [...filesChanged].sort(),
        steps: result.steps.length,
        traceId: trace.id,
        truncated,
      },
    };
  } catch (err) {
    const files = [...filesChanged].sort();
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
    const maxSteps = resolveMaxSteps(options);
    const result = streamText({
      model: resolved.model,
      system: buildSystemPrompt(ctx),
      messages,
      tools: { ...buildReadTools(kb, recorder), ...buildWriteTools(kb, filesChanged, recorder) },
      stopWhen: stepCountIs(maxSteps),
      abortSignal: options.abortSignal,
      onFinish: async ({ text, finishReason, steps }) => {
        // Persist only turns that actually touched the bundle.
        if (recorder.steps.length > 0) {
          const outcome =
            steps.length >= maxSteps && finishReason !== "stop" ? "truncated" : "success";
          await traceStore(kb).save(recorder.finalize("chat", input, text, outcome, modelChain));
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
