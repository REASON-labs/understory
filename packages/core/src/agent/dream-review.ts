import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { KnowledgeBase } from "../okf/knowledge-base.js";
import { pruneEmptyDirs, regenerateIndex } from "../okf/indexer.js";
import { appendLog } from "../okf/logger.js";
import type { LogAction } from "../okf/types.js";

/**
 * Every git commit a dream makes starts with this, so a dream's changes can be
 * listed (`git log --grep '^dream:'`) and reverted as a group.
 */
export const DREAM_COMMIT_PREFIX = "dream:";

/** Review branches live under this ref prefix: dream/<id>. */
export const DREAM_BRANCH_PREFIX = "dream/";

/**
 * How a dream lands (issue #34). `apply` commits straight into the live
 * bundle. `review` runs the dream for real in a separate git worktree and
 * leaves its commits on a dream/<id> branch; nothing the server reads changes
 * until a human accepts it.
 */
export type DreamMode = "apply" | "review";

export function resolveDreamMode(env: NodeJS.ProcessEnv = process.env): DreamMode {
  const raw = env.DREAM_MODE?.trim().toLowerCase();
  if (!raw || raw === "apply") return "apply";
  if (raw === "review") return "review";
  // Same policy as DREAM_SIGNALS: a typo must not silently mean "apply".
  throw new Error(`Unknown DREAM_MODE "${env.DREAM_MODE}". Valid: apply, review.`);
}

export interface DreamReview {
  /** The part after dream/, e.g. "20261014-031255". */
  id: string;
  branch: string;
  createdAt: string;
  /** First line of the review commit: counts and the start of the summary. */
  title: string;
  /** The dream's own summary of what it changed, plus the signals it worked on. */
  summary: string;
  /** Concepts changed relative to where the dream started (generated files excluded). */
  filesChanged: string[];
  /** The live commit the dream started from. */
  base: string;
  /** Commits made to the live bundle since then; nonzero means accept will merge. */
  liveCommitsSince: number;
}

export type AcceptResult =
  | { ok: true; commit: string; filesChanged: string[]; revertCommand: string }
  | { ok: false; reason: "not_found" }
  /** Concepts changed on both sides; nothing was merged and the review is kept. */
  | { ok: false; reason: "conflict"; conflicts: string[] }
  | { ok: false; reason: "error"; message: string };

const ID_PATTERN = /^\d{8}-\d{6}(-\d+)?$/;

/** index.md anywhere and the root log.md are generated: rebuilt on accept, never merged. */
function isGenerated(file: string): boolean {
  return file === "log.md" || file === "index.md" || file.endsWith("/index.md");
}

/** Bundle files that count as "what the dream changed" (traces and generated files excluded). */
function isConceptChange(file: string): boolean {
  return !isGenerated(file) && !file.startsWith(".");
}

/**
 * Pending dream reviews of one memory, and what a human can do with them.
 * Needs GIT_AUTOCOMMIT: the review is a git branch.
 */
export class DreamReviews {
  private readonly git: SimpleGit;

  constructor(private readonly kb: KnowledgeBase) {
    this.git = simpleGit(kb.bundle.root);
  }

  /** Pending reviews, newest first. */
  async list(): Promise<DreamReview[]> {
    const out = await this.git.raw([
      "for-each-ref",
      "--sort=-creatordate",
      "--format=%(refname:short)",
      `refs/heads/${DREAM_BRANCH_PREFIX}`,
    ]);
    const branches = out.split("\n").map((s) => s.trim()).filter(Boolean);
    const reviews: DreamReview[] = [];
    for (const branch of branches) {
      const id = branch.slice(DREAM_BRANCH_PREFIX.length);
      if (!ID_PATTERN.test(id)) continue; // someone else's branch; not ours to show
      reviews.push(await this.describe(id));
    }
    return reviews;
  }

  async get(id: string): Promise<DreamReview | null> {
    return (await this.exists(id)) ? this.describe(id) : null;
  }

