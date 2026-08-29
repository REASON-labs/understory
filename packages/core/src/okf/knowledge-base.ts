import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { simpleGit, type SimpleGit } from "simple-git";
import { Bundle } from "./bundle.js";
import { Journal } from "./journal.js";
import { pruneEmptyDirs, regenerateIndexChain } from "./indexer.js";
import { appendLog, readLog } from "./logger.js";
import { searchBundle, listTypes, type SearchOptions } from "./search.js";
import { validateBundle } from "./validate.js";
import { lintBundle, type LintReport } from "./lint.js";
import { buildGraph, type GraphData } from "./graph.js";
import type {
  Concept,
  ConceptFrontmatter,
  ConformanceReport,
  LogAction,
  LogEntry,
  SearchHit,
  TreeNode,
} from "./types.js";

export interface KnowledgeBaseOptions {
  /** Commit after each mutation. Requires the bundle to be inside a git repo. */
  gitAutocommit?: boolean;
}

export interface RollbackReport {
  /** Files whose pre-transaction contents were restored. */
  restored: string[];
  /** Files that could NOT be restored — the bundle is inconsistent here. */
  failed: string[];
}

interface TransactionContext {
  journal: Journal;
}

/**
 * The one write-path into the bundle. Spec conformance (index.md, log.md,
 * frontmatter validation, timestamps) is enforced HERE, deterministically —
 * never delegated to the LLM. Mutations are serialized through a queue.
 */
export class KnowledgeBase {
  readonly bundle: Bundle;
  private readonly git: SimpleGit | null;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  /**
   * Exclusive bundle-write lock, held for the duration of a transaction.
   *
   * Necessary, not merely nice: rollback restores by path, so if a dream
   * consolidation and a user mutation interleaved inside one journal window,
   * rolling back the failed run would silently revert the other one's work.
   */
  private writeLock: Promise<void> = Promise.resolve();
  /**
   * Propagates the open transaction to nested writeConcept/patch/delete calls
   * made from agent tools, which are several async frames deep inside the AI
   * SDK and have no way to be handed a transaction object explicitly.
   */
  private readonly txContext = new AsyncLocalStorage<TransactionContext>();

  constructor(bundleRoot: string, private readonly options: KnowledgeBaseOptions = {}) {
    this.bundle = new Bundle(bundleRoot);
    this.git = options.gitAutocommit ? simpleGit(this.bundle.root) : null;
  }

  // ── Reads (no queue) ────────────────────────────────────────────────

  readConcept(conceptPath: string): Promise<Concept> {
    return this.bundle.readConcept(conceptPath);
  }

  listTree(dir?: string): Promise<TreeNode> {
    return this.bundle.listTree(dir ?? "/");
  }

