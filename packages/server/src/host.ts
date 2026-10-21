import type { NextFunction, Request, Response } from "express";
import type { KnowledgeBase } from "@understory/core";
import { accessFor, type AuthConfig } from "./access.js";
import { bearerToken } from "./auth.js";
import { ProfileError, type ProfileRegistry } from "./profiles.js";

/** The memory a request was resolved to. `profile` is null in single-memory mode. */
export interface ResolvedMemory {
  kb: KnowledgeBase;
  profile: string | null;
}

/**
 * Where requests get their memory from. Two implementations:
 * one fixed bundle (BUNDLE_ROOT), or one bundle per API key (PROFILES_ROOT).
 */
export interface MemoryHost {
  readonly mode: "single" | "profiles";
  /** Authenticate the request and attach its memory as res.locals.memory, or answer 401. */
  authenticate(req: Request, res: Response, next: NextFunction): void;
  /** Every hosted memory, for background work such as dreaming. */
  memories(): Promise<ResolvedMemory[]>;
}

function unauthorized(res: Response, message: string): void {
  // `mode` lets the UI ask for the right kind of key.
  res
    .status(401)
    .set("WWW-Authenticate", 'Bearer realm="understory"')
    .json({ error: message, mode: "profiles" });
}

/**
 * One bundle for everyone. AUTH_TOKEN unset → open (localhost/homelab
 * default); set → requests must carry `Authorization: Bearer <token>`.
 */
export function singleMemoryHost(kb: KnowledgeBase, auth: string | AuthConfig | undefined): MemoryHost {
  const memory: ResolvedMemory = { kb, profile: null };
  const config: AuthConfig = typeof auth === "string" ? { full: auth } : (auth ?? {});
  return {
    mode: "single",
    authenticate(req, res, next) {
      // The token decides both whether the caller is in and what it may do.
      const access = accessFor(bearerToken(req), config);
      if (!access) {
        res
          .status(401)
          .set("WWW-Authenticate", 'Bearer realm="understory"')
          .json({ error: "unauthorized: set Authorization: Bearer <AUTH_TOKEN>", mode: "single" });
        return;
      }
      res.locals.memory = memory;
      res.locals.access = access;
      next();
    },
    async memories() {
      return [memory];
    },
  };
}

/**
 * One bundle per profile. The bearer key is the only selector: it both
 * authenticates the caller and decides which memory they reach, so there is
 * no request parameter that could point one profile at another's data.
 */
export function profileMemoryHost(registry: ProfileRegistry): MemoryHost {
  return {
    mode: "profiles",
    authenticate(req, res, next) {
      registry
        .resolve(bearerToken(req))
        .then((resolved) => {
          if (!resolved) {
            unauthorized(res, "unauthorized: set Authorization: Bearer <profile API key>");
            return;
          }
          res.locals.memory = { kb: resolved.kb, profile: resolved.name } satisfies ResolvedMemory;
          res.locals.access = "full"; // a profile key is full access to its own memory
          next();
        })
        .catch((err: unknown) => {
          // An unreadable registry authenticates nobody.
          console.error(`[understory] ${(err as Error).message}`);
          const status = err instanceof ProfileError ? 503 : 500;
          res.status(status).json({ error: "profile registry unavailable" });
        });
    },
    async memories() {
      return (await registry.memories()).map(({ name, kb }) => ({ kb, profile: name }));
    },
  };
}
