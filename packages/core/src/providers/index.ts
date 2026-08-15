import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

type ResolvedLanguageModel = Extract<LanguageModel, { doGenerate: unknown }>;

export type ApiFormat = "openai" | "anthropic";

export interface ModelConfig {
  baseURL: string;
  apiKey: string;
  format: ApiFormat;
  model: string;
}

/**
 * Legacy env vars removed in this fork. Anyone still setting one of these
 * gets a pointed error instead of silently falling back to a hardcoded
 * hosted endpoint (and, in the ANTHROPIC_API_KEY case, silently spending
 * money at api.anthropic.com).
 */
const REMOVED_ENV_VARS = [
  "LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "LLAMACPP_BASE_URL",
  "LLAMACPP_API_KEY",
  "LOCAL_BASE_URL",
  "LOCAL_API_KEY",
] as const;

/** Ensure the URL ends in /v1 — llama-server serves the OpenAI API there. */
function normalizeV1(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function parseFormat(value: string | undefined, fallback: ApiFormat, envName: string): ApiFormat {
  const format = value ?? fallback;
  if (format !== "openai" && format !== "anthropic") {
    throw new Error(`${envName} must be "openai" or "anthropic"`);
  }
  return format;
}

/**
 * Fail loudly if a removed legacy var is set. Silently ignoring it would be
 * worse than erroring: the operator thinks they configured a model and the
 * process would instead use whatever LLM_API_* happens to be lying around.
 */
function assertNoRemovedEnv(env: NodeJS.ProcessEnv): void {
  const found = REMOVED_ENV_VARS.filter((name) => env[name]);
  if (found.length === 0) return;
  throw new Error(
    `Removed env var${found.length > 1 ? "s" : ""} set: ${found.join(", ")}. ` +
      "The legacy provider config was removed in this fork. Use " +
      "LLM_API_BASE_URL + LLM_API_KEY + LLM_API_FORMAT (openai|anthropic) + LLM_MODEL."
  );
}

export function resolveModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  assertNoRemovedEnv(env);

  if (!env.LLM_API_BASE_URL) {
    throw new Error(
      "No LLM configured. Set LLM_API_BASE_URL + LLM_API_KEY + LLM_API_FORMAT + LLM_MODEL."
    );
  }

  return {
    baseURL: env.LLM_API_BASE_URL,
    apiKey: env.LLM_API_KEY ?? "not-needed",
    format: parseFormat(env.LLM_API_FORMAT, "openai", "LLM_API_FORMAT"),
    model: env.LLM_MODEL ?? "",
  };
}

export function resolveFallbackConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig | null {
  if (!env.LLM_FALLBACK_API_BASE_URL) return null;
  return {
    baseURL: env.LLM_FALLBACK_API_BASE_URL,
    apiKey: env.LLM_FALLBACK_API_KEY ?? "not-needed",
    format: parseFormat(env.LLM_FALLBACK_API_FORMAT, "openai", "LLM_FALLBACK_API_FORMAT"),
    model: env.LLM_FALLBACK_MODEL ?? "",
  };
}

// Any OpenAI-compatible endpoint exposes GET /v1/models.
// Cache discovery per base URL for a short TTL — avoids a discovery
// round-trip on every single agent turn, while still noticing within a
// session that the user swapped which model (e.g. via llama-swap) has
// loaded (a process-lifetime cache would never see that again).
const DISCOVERY_TTL_MS = 60_000;
const discoveryCache = new Map<string, { promise: Promise<string>; expiresAt: number }>();

/**
 * Auto-discover the model id from an OpenAI-compatible /v1/models endpoint.
 * Prefers a model reported as "loaded" (e.g. by llama-swap); falls back to
 * the first listed. Results are cached per URL with a 60s TTL so model
 * swaps are noticed within a session.
 */
export async function discoverLlamaCppModel(baseURL: string): Promise<string> {
  const url = normalizeV1(baseURL);
  const cached = discoveryCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }
  const promise = (async () => {
    const res = await fetch(`${url}/models`);
    if (!res.ok) {
      throw new Error(`Model discovery failed: ${res.status} at ${url}/models`);
    }
    const body = (await res.json()) as {
      data?: { id: string; status?: { value?: string } }[];
    };
    const models = body.data ?? [];
    if (models.length === 0) {
      throw new Error(`No models listed at ${url}/models`);
    }
    const loaded = models.find((m) => m.status?.value === "loaded");
    return (loaded ?? models[0]).id;
  })();
  discoveryCache.set(url, { promise, expiresAt: Date.now() + DISCOVERY_TTL_MS });
  // Don't cache failures — the server may just be starting up.
  promise.catch(() => discoveryCache.delete(url));
  return promise;
}

export async function createModel(cfg: ModelConfig): Promise<ResolvedLanguageModel> {
  let model = cfg.model;
  if (!model) {
    if (cfg.format === "openai") {
      try {
        model = await discoverLlamaCppModel(cfg.baseURL);
      } catch {
        throw new Error("LLM_MODEL is required for this endpoint.");
      }
    } else {
      throw new Error("LLM_MODEL is required for this endpoint.");
    }
  }

  switch (cfg.format) {
    case "anthropic":
      return createAnthropic({ baseURL: cfg.baseURL, apiKey: cfg.apiKey })(model) as ResolvedLanguageModel;
    case "openai":
      return createOpenAICompatible({
        name: "custom",
        baseURL: normalizeV1(cfg.baseURL),
        apiKey: cfg.apiKey,
      })(model) as ResolvedLanguageModel;
  }
}
