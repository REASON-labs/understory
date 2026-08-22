import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { KnowledgeBase, resolveFallbackConfig, resolveModelConfig } from "@understory/core";
import { mcpRouter } from "./mcp/http.js";
import { browseRouter } from "./api/browse.js";
import { chatRouter } from "./api/chat.js";
import { healthRouter } from "./api/health.js";
import { dreamRouter } from "./api/dream.js";
import { bearerAuth } from "./auth.js";
import { startDreamer } from "./dreamer.js";

const bundleRoot = process.env.BUNDLE_ROOT;
if (!bundleRoot) {
  console.error("BUNDLE_ROOT env var is required");
  process.exit(1);
}

const kb = new KnowledgeBase(bundleRoot, {
  gitAutocommit: process.env.GIT_AUTOCOMMIT !== "false",
});

startDreamer(kb);

const app = express();

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
  console.error("[understory] Set LLM_API_BASE_URL + LLM_API_KEY + LLM_API_FORMAT + LLM_MODEL.");
  process.exit(1);
}

// Reflect the request origin; expose Mcp-Session-Id so browser MCP clients can
// read it back off the initialize response.
app.use(
  cors({
    origin: true,
    exposedHeaders: ["Mcp-Session-Id"],
    allowedHeaders: [
      "Content-Type",
      "Accept",
      "Authorization",
      "Mcp-Session-Id",
      "Mcp-Protocol-Version",
      "Last-Event-ID",
    ],
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  })
);
app.use(express.json({ limit: "4mb" }));

// Mounted before bearerAuth on purpose: container healthchecks can't carry a
// token, and /health exposes nothing sensitive (no baseURLs, no concepts).
app.use(healthRouter(kb, bundleRoot));

// Optional bearer auth (issue #1): protects the memory (/mcp + /api) when
// AUTH_TOKEN is set. Static web UI stays open and prompts for the token.
const authToken = process.env.AUTH_TOKEN;
if (authToken) {
  app.use(["/mcp", "/api"], bearerAuth(authToken));
  console.log("[understory] auth: bearer token required for /mcp and /api");
} else {
  console.log("[understory] auth: disabled (set AUTH_TOKEN to protect /mcp and /api)");
}

app.use("/mcp", mcpRouter(kb));
app.use("/api", browseRouter(kb));
app.use("/api", chatRouter(kb));
app.use("/api", dreamRouter(kb));

// Serve the built web UI in production (single container), with SPA fallback.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/(api|mcp)).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

// JSON error handler. Without this, a malformed body (express.json throwing
// SyntaxError) or an unhandled route error returns an HTML stack trace page to
// an API client. Must be registered last and must take four args for Express
// to recognise it as an error handler.
app.use((err: Error & { status?: number; statusCode?: number }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    // Response already in flight — delegate so Express destroys the socket
    // rather than trying to write a second set of headers.
    next(err);
    return;
  }
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500) console.error("[understory] unhandled error:", err.message);
  res.status(status).json({ error: status >= 500 ? "internal server error" : err.message });
});

const port = Number(process.env.PORT ?? 3800);
app.listen(port, process.env.HOST || "0.0.0.0", () => {
  console.log(`understory serving bundle ${bundleRoot} on :${port} (web + /api + /mcp)`);
});