  /**
   * Unified diff of the review against where it started. Generated files and
   * traces are left out: they are rebuilt on accept and only add noise here.
   */
  async diff(id: string): Promise<string | null> {
    if (!(await this.exists(id))) return null;
    const branch = DREAM_BRANCH_PREFIX + id;
    const base = await this.mergeBase(branch);
    return this.git.raw([
      "diff",
      `${base}..${branch}`,
      "--",
      ".",
      ":(exclude).traces",
      ":(exclude)log.md",
      ":(exclude,glob)**/index.md",
      ":(exclude)index.md",
    ]);
  }

  /**
   * Merge a review into the live bundle, under the write lock. Concept
   * conflicts (the same concept changed on both sides since the dream
   * started) are refused and leave both sides untouched. Generated files are
   * never merged line by line: log.md keeps the live history plus the dream's
   * entries, and every index.md is regenerated.
   */
  async accept(id: string): Promise<AcceptResult> {
    return this.kb.withWriteLock(async () => {
      if (!(await this.exists(id))) return { ok: false, reason: "not_found" } as const;
      const branch = DREAM_BRANCH_PREFIX + id;

      // Stale stat info (a bind mount, a commit made from the host) makes git
      // refuse to merge or even abort ("not uptodate"); refresh first.
      await this.refreshIndex();
      // A merge left in progress (crash, failed abort) must never be
      // concluded by the commit below: it can hold conflict markers.
      if (await this.mergeInProgress()) await this.abortMerge();

      // Anything uncommitted (a hand edit, new traces) is committed first, as
      // the next mutation would: a merge must not overwrite or mix it in.
      await this.git.add(["-A"]);
      if ((await this.git.raw(["status", "--porcelain"])).trim()) {
        await this.git.commit("update: uncommitted changes before accepting a dream review");
      }

      const base = await this.mergeBase(branch);
      const filesChanged = await this.changedConcepts(base, branch);
      const [baseLog, liveLog, dreamLog] = await Promise.all([
        this.show(base, "log.md"),
        this.show("HEAD", "log.md"),
        this.show(branch, "log.md"),
      ]);

      await this.refreshIndex();
      let mergeError = "";
      try {
        await this.git.raw(["merge", "--no-ff", "--no-commit", branch]);
      } catch (err) {
        // Conflicts are expected (log.md always diverges); inspected below.
        mergeError = (err as Error).message;
      }
      if (!(await this.mergeInProgress())) {
        // Nothing to merge, or git refused outright. Either way nothing changed.
        return {
          ok: false,
          reason: "error",
          message: `git could not merge ${branch}${mergeError ? `: ${mergeError.trim()}` : ""}`,
        } as const;
      }

      const unmerged = (await this.git.raw(["diff", "--name-only", "--diff-filter=U"]))
        .split("\n")
        .filter(Boolean);
      const conflicts = unmerged.filter((f) => !isGenerated(f));
      if (conflicts.length > 0) {
        await this.abortMerge();
        return { ok: false, reason: "conflict", conflicts: conflicts.map((f) => "/" + f) } as const;
      }

      try {
        await this.rebuildGenerated(liveLog, addedLogBullets(baseLog, dreamLog));
        await this.git.add(["-A"]);
        const result = await this.git.commit(
          `${DREAM_COMMIT_PREFIX} accept ${branch} (${filesChanged.length} concept(s))`
        );
        await this.git.raw(["branch", "-D", branch]);
        const commit = result.commit || (await this.git.revparse(["HEAD"])).trim();
        return {
          ok: true,
          commit,
          filesChanged,
          // -m 1: undo the merge relative to the live side.
          revertCommand: `git revert -m 1 --no-edit ${commit}`,
        } as const;
      } catch (err) {
        if (await this.mergeInProgress()) await this.abortMerge();
        return { ok: false, reason: "error", message: (err as Error).message } as const;
      }
    });
  }

