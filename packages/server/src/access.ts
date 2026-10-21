import type { NextFunction, Request, Response } from "express";
import { tokenMatches } from "./auth.js";

/**
 * What a caller may do. `full` is everything; `read` may only look: the three
 * read tools over /mcp and GET requests on /api. It is granted by a second
 * bearer token (AUTH_TOKEN_READONLY) so an agent can be given access to the
 * memory without being able to change or delete it.
 */
export type Access = "full" | "read";

/** The MCP tools that never change the bundle. Everything else needs `full`. */
export const READ_TOOLS: ReadonlySet<string> = new Set(["memory_query", "memory_status", "memory_explain"]);

export const isReadTool = (name: string): boolean => READ_TOOLS.has(name);

export interface AuthConfig {
  /** Full-access token; undefined means the server is open. */
  full?: string;
  /** Read-only token; only valid together with `full`. */
  readOnly?: string;
}

/**
 * Read the token settings from the environment, refusing combinations that
 * would quietly leave the memory open or make the two tokens ambiguous.
 */
export function resolveAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const full = env.AUTH_TOKEN?.trim() || undefined;
  const readOnly = env.AUTH_TOKEN_READONLY?.trim() || undefined;
  if (!full && env.AUTH_REQUIRED === "true") {
    throw new Error("AUTH_REQUIRED=true but AUTH_TOKEN is unset — refusing to start open.");
  }
  if (readOnly && !full) {
    // With no full token the server is open, so every caller already has write
    // access: a read-only token would protect nothing.
    throw new Error(
      "AUTH_TOKEN_READONLY is set but AUTH_TOKEN is not — the server would be open to everyone with full access. Set AUTH_TOKEN too."
    );
  }
  if (readOnly && readOnly === full) {
    throw new Error("AUTH_TOKEN_READONLY must differ from AUTH_TOKEN.");
  }
  return { full, readOnly };
}

/** Which access a presented token grants, or null when it grants none. */
export function accessFor(provided: string, config: AuthConfig): Access | null {
  if (!config.full) return "full"; // open server
  if (tokenMatches(provided, config.full)) return "full";
  if (config.readOnly && tokenMatches(provided, config.readOnly)) return "read";
  return null;
}

/** Tool names a JSON-RPC body asks to call (a single request or a batch). */
export function calledTools(body: unknown): string[] {
  const requests = Array.isArray(body) ? body : [body];
  const names: string[] = [];
  for (const r of requests) {
    if (r && typeof r === "object" && (r as { method?: unknown }).method === "tools/call") {
      const name = (r as { params?: { name?: unknown } }).params?.name;
      names.push(typeof name === "string" ? name : "");
    }
  }
  return names;
}

/**
 * /mcp: a read-only caller may not call a write tool. Checked on the request
 * body (including each member of a batch), so it holds however the tool list
 * was filtered, and answers 403 rather than a protocol-level "unknown tool".
 */
export function mcpAccessGuard(req: Request, res: Response, next: NextFunction): void {
  if (res.locals.access !== "read") return next();
  const denied = calledTools(req.body).filter((n) => !isReadTool(n));
  if (denied.length === 0) return next();
  const id = (Array.isArray(req.body) ? req.body[0] : req.body)?.id ?? null;
  res.status(403).json({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32003,
      message: `forbidden: this token is read-only and cannot call ${denied.map((n) => n || "(unnamed)").join(", ")}`,
    },
  });
}

/** /api: a read-only caller may only read. Anything that is not GET/HEAD/OPTIONS is refused. */
export function apiAccessGuard(req: Request, res: Response, next: NextFunction): void {
  if (res.locals.access !== "read") return next();
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  res.status(403).json({ error: "forbidden: this token is read-only", access: "read" });
}
