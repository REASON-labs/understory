import express, { type Router } from "express";
import { resolveFallbackConfig, resolveModelConfig, type KnowledgeBase } from "@understory/core";

export interface HealthReport {
  status: "ok" | "degraded";
  uptimeSeconds: number;
  bundle: { root: string; reachable: boolean; error?: string };
  model: { primary: string; fallback: string | null };
}

/**
 * Liveness + readiness in one unauthenticated endpoint.
 *
 * Deliberately mounted before bearerAuth: a Docker/compose HEALTHCHECK has no
 * way to carry AUTH_TOKEN, and proxying the check through /api/tree (the old
 * workaround) both required auth and read the whole bundle on every probe.
 *
 * The response is safe to expose unauthenticated: base URLs are omitted from
 * model labels for the same reason traces omit them — a published or
 * port-forwarded instance shouldn't leak internal hostnames. Bundle path is
 * included because it's operator-facing and already visible in startup logs.
 */
export function healthRouter(kb: KnowledgeBase, bundleRoot: string): Router {
  const router = express.Router();
  const startedAt = Date.now();

  router.get("/health", async (_req, res) => {
    const bundle = await probeBundle(kb, bundleRoot);
    const model = describeModels();

    const report: HealthReport = {
      status: bundle.reachable ? "ok" : "degraded",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      bundle,
      model,
    };

    // 503 on degraded so orchestrators restart/depull rather than routing
    // traffic to a server whose bundle mount vanished.
    res.status(report.status === "ok" ? 200 : 503).json(report);
  });

  return router;
}

/**
 * Cheapest possible readiness signal: validate() touches the bundle root
 * without reading every concept, so probing on a short interval stays free
 * even as the bundle grows.
 */
async function probeBundle(
  kb: KnowledgeBase,
  bundleRoot: string
): Promise<HealthReport["bundle"]> {
  try {
    await kb.validate();
    return { root: bundleRoot, reachable: true };
  } catch (err) {
    return { root: bundleRoot, reachable: false, error: (err as Error).message };
  }
}

/** Model labels without baseURL — see the note above about leaking hostnames. */
function describeModels(): HealthReport["model"] {
  const label = (cfg: { format: string; model: string }) =>
    `${cfg.format}:${cfg.model || "auto"}`;
  try {
    const fallback = resolveFallbackConfig();
    return {
      primary: label(resolveModelConfig()),
      fallback: fallback ? label(fallback) : null,
    };
  } catch {
    // Startup already fails closed on bad LLM config; if we somehow get here,
    // don't take the health endpoint down with it.
    return { primary: "unconfigured", fallback: null };
  }
}