  search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    return searchBundle(this.bundle, query, options);
  }

  listTypes(): Promise<string[]> {
    return listTypes(this.bundle);
  }

  readLog(): Promise<LogEntry[]> {
    return readLog(this.bundle);
  }

  validate(): Promise<ConformanceReport> {
    return validateBundle(this.bundle);
  }

  /** Graph health: orphaned concepts + broken links (deterministic, no LLM). */
  lint(): Promise<LintReport> {
    return lintBundle(this.bundle);
  }

  /** Inter-concept link graph (nodes + edges) for visualization. */
  graph(): Promise<GraphData> {
    return buildGraph(this.bundle);
  }

  // ── Transactions ───────────────────────────────────────────────────

  /**
   * Run `fn` as an all-or-nothing bundle transaction.
   *
   * Every write inside is journalled; if `fn` throws, the bundle is restored
   * to its pre-transaction state and the error is rethrown with a
   * `rollback` report attached. This is the answer to partial mutations: an
   * agent run that dies at step 7 of 12 used to leave the first six writes
   * behind permanently, with no rollback and no way to tell which half of a
   * multi-concept edit landed.
   *
   * Holds the exclusive write lock for the whole run — see `writeLock`.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireWriteLock();
    const journal = new Journal();
    this.bundle.setJournal(journal);
    try {
      return await this.txContext.run({ journal }, fn);
    } catch (err) {
      const report = await this.rollback(journal);
      (err as Error & { rollback?: RollbackReport }).rollback = report;
      throw err;
    } finally {
      this.bundle.setJournal(null);
      release();
    }
  }

  /** True while a transaction is open on this async call path. */
  get inTransaction(): boolean {
    return this.txContext.getStore() !== undefined;
  }

  private async rollback(journal: Journal): Promise<RollbackReport> {
    const entries = journal.entries();
    const failed = await this.bundle.restore(entries);
    const restored = entries.map((e) => e.path).filter((p) => !failed.includes(p));

    if (failed.length > 0) {
      console.error(
        `[understory] ROLLBACK INCOMPLETE — could not restore: ${failed.join(", ")}`
      );
    }

    // Autocommit already committed the intermediate states, so leave the
    // rollback in history too rather than a dirty tree that looks like an
    // uncommitted human edit.
    if (this.git && restored.length > 0) {
      try {
        await this.git.add(".");
        await this.git.commit(
          `revert: roll back failed mutation (${restored.length} file(s))`
        );
      } catch (err) {
        console.error(`[understory] rollback commit failed: ${(err as Error).message}`);
      }
    }

    return { restored, failed };
  }

  private acquireWriteLock(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitFor = this.writeLock;
    this.writeLock = waitFor.then(() => held, () => held);
    return waitFor.then(
      () => release,
      () => release
    );
  }

  // ── Mutations (serialized; auto index + log + optional commit) ──────

  writeConcept(
    conceptPath: string,
    frontmatter: ConceptFrontmatter,
    body: string,
    logSummary: string
  ): Promise<Concept> {
    return this.enqueue(async () => {
      const existed = await this.bundle.exists(conceptPath);
      const concept = await this.bundle.writeConcept(conceptPath, frontmatter, body);
      await this.afterMutation(concept.path, existed ? "Update" : "Creation", logSummary);
      return concept;
    });
  }

  patchConcept(
    conceptPath: string,
    changes: Parameters<Bundle["patchConcept"]>[1],
    logSummary: string
  ): Promise<Concept> {
    return this.enqueue(async () => {
      const concept = await this.bundle.patchConcept(conceptPath, changes);
      await this.afterMutation(concept.path, "Update", logSummary);
      return concept;
    });
  }

  deleteConcept(conceptPath: string, logSummary: string): Promise<void> {
    return this.enqueue(async () => {
      const canonical = this.bundle.toBundlePath(conceptPath);
      await this.bundle.deleteConcept(canonical);
      await this.afterMutation(canonical, "Deletion", logSummary);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // Inside a transaction the exclusive write lock already guarantees
    // serialization. Going through the queue here would deadlock: the queue
    // may be waiting on work that is itself waiting for the lock we hold.
    if (this.txContext.getStore()) return fn();
    // Outside a transaction, still take the write lock: a standalone write
    // must not land in the middle of an open transaction's journal window,
    // or a rollback would revert it along with the failed run.
    const run = async (): Promise<T> => {
      const release = await this.acquireWriteLock();
      try {
        return await fn();
      } finally {
        release();
      }
    };
    const next = this.mutationQueue.then(run, run);
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  private async afterMutation(
    conceptPath: string,
    action: LogAction,
    logSummary: string
  ): Promise<void> {
    // Sweep husks first (dirs holding only their auto-generated index.md) so
    // the reindex below never resurrects a pruned directory. Whole-bundle:
    // cheap at this scale, and it also heals husks from before this feature.
    await pruneEmptyDirs(this.bundle);
    await regenerateIndexChain(this.bundle, path.posix.dirname(conceptPath));
    const linked = `[${conceptPath.split("/").pop()}](${conceptPath})`;
    await appendLog(this.bundle, action, logSummary || `${action} of ${linked}.`);
    if (this.git) {
      try {
        await this.git.add(".");
        await this.git.commit(`${action.toLowerCase()}: ${logSummary || conceptPath}`);
      } catch (err) {
        // Autocommit is best-effort; the KB write itself already succeeded.
        console.error(`[understory] git autocommit failed: ${(err as Error).message}`);
      }
    }
  }
}