  /** Discard a review. Returns false when there is no such review. */
  async reject(id: string): Promise<boolean> {
    if (!(await this.exists(id))) return false;
    await this.git.raw(["branch", "-D", DREAM_BRANCH_PREFIX + id]);
    return true;
  }

  private async exists(id: string): Promise<boolean> {
    return ID_PATTERN.test(id) && refExists(this.git, `refs/heads/${DREAM_BRANCH_PREFIX}${id}`);
  }

  private async describe(id: string): Promise<DreamReview> {
    const branch = DREAM_BRANCH_PREFIX + id;
    const [meta, base] = await Promise.all([
      this.git.raw(["log", "-1", "--format=%aI%x00%s%x00%b", branch]),
      this.mergeBase(branch),
    ]);
    const [createdAt, title, body] = meta.split("\0");
    const [filesChanged, since] = await Promise.all([
      this.changedConcepts(base, branch),
      this.git.raw(["rev-list", "--count", `${base}..HEAD`]),
    ]);
    return {
      id,
      branch,
      createdAt: createdAt.trim(),
      title: title.trim(),
      summary: (body ?? "").trim(),
      filesChanged,
      base,
      liveCommitsSince: Number(since.trim()) || 0,
    };
  }

  private async mergeBase(branch: string): Promise<string> {
    return (await this.git.raw(["merge-base", "HEAD", branch])).trim();
  }

  private async changedConcepts(base: string, branch: string): Promise<string[]> {
    const out = await this.git.raw(["diff", "--name-only", `${base}..${branch}`]);
    return out
      .split("\n")
      .filter(Boolean)
      .filter(isConceptChange)
      .map((f) => "/" + f)
      .sort();
  }

  private async show(rev: string, file: string): Promise<string> {
    try {
      return await this.git.raw(["show", `${rev}:${file}`]);
    } catch {
      return ""; // file absent at that revision
    }
  }

  private mergeInProgress(): Promise<boolean> {
    return refExists(this.git, "MERGE_HEAD");
  }

  private async refreshIndex(): Promise<void> {
    await this.git.raw(["update-index", "-q", "--refresh"]).catch(() => {});
  }

  /**
   * Undo an in-progress merge, escalating until it is gone. `reset --hard
   * HEAD` is safe as the last resort: accept commits everything live before
   * it merges, so HEAD is exactly the pre-merge state. Throws if a merge is
   * somehow still in progress, because the next commit would conclude it.
   */
  private async abortMerge(): Promise<void> {
    await this.refreshIndex();
    for (const args of [["merge", "--abort"], ["reset", "--merge"], ["reset", "--hard", "HEAD"]]) {
      await this.git.raw(args).catch(() => {});
      if (!(await this.mergeInProgress())) return;
    }
    throw new Error("could not abort an in-progress merge in the bundle; resolve it by hand before writing again");
  }

  /** log.md: the live log plus the dream's new entries. index.md: regenerated everywhere. */
  private async rebuildGenerated(liveLog: string, dreamBullets: Bullet[]): Promise<void> {
    const bundle = this.kb.bundle;
    const logPath = path.join(bundle.root, "log.md");
    if (liveLog) await fs.writeFile(logPath, liveLog, "utf-8");
    else await fs.rm(logPath, { force: true });
    // appendLog puts each new bullet on top, so add oldest first.
    for (const b of [...dreamBullets].reverse()) await appendLog(bundle, b.action, b.summary);

    await pruneEmptyDirs(bundle);
    const dirs: string[] = [];
    const walk = async (abs: string) => {
      dirs.push(abs);
      for (const e of await fs.readdir(abs, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith(".")) await walk(path.join(abs, e.name));
      }
    };
    await walk(bundle.root);
    for (const d of dirs) await regenerateIndex(bundle, bundle.toBundlePath(d));
  }
}

interface Bullet {
  action: LogAction;
  summary: string;
}

