import { useEffect, useState } from "react";
import { api, type AcceptResult, type DreamReview, type DreamStatus } from "../api";

/**
 * Pending dream reviews (DREAM_MODE=review, issue #37): read what a dream
 * would change, then accept it into the live memory or reject it.
 */
export function ReviewsView({
  status,
  onChanged,
  onMemoryChanged,
  onNavigate,
}: {
  status: DreamStatus | null;
  /** Reload the dream status (and the memory) once a review is finished with. */
  onChanged: () => void;
  /** Reload tree, log and graph right after an accept, while its result is still shown. */
  onMemoryChanged: () => void;
  onNavigate: (path: string) => void;
}) {
  if (!status) return <p className="p-6 text-sm text-zinc-500">Loading…</p>;
  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="mb-2 text-2xl font-bold">Dream reviews</h1>
      <ModeLine status={status} />
      {status.reviews.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-500">No pending reviews.</p>
      ) : (
        <div className="mt-6 space-y-6">
          {status.reviews.map((r) => (
            <ReviewCard
              key={r.id}
              review={r}
              onChanged={onChanged}
              onMemoryChanged={onMemoryChanged}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ModeLine({ status }: { status: DreamStatus }) {
  if (!status.enabled) {
    return (
      <p className="text-sm text-zinc-400">
        Dreaming is off. Set <code className="text-zinc-200">DREAM_INTERVAL</code> (e.g. 6h) and{" "}
        <code className="text-zinc-200">DREAM_MODE=review</code> to have dreams wait here for you.
      </p>
    );
  }
  const next = status.nextRunAt ? new Date(status.nextRunAt).toLocaleString() : null;
  return (
    <p className="text-sm text-zinc-400">
      {status.mode === "review" ? (
        <>Review mode is on: dreams wait here and change nothing until you accept them.</>
      ) : (
        <>
          Dreams apply directly (<code className="text-zinc-200">DREAM_MODE={status.mode}</code>). Set{" "}
          <code className="text-zinc-200">DREAM_MODE=review</code> to review them here first.
        </>
      )}{" "}
      Every {status.interval}
      {status.running ? "; a dream is running now." : next ? `; next run ${next}.` : "."}
      {status.mode === "review" && status.reviews.length > 0 && " Dreaming pauses while a review is pending."}
    </p>
  );
}

type Outcome = { kind: "accepted"; result: Extract<AcceptResult, { ok: true }> } | { kind: "error"; text: string; conflicts?: string[] };

function ReviewCard({
  review,
  onChanged,
  onMemoryChanged,
  onNavigate,
}: {
  review: DreamReview;
  onChanged: () => void;
  onMemoryChanged: () => void;
  onNavigate: (path: string) => void;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    api.reviewDiff(review.id).then(setDiff).catch((e) => setDiffError(String(e)));
  }, [review.id]);

  const accept = async () => {
    const n = review.filesChanged.length;
    if (!window.confirm(`Merge this dream into your live memory? It changes ${n} concept(s).`)) return;
    setBusy(true);
    try {
      const result = await api.acceptReview(review.id);
      if (result.ok) {
        setOutcome({ kind: "accepted", result });
        onMemoryChanged();
      } else if (result.reason === "conflict") {
        setOutcome({
          kind: "error",
          text: "Not merged: you changed the same concept(s) since this dream ran. Nothing was changed. Reject it, or merge the branch by hand.",
          conflicts: result.conflicts,
        });
      } else if (result.reason === "forgotten") {
        setOutcome({ kind: "error", text: result.message, conflicts: result.files });
      } else if (result.reason === "not_found") {
        setOutcome({ kind: "error", text: "This review no longer exists." });
        onChanged();
      } else {
        // reason "error", or a server error with some other body shape.
        const r = result as { message?: string; error?: string };
        setOutcome({ kind: "error", text: `Not merged: ${r.message ?? r.error ?? JSON.stringify(result)}` });
      }
    } catch (e) {
      setOutcome({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!window.confirm("Discard this dream? Its changes are deleted and never reach your memory.")) return;
    setBusy(true);
    try {
      await api.rejectReview(review.id);
      onChanged();
    } catch (e) {
      setOutcome({ kind: "error", text: String(e) });
      setBusy(false);
    }
  };

  const [summary, signals] = splitSignals(review.summary);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60">
      <div className="border-b border-zinc-800 p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-xs text-zinc-500">
              {review.branch} · {new Date(review.createdAt).toLocaleString()}
            </div>
            <div className="mt-1 text-sm font-medium text-zinc-100">{review.title.replace(/^dream: review: /, "")}</div>
          </div>
          {outcome?.kind !== "accepted" && (
            <div className="flex shrink-0 gap-2">
              <button
                onClick={reject}
                disabled={busy}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              >
                Reject
              </button>
              <button
                onClick={accept}
                disabled={busy}
                className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                {busy ? "Working…" : "Accept"}
              </button>
            </div>
          )}
        </div>

        {summary && <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-300">{summary}</p>}
        {signals && <p className="mt-2 text-xs text-zinc-500">{signals}</p>}

        <div className="mt-3 flex flex-wrap gap-1.5">
          {review.filesChanged.map((f) => (
            <button
              key={f}
              onClick={() => onNavigate(f)}
              title="Open the live version"
              className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300 hover:text-cyan-300"
            >
              {f}
            </button>
          ))}
        </div>
        {review.liveCommitsSince > 0 && (
          <p className="mt-2 text-xs text-amber-300/80">
            {review.liveCommitsSince} change(s) landed in your memory since this dream started; accept will merge them.
          </p>
        )}

        {outcome?.kind === "accepted" && (
          <div className="mt-3 rounded-lg border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-200">
            Merged into your memory ({outcome.result.filesChanged.length} concept(s)). To undo, run in the bundle:
            <code className="mt-1 block select-all break-all font-mono text-xs text-emerald-100">
              {outcome.result.revertCommand}
            </code>
            <button onClick={onChanged} className="mt-2 text-xs text-emerald-300 underline hover:text-emerald-100">
              Done
            </button>
          </div>
        )}
        {outcome?.kind === "error" && (
          <div className="mt-3 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">
            {outcome.text}
            {outcome.conflicts && (
              <ul className="mt-1 list-inside list-disc font-mono text-xs">
                {outcome.conflicts.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="p-4">
        {diffError && <p className="text-sm text-red-400">{diffError}</p>}
        {!diffError && diff === null && <p className="text-sm text-zinc-500">Loading diff…</p>}
        {diff !== null && <Diff text={diff} />}
      </div>
    </div>
  );
}

/** The review body ends with a "Signals: ..." line; show it apart from the dream's own summary. */
function splitSignals(body: string): [string, string | null] {
  const m = body.match(/\n*(Signals: .*)\s*$/);
  return m ? [body.slice(0, m.index).trim(), m[1]] : [body.trim(), null];
}

interface FileDiff {
  path: string;
  status: "added" | "deleted" | "modified";
  lines: string[];
}

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let inHunks = false;
  for (const line of text.split("\n")) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      current = { path: "/" + header[2], status: "modified", lines: [] };
      files.push(current);
      inHunks = false;
      continue;
    }
    if (!current) continue;
    if (!inHunks) {
      if (line.startsWith("new file mode")) current.status = "added";
      else if (line.startsWith("deleted file mode")) current.status = "deleted";
      else if (line.startsWith("@@")) {
        inHunks = true;
        current.lines.push(line);
      }
      continue;
    }
    current.lines.push(line);
  }
  for (const f of files) while (f.lines.length && f.lines[f.lines.length - 1] === "") f.lines.pop();
  return files;
}

const STATUS_STYLE: Record<FileDiff["status"], string> = {
  added: "bg-emerald-900/60 text-emerald-300",
  deleted: "bg-red-900/60 text-red-300",
  modified: "bg-cyan-900/60 text-cyan-300",
};

function lineClass(line: string): string {
  if (line.startsWith("@@")) return "text-cyan-400/70";
  if (line.startsWith("+")) return "bg-emerald-950/60 text-emerald-200";
  if (line.startsWith("-")) return "bg-red-950/60 text-red-200";
  if (line.startsWith("\\")) return "text-zinc-600";
  return "text-zinc-400";
}

function Diff({ text }: { text: string }) {
  const files = parseDiff(text);
  if (files.length === 0) return <p className="text-sm text-zinc-500">No concept changes.</p>;
  return (
    <div className="space-y-4">
      {files.map((f) => (
        <div key={f.path} className="overflow-hidden rounded-lg border border-zinc-800">
          <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLE[f.status]}`}>{f.status}</span>
            <span className="font-mono text-xs text-zinc-300">{f.path}</span>
          </div>
          <pre className="overflow-x-auto text-xs leading-5">
            {f.lines.map((l, i) => (
              <div key={i} className={`px-3 ${lineClass(l)}`}>
                {l || " "}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}
