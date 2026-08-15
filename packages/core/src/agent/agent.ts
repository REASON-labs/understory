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

const MAX_STEPS = 12;

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
}

export interface QueryResult {
  answer: string;
  steps: number;
  traceId: string;
}

export interface MutationResult {
  summary: string;
  filesChanged: string[];
  steps: number;
  traceId: string;
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
    const result = await generateText({
      model: resolved.model,
      system: buildSystemPrompt(ctx),
      prompt: question,
      tools: buildReadTools(kb, recorder, options.scope),
      stopWhen: stepCountIs(MAX_STEPS),
    });
    const trace = recorder.finalize("query", question, result.text, "success", modelChain);
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
  let modelChain: string[] = [];

  const runAgent = async () => {
    const resolved = await resolveAgentModel(options, "mutate");
    modelChain = resolved.modelChain;
    return generateText({
      model: resolved.model,
      system: buildSystemPrompt(ctx),
      prompt: instruction,
      tools: { ...buildReadTools(kb, recorder), ...buildWriteTools(kb, filesChanged, recorder) },
      stopWhen: stepCountIs(MAX_STEPS),
      temperature: 0.2,
    });
  };

  try {
    // The whole agent loop is one transaction: a model that dies at step 7
    // of 12 must not leave the first six writes behind.
    const result = rollbackEnabled() ? await kb.transaction(runAgent) : await runAgent();
    const trace = recorder.finalize("mutation", instruction, result.text, "success", modelChain);
    await traceStore(kb).save(trace);
    return {
      ok: true,
      result: {
        summary: result.text,
        filesChanged: [...filesChanged].sort(),
        steps: result.steps.length,
        traceId: trace.id,
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
    const result = streamText({
      model: resolved.model,
      system: buildSystemPrompt(ctx),
      messages,
      tools: { ...buildReadTools(kb, recorder), ...buildWriteTools(kb, filesChanged, recorder) },
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: options.abortSignal,
      onFinish: async ({ text }) => {
        // Persist only turns that actually touched the bundle.
        if (recorder.steps.length > 0) {
          await traceStore(kb).save(recorder.finalize("chat", input, text, "success", modelChain));
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
