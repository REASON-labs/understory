import {
  parseDuration,
  resolveDreamSignals,
  runDream,
  type DreamReport,
  type KnowledgeBase,
} from "@understory/core";

const MIN_INTERVAL_MS = 5 * 60_000;
const MAX_HISTORY = 20;

export interface DreamRunRecord {
  startedAt: string;
  durationMs: number;
  ran: boolean;
  outcome?: DreamReport["outcome"];
  reason?: string;
  summary?: string;
  filesChanged: string[];
  signals: { kind: string; count: number }[];
  suppressed: { kind: string; count: number }[];
  error?: string;
}

export interface DreamStatus {
  enabled: boolean;
  /** Raw DREAM_INTERVAL as configured, for echoing back to the operator. */
  interval: string | null;
  intervalMs: number | null;
  clamped: boolean;
  signals: string[];
  running: boolean;
  nextRunAt: string | null;
  lastRun: DreamRunRecord | null;
  history: DreamRunRecord[];
}

/**
 * In-memory run history. Dreams write traces like any other mutation, but a
 * trace answers "what did this run do" — not "has it been running at all, and
 * how often does it fail". That second question is the one you have while
 * dialing the feature in, and there was no way to ask it.
 *
 * Deliberately not persisted: it describes this process's behaviour, and a
 * stale history read from disk after a restart would be misleading.
 */
const history: DreamRunRecord[] = [];
let state = {
  enabled: false,
  interval: null as string | null,
  intervalMs: null as number | null,
  clamped: false,
  running: false,
  nextRunAt: null as number | null,
};

export function getDreamStatus(): DreamStatus {
  let signals: string[] = [];
  let signalError: string | undefined;
  try {
    signals = [...resolveDreamSignals()].sort();
  } catch (err) {
    signalError = (err as Error).message;
  }
  return {
    enabled: state.enabled,
    interval: state.interval,
    intervalMs: state.intervalMs,
    clamped: state.clamped,
    signals: signalError ? [`(invalid: ${signalError})`] : signals,
    running: state.running,
    nextRunAt: state.nextRunAt ? new Date(state.nextRunAt).toISOString() : null,
    lastRun: history[0] ?? null,
    history: [...history],
  };
}

/** Test hook. */
export function resetDreamState(): void {
  history.length = 0;
  state = {
    enabled: false,
    interval: null,
    intervalMs: null,
    clamped: false,
    running: false,
    nextRunAt: null,
  };
}

function record(entry: DreamRunRecord): void {
  history.unshift(entry);
  while (history.length > MAX_HISTORY) history.pop();
}

/**
 * Background dreamer: runs a consolidation pass every DREAM_INTERVAL
 * (e.g. "6h"). Opt-in — unset means no background token spend. The first
 * run happens one interval after boot, never at startup.
 */
export function startDreamer(kb: KnowledgeBase): void {
  const raw = process.env.DREAM_INTERVAL;
  const interval = parseDuration(raw);
  if (!interval) {
    if (raw) console.error(`[understory] invalid DREAM_INTERVAL "${raw}" — dreaming disabled`);
    else console.log("[understory] dreaming: disabled (set DREAM_INTERVAL, e.g. 6h, to enable)");
    return;
  }

  // Validate the signal config at startup rather than discovering a typo one
  // interval later, when the run silently does less than expected.
  let signals: string[];
  try {
    signals = [...resolveDreamSignals()].sort();
  } catch (err) {
    console.error(`[understory] dreaming disabled: ${(err as Error).message}`);
    return;
  }
  if (signals.length === 0) {
    console.error("[understory] dreaming disabled: DREAM_SIGNALS enables nothing");
    return;
  }

  const every = Math.max(interval, MIN_INTERVAL_MS);
  const clamped = every !== interval;
  console.log(
    `[understory] dreaming: every ${raw}${clamped ? " (clamped to 5m minimum)" : ""} — signals: ${signals.join(", ")}`
  );
  if (!signals.includes("duplicates")) {
    console.log(
      "[understory] dreaming: duplicate-merge is OFF (it is the only signal that deletes; enable with DREAM_SIGNALS=all)"
    );
  }

  state = {
    enabled: true,
    interval: raw ?? null,
    intervalMs: every,
    clamped,
    running: false,
    nextRunAt: Date.now() + every,
  };

  const timer = setInterval(async () => {
    if (state.running) return; // never overlap dreams
    state.running = true;
    const startedAt = new Date();
    const t0 = Date.now();
    try {
      const report = await runDream(kb);
      record({
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - t0,
        ran: report.ran,
        outcome: report.outcome,
        reason: report.reason,
        summary: report.summary,
        filesChanged: report.filesChanged ?? [],
        signals: report.signals?.map((s) => ({ kind: s.kind, count: s.count })) ?? [],
        suppressed: report.suppressed ?? [],
      });

      if (!report.ran) {
        console.log(`[understory] dream skipped: ${report.reason}`);
      } else if (report.outcome === "success") {
        console.log(
          `[understory] dream complete: ${report.filesChanged?.length ?? 0} file(s) changed — ${truncate(report.summary ?? "", 200)}`
        );
      } else {
        // Anything other than success is worth stderr: this ran unattended.
        console.error(
          `[understory] dream ${report.outcome}: ${truncate(report.summary ?? "", 200)}`
        );
      }
    } catch (err) {
      const message = (err as Error).message;
      record({
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - t0,
        ran: false,
        reason: "threw",
        filesChanged: [],
        signals: [],
        suppressed: [],
        error: message,
      });
      console.error(`[understory] dream failed: ${message}`);
    } finally {
      state.running = false;
      state.nextRunAt = Date.now() + every;
    }
  }, every);
  timer.unref(); // never keep the process alive just to dream
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
