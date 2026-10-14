#!/usr/bin/env node
/**
 * One-screen health summary for the soak period: is dreaming running, how did
 * the recent runs end, what is waiting for review, is the memory healthy.
 *
 *   node scripts/soak-report.mjs <base-url> [key|-]
 *   node scripts/soak-report.mjs http://localhost:3800 -
 *   node scripts/soak-report.mjs http://localhost:3800 usk_abc
 *
 * Exit code 1 when any recent dream did not end in success (so a cron or a
 * simple agent can tell "look at this" from "all quiet"), 2 when the server is
 * unreachable.
 */
const [base, key] = process.argv.slice(2);
if (!base) {
  console.error("usage: node scripts/soak-report.mjs <base-url> [key|-]");
  process.exit(2);
}
const headers = key && key !== "-" ? { Authorization: `Bearer ${key}` } : {};
const get = async (p) => {
  const r = await fetch(base.replace(/\/+$/, "") + p, { headers });
  if (!r.ok) throw new Error(`${p} answered ${r.status}`);
  return r.json();
};

let code = 0;
try {
  const [health, status, validate] = await Promise.all([get("/health"), get("/api/dream/status"), get("/api/validate")]);
  const line = (k, v) => console.log(`${k.padEnd(20)} ${v}`);

  line("server", `${health.status}${health.model ? `, model ${health.model.primary}` : ""}`);
  line("memory conformant", `${validate.conformant} (${validate.conceptCount} concepts, ${validate.issues?.length ?? 0} issue(s))`);
  line("dreaming", status.enabled ? `on, every ${status.interval}, mode ${status.mode ?? "apply"}` : "OFF");
  line("signals", (status.signals ?? []).join(", ") || "none");
  line("change budget", String(status.maxChanges ?? "?"));
  line("running now", String(status.running));
  line("next run", status.nextRunAt ?? "-");
  line("dream commits", `${status.commits?.length ?? 0} recent`);
  const pending = status.reviews ?? [];
  line("pending reviews", pending.length ? pending.map((r) => `${r.id} (${r.filesChanged.length} concept(s))`).join("; ") : "none");

  const history = status.history ?? [];
  console.log(`\nrecent dream runs (this process, newest first): ${history.length}`);
  for (const h of history.slice(0, 10)) {
    const outcome = h.ran ? h.outcome : "skipped";
    const bad = h.ran && h.outcome !== "success";
    if (bad || h.error) code = 1;
    const what = h.summary ?? h.reason ?? h.error ?? "";
    console.log(`${bad || h.error ? "!!" : "  "} ${h.startedAt}  ${String(outcome).padEnd(10)} files ${String(h.filesChanged?.length ?? 0).padStart(2)}  ${String(what).replace(/\s+/g, " ").slice(0, 90)}`);
  }
  console.log(code ? "\nRESULT: something needs a look (lines marked !!)." : "\nRESULT: all quiet.");
} catch (e) {
  console.error(`cannot read ${base}: ${e.message}`);
  code = 2;
}
process.exitCode = code;
