/**
 * Write journal for bundle transactions.
 *
 * Records the *pre-image* of every file a mutation touches — the bytes that
 * were there before the first write, or `null` if the file did not exist.
 * Only the first touch per path is recorded, so restoring gets you the state
 * as of the start of the transaction regardless of how many times the agent
 * rewrote the same concept mid-run.
 *
 * Deliberately in-memory and per-transaction: a mutation run is bounded by
 * MAX_STEPS, so the number of touched files is small. This is a safety net
 * for "the local model died halfway through", not a version-control system —
 * that's what GIT_AUTOCOMMIT is for.
 */
export class Journal {
  /** bundle path → contents before the transaction (null = did not exist). */
  private readonly preImages = new Map<string, string | null>();

  has(bundlePath: string): boolean {
    return this.preImages.has(bundlePath);
  }

  /** Record a pre-image. No-op if this path was already captured. */
  record(bundlePath: string, contents: string | null): void {
    if (this.preImages.has(bundlePath)) return;
    this.preImages.set(bundlePath, contents);
  }

  get size(): number {
    return this.preImages.size;
  }

  /** Captured paths, sorted for stable reporting. */
  paths(): string[] {
    return [...this.preImages.keys()].sort();
  }

  entries(): { path: string; contents: string | null }[] {
    return this.paths().map((path) => ({ path, contents: this.preImages.get(path) ?? null }));
  }
}
