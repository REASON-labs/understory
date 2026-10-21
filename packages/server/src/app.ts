import path from "node:path";
import { existsSync } from "node:fs";
import express, { type Express, type RequestHandler, type Router } from "express";
import cors from "cors";
import type { KnowledgeBase } from "@understory/core";
import { mcpRouter } from "./mcp/http.js";
import { browseRouter } from "./api/browse.js";
import { chatRouter } from "./api/chat.js";
import { dreamRouter } from "./api/dream.js";
import { apiAccessGuard, mcpAccessGuard } from "./access.js";
import type { MemoryHost, ResolvedMemory } from "./host.js";

export interface AppOptions {
  /** Built web UI to serve, when present. */
  webDist?: string;
  /** Profile-management routes, mounted at /admin. */
  admin?: Router;
  /**
   * Unauthenticated liveness route (/health), mounted before auth: container
   * healthchecks cannot carry a token, and it exposes nothing sensitive.
   */
  health?: Router;
}

/**
 * CORS origin policy. `origin: true` reflected any site's Origin header;
 * combined with optional auth, any page the browser visited could call the
 * memory API cross-origin. Default is same-origin only (the bundled web UI is
 * served same-origin, so it needs no config). Set CORS_ORIGINS to a comma list
 * to allow specific browser origins, or CORS_ORIGINS=* to reflect any origin.
 */
export function resolveCorsOrigin(env: NodeJS.ProcessEnv = process.env): cors.CorsOptions["origin"] {
  const raw = env.CORS_ORIGINS?.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  const allow = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return (origin, cb) => {
    // No Origin header = same-origin or a non-browser client (curl, stdio). Allow.
    if (!origin || allow.has(origin)) return cb(null, true);
    cb(new Error(`origin ${origin} not allowed by CORS_ORIGINS`));
  };
}

/**
 * The HTTP application: /mcp and /api are served from whichever memory the
 * host resolves the request to, so the same wiring covers one bundle and
 * many profiles.
 */
export function buildApp(host: MemoryHost, options: AppOptions = {}): Express {
  const app = express();

  // Reflect the request origin; expose Mcp-Session-Id so browser MCP clients can
  // read it back off the initialize response.
  app.use(
    cors({
      origin: resolveCorsOrigin(),
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

  if (options.health) app.use(options.health);

  // Routers close over one KnowledgeBase, so build them once per memory and
  // dispatch each request to the set belonging to the memory it resolved to.
  const routers = new WeakMap<KnowledgeBase, { mcp: Router; api: Router }>();
  const routersFor = (kb: KnowledgeBase) => {
    let set = routers.get(kb);
    if (!set) {
      set = { mcp: mcpRouter(kb), api: express.Router().use(browseRouter(kb)).use(chatRouter(kb)).use(dreamRouter(kb)) };
      routers.set(kb, set);
    }
    return set;
  };
  const memoryOf = (res: express.Response) => res.locals.memory as ResolvedMemory;

  const authenticate: RequestHandler = (req, res, next) => host.authenticate(req, res, next);

  app.use("/mcp", authenticate, mcpAccessGuard, (req, res, next) => routersFor(memoryOf(res).kb).mcp(req, res, next));

  // Which memory this caller is talking to — lets the UI label the profile.
  app.get("/api/profile", authenticate, (_req, res) => {
    res.json({ mode: host.mode, profile: memoryOf(res).profile });
  });
  app.use("/api", authenticate, apiAccessGuard, (req, res, next) => routersFor(memoryOf(res).kb).api(req, res, next));

  if (options.admin) app.use("/admin", options.admin);

  // Serve the built web UI in production (single container), with SPA fallback.
  const webDist = options.webDist;
  if (webDist && existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/(api|mcp|admin)).*/, (_req, res) => {
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  // JSON error handler. Without this, a malformed body (express.json throwing
  // SyntaxError) or an unhandled route error returns an HTML stack trace page to
  // an API client. Must be registered last and must take four args for Express
  // to recognise it as an error handler.
  app.use(
    (
      err: Error & { status?: number; statusCode?: number },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (res.headersSent) {
        // Response already in flight: delegate so Express destroys the socket
        // rather than trying to write a second set of headers.
        next(err);
        return;
      }
      const status = err.status ?? err.statusCode ?? 500;
      if (status >= 500) console.error("[understory] unhandled error:", err.message);
      res.status(status).json({ error: status >= 500 ? "internal server error" : err.message });
    }
  );

  return app;
}