/** Log bullets present on the dream side but not at the base, newest first (log order). */
export function addedLogBullets(baseLog: string, dreamLog: string): Bullet[] {
  const seen = new Set(baseLog.split("\n").map((l) => l.trim()));
  const out: Bullet[] = [];
  for (const line of dreamLog.split("\n")) {
    const t = line.trim();
    if (seen.has(t)) continue;
    const m = t.match(/^\* \*\*(Creation|Update|Deletion)\*\*: (.*)$/);
    if (m) out.push({ action: m[1] as LogAction, summary: m[2] });
  }
  return out;
}

export interface WorktreeOutcome {
  /** Keep the run's commits as a review branch. */
  keep: boolean;
  /** Review commit subject (prefixed) and body. */
  title: string;
  body: string;
}

/**
 * Run `work` against a throwaway worktree of the live bundle, detached at its
 * current commit. When `work` asks to keep the result, a review commit is
 * added and the result becomes branch dream/<id>; otherwise nothing remains.
 * The branch is created only at the end, so a crash mid-run leaves no
 * half-done review, just a stale worktree that the next run prunes.
 */
export async function runInDreamWorktree(
  kb: KnowledgeBase,
  work: (worktreeKb: KnowledgeBase) => Promise<WorktreeOutcome>
): Promise<{ branch: string | null }> {
  const git = simpleGit(kb.bundle.root);
  await git.raw(["worktree", "prune"]);
  // The worktree is made from HEAD, so the dream must not miss live changes
  // that were never committed (a hand edit, a freshly initialized bundle).
  await kb.commitPending("snapshot before a review dream");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "understory-dream-"));
  const wt = path.join(tmp, "bundle");
  await git.raw(["worktree", "add", "--detach", wt, "HEAD"]);
  const tracesBefore = new Set(await fs.readdir(path.join(wt, ".traces")).catch(() => [] as string[]));
  let branch: string | null = null;
  try {
    const outcome = await work(new KnowledgeBase(wt, { gitAutocommit: true }));
    if (outcome.keep) {
      const wgit = simpleGit(wt);
      await wgit.raw(["commit", "--allow-empty", "-m", outcome.title, "-m", outcome.body]);
      const head = (await wgit.revparse(["HEAD"])).trim();
      branch = await freeBranchName(git);
      await git.raw(["branch", branch, head]);
    }
  } finally {
    // The run's trace was written in the worktree; keep it with the live
    // traces so the run stays visible whether or not it is accepted. Only
    // traces the run created: an older one may have been forgotten since.
    await copyNewTraces(wt, kb.bundle.root, tracesBefore).catch(() => {});
    await git.raw(["worktree", "remove", "--force", wt]).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  return { branch };
}

async function freeBranchName(git: SimpleGit): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  for (let n = 1; ; n++) {
    const name = `${DREAM_BRANCH_PREFIX}${stamp}${n === 1 ? "" : `-${n}`}`;
    if (!(await refExists(git, `refs/heads/${name}`))) return name;
  }
}

/**
 * By output, not exit code: simple-git does not reject when git exits
 * nonzero without stderr, which is exactly what `rev-parse --quiet` does for
 * a missing ref.
 */
async function refExists(git: SimpleGit, ref: string): Promise<boolean> {
  const out = await git.raw(["rev-parse", "--verify", "--quiet", ref]).catch(() => "");
  return out.trim() !== "";
}

async function copyNewTraces(fromRoot: string, toRoot: string, skip: Set<string>): Promise<void> {
  const from = path.join(fromRoot, ".traces");
  const to = path.join(toRoot, ".traces");
  let names: string[];
  try {
    names = await fs.readdir(from);
  } catch {
    return;
  }
  await fs.mkdir(to, { recursive: true });
  for (const name of names.filter((n) => !skip.has(n))) {
    await fs.copyFile(path.join(from, name), path.join(to, name), fs.constants.COPYFILE_EXCL).catch(() => {});
  }
}
