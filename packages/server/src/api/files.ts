import express, { type Router } from "express";
import { createHash } from "node:crypto";
import { BundleError, type ConceptFrontmatter, type KnowledgeBase } from "@understory/core";

/**
 * Exact file API (opt-in: FILE_API=true). Deterministic, no model: a caller that
 * already knows the path and the content can create, replace or delete one
 * concept, and read it back with a content hash for optimistic concurrency.
 *
 *   GET    /api/file?path=/a/b.md            -> { path, frontmatter, body, raw, hash }
 *   PUT    /api/file  { path, frontmatter, body, mode, ifMatch?, summary? }
 *                                            -> { path, hash, created }
 *   DELETE /api/file?path=/a/b.md&ifMatch=<hash>
 *
 * mode: "create" refuses if the file exists (409); "replace" refuses if it doesn't
 * (404); "upsert" does either. ifMatch (the hash from GET) makes a write or delete
 * refuse with 409 when the file changed since it was read.
 *
 * Writes go through KnowledgeBase.writeConcept / deleteConcept, so they hold the
 * bundle write lock, regenerate indexes, append to log.md and autocommit to git,
 * exactly like the agent's own write tools. A read-only token can GET but not
 * write (apiAccessGuard). Paths are stricter than the agent's: every segment must
 * start with a letter or digit, so .git/, .traces/ and other dot-folders are out
 * of reach.
 */

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_PATH = 200;
const MODES = new Set(["create", "replace", "upsert"]);

export const hashOf = (raw: string): string => createHash("sha256").update(raw, "utf-8").digest("hex");

class FileApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/** Canonical "/a/b.md", or a FileApiError(400) explaining why the path is refused. */
export function checkFilePath(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw new FileApiError(400, "path is required");
  const p = "/" + input.trim().replace(/^\/+/, "");
  if (p.length > MAX_PATH) throw new FileApiError(400, `path is longer than ${MAX_PATH} characters`);
  if (!p.endsWith(".md")) throw new FileApiError(400, "path must end in .md");
  const segments = p.slice(1).split("/");
  for (const s of segments) {
    if (!SEGMENT.test(s) || s === "..") {
      throw new FileApiError(400, `path segment "${s}" is not allowed (letters, digits, . _ - only; no leading dot)`);
    }
  }
  return p;
}

function statusOf(err: unknown): number {
  if (err instanceof FileApiError) return err.status;
  if (err instanceof BundleError) return err.code === "NOT_FOUND" ? 404 : 400;
  return 500;
}

export function filesRouter(kb: KnowledgeBase): Router {
  const router = express.Router();

  const current = async (p: string): Promise<{ raw: string; hash: string } | null> => {
    if (!(await kb.bundle.exists(p))) return null;
    const c = await kb.readConcept(p);
    return { raw: c.raw, hash: hashOf(c.raw) };
  };

  const fail = (res: express.Response, err: unknown) => {
    const status = statusOf(err);
    if (status >= 500) console.error("[understory] file api:", (err as Error).message);
    res.status(status).json({ error: status >= 500 ? "internal server error" : (err as Error).message });
  };

  router.get("/file", async (req, res) => {
    try {
      const p = checkFilePath(req.query.path);
      const c = await kb.readConcept(p);
      res.json({ path: c.path, frontmatter: c.frontmatter, body: c.body, raw: c.raw, hash: hashOf(c.raw) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put("/file", async (req, res) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const p = checkFilePath(b.path);
      const mode = typeof b.mode === "string" ? b.mode : "";
      if (!MODES.has(mode)) throw new FileApiError(400, 'mode must be "create", "replace" or "upsert"');
      const fm = b.frontmatter;
      if (!fm || typeof fm !== "object" || Array.isArray(fm)) throw new FileApiError(400, "frontmatter must be an object");
      if (typeof b.body !== "string") throw new FileApiError(400, "body must be a string");
      if (b.ifMatch !== undefined && typeof b.ifMatch !== "string") throw new FileApiError(400, "ifMatch must be a string");
      const summary = typeof b.summary === "string" ? b.summary.replace(/\s+/g, " ").trim().slice(0, 200) : "";
      // The bundle stamps its own timestamp on every write.
      const { timestamp: _ignored, ...frontmatter } = fm as Record<string, unknown>;

      const result = await kb.transaction(async () => {
        const before = await current(p);
        if (mode === "create" && before) throw new FileApiError(409, `${p} already exists`);
        if (mode === "replace" && !before) throw new FileApiError(404, `${p} does not exist`);
        if (b.ifMatch !== undefined && before?.hash !== b.ifMatch) {
          throw new FileApiError(409, `${p} changed since it was read`);
        }
        const c = await kb.writeConcept(
          p,
          frontmatter as ConceptFrontmatter,
          b.body as string,
          summary || `${before ? "Replaced" : "Created"} [${p.split("/").pop()}](${p}) via the file API.`
        );
        return { path: c.path, hash: hashOf(c.raw), created: !before };
      });
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete("/file", async (req, res) => {
    try {
      const p = checkFilePath(req.query.path);
      const ifMatch = typeof req.query.ifMatch === "string" ? req.query.ifMatch : undefined;
      await kb.transaction(async () => {
        const before = await current(p);
        if (!before) throw new FileApiError(404, `${p} does not exist`);
        if (ifMatch !== undefined && before.hash !== ifMatch) throw new FileApiError(409, `${p} changed since it was read`);
        await kb.deleteConcept(p, `Deleted [${p.split("/").pop()}](${p}) via the file API.`);
      });
      res.json({ path: p, deleted: true });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
