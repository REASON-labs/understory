import path from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeBase, resolveFallbackConfig, resolveLlmTimeout, resolveMaxSteps, resolveModelConfig, resolveMutationDeadline } from "@understory/core";
import express from "express";
import { adminRouter } from "./admin.js";
import { resolveAuthConfig } from "./access.js";
import { healthRouter } from "./api/health.js";
import { buildApp } from "./app.js";
import { startDreamer } from "./dreamer.js";
import { profileMemoryHost, singleMemoryHost, type MemoryHost } from "./host.js";
import { ProfileRegistry } from "./profiles.js";

// Fork default: on. Every mutation is a git commit, so a wrong write is one revert away.
const gitAutocommit = process.env.GIT_AUTOCOMMIT !== "false";
// PROFILES_ROOT takes precedence: the Docker image always sets BUNDLE_ROOT.
const profilesRoot = process.env.PROFILES_ROOT;
const bundleRoot = process.env.BUNDLE_ROOT;

if (!profilesRoot && !bundleRoot) {
  console.error("BUNDLE_ROOT (one memory) or PROFILES_ROOT (one memory per profile) is required");
  process.exit(1);
}

/** Autocommit must be able to work before a memory serves requests (issue #21). */
async function requireGitReady(kb: KnowledgeBase, label: string): Promise<void> {
  const gitReady = await kb.ensureGitReady();
  if (gitReady.ok && gitReady.note) console.warn(`[understory] WARNING: ${gitReady.note}`);
  if (!gitReady.ok) {
    throw new Error(
      `git autocommit is on (the default; set GIT_AUTOCOMMIT=false to disable) but cannot work for ${label}: ${gitReady.reason}`
    );
  }
}

let host: MemoryHost;
let admin: ReturnType<typeof adminRouter> | undefined;
let serving: string;
let health: express.Router;

try {
  if (profilesRoot) {
    const registry = new ProfileRegistry(profilesRoot, { gitAutocommit });
    const existing = await registry.memories();
    if (gitAutocommit) {
      for (const { name, kb } of existing) await requireGitReady(kb, `profile "${name}"`);
    }
    host = profileMemoryHost(registry);
    // No single bundle to probe in profile mode: liveness only.
    health = express.Router().get("/health", (_req, res) => {
      res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()), mode: "profiles" });
    });
    serving = `${existing.length} profile(s) from ${registry.root}`;
    console.log("[understory] auth: a profile API key is required for /mcp and /api");
    if (process.env.AUTH_TOKEN) {
      console.error("[understory] AUTH_TOKEN is ignored in profile mode — each profile has its own key");
    }
    if (process.env.AUTH_TOKEN_READONLY) {
      console.error("[understory] AUTH_TOKEN_READONLY is ignored in profile mode (read-only profile keys are not supported yet)");
    }

    const adminToken = process.env.ADMIN_TOKEN;
    if (adminToken) {
      admin = adminRouter(registry, adminToken, async (name) => {
        if (!gitAutocommit) return;
        const created = (await registry.memories()).find((m) => m.name === name);
        if (created) await requireGitReady(created.kb, `profile "${name}"`);
      });
      console.log("[understory] admin: profile management enabled at /admin (ADMIN_TOKEN)");
    } else {
      console.log("[understory] admin: /admin disabled (set ADMIN_TOKEN, or manage profiles with the CLI)");
    }
  } else {
    const kb = new KnowledgeBase(bundleRoot!, { gitAutocommit });
    if (gitAutocommit) await requireGitReady(kb, "the bundle");
    const auth = resolveAuthConfig();
    host = singleMemoryHost(kb, auth);
    health = healthRouter(kb, bundleRoot!);
    serving = `bundle ${bundleRoot}`;
    if (auth.full) {
      console.log(
        auth.readOnly
          ? "[understory] auth: bearer token required for /mcp and /api; AUTH_TOKEN_READONLY grants read-only access"
          : "[understory] auth: bearer token required for /mcp and /api"
      );
    } else {
      console.log("[understory] auth: disabled (set AUTH_TOKEN to protect /mcp and /api)");
      const bind = process.env.HOST || "0.0.0.0";
      if (bind === "0.0.0.0" || bind === "::") {
        console.warn(
          "[understory] WARNING: auth is OFF and the server listens on all interfaces. Anyone who can reach this port can read " +
            "and WRITE this memory (memory_add, memory_update, memory_forget). Set AUTH_TOKEN, or restrict who can reach it " +
            "(HOST when running directly; BIND_ADDRESS for the compose port mapping)."
        );
      }
    }
  }
} catch (err) {
  console.error(`[understory] ${(err as Error).message}`);
  process.exit(1);
}

if (gitAutocommit) console.log("[understory] git autocommit: enabled (bundle history is being recorded)");

startDreamer(async () => (await host.memories()).map(({ kb, profile }) => ({ kb, label: profile })));

// Validate LLM config at startup — fail fast with a clear error.
try {
  const primaryConfig = resolveModelConfig();
  console.log(
    `[understory] model: ${primaryConfig.format}:${primaryConfig.model || "auto"} @ ${primaryConfig.baseURL}`
  );
  const fallbackConfig = resolveFallbackConfig();
  if (fallbackConfig) {
    console.log(
      `[understory] fallback: ${fallbackConfig.format}:${fallbackConfig.model || "auto"} @ ${fallbackConfig.baseURL}`
    );
  }
} catch (err) {
  console.error(`[understory] LLM configuration error: ${(err as Error).message}`);
  console.error("[understory] Set LLM_API_BASE_URL + LLM_API_KEY, or configure legacy env vars.");
  process.exit(1);
}

console.log(
  `[understory] cors: ${
    process.env.CORS_ORIGINS?.trim() || "same-origin only (set CORS_ORIGINS to allow browsers)"
  }`
);

const llmTimeout = resolveLlmTimeout();
if (llmTimeout.warning) console.error(`[understory] ${llmTimeout.warning}`);
console.log(`[understory] llm timeout: ${process.env.LLM_TIMEOUT && llmTimeout.ms != null ? process.env.LLM_TIMEOUT.trim() : "none"}`);

const maxSteps = resolveMaxSteps();
if (maxSteps.warning) console.error(`[understory] ${maxSteps.warning}`);
console.log(`[understory] agent max steps: ${maxSteps.steps}`);
const mutationDeadline = resolveMutationDeadline();
if (mutationDeadline.warning) console.error(`[understory] ${mutationDeadline.warning}`);
console.log(`[understory] mutation deadline: ${mutationDeadline.ms ? `${Math.round(mutationDeadline.ms / 1000)}s (write-only from 65%, no tools from 90%)` : "none"}`);

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const app = buildApp(host, { webDist, admin, health });

const port = Number(process.env.PORT ?? 3800);
app.listen(port, process.env.HOST || "0.0.0.0", () => {
  console.log(`understory serving ${serving} on :${port} (web + /api + /mcp)`);
});
