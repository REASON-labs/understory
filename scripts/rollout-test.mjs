#!/usr/bin/env node
/**
 * Rollout test for provenance / memory_explain / supersession history /
 * memory_forget / dream guardrails (#20) / dream review mode (#34). One command,
 * mechanical checks, no judgment needed.
 *
 *   node scripts/rollout-test.mjs <path-to-a-bundle>
 *
 * The bundle is COPIED to a temp directory first; the original is only read.
 * Needs the same LLM_* env vars the server uses (LLM_API_BASE_URL, LLM_API_KEY,
 * LLM_API_FORMAT, LLM_MODEL) and a built repo (pnpm -r build).
 */
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcBundle = process.argv[2];
if (!srcBundle || !fs.existsSync(srcBundle)) {
  console.error("usage: node scripts/rollout-test.mjs <path-to-a-bundle>");
  process.exit(2);
}
const stdioJs = path.join(repo, "packages/server/dist/mcp/stdio.js");
if (!fs.existsSync(stdioJs)) {
  console.error("Server not built. Run: pnpm install && pnpm -r build");
  process.exit(2);
}

// ── Preflight: fail fast with a plain-English reason, before anything is copied ──
const keep = process.argv.includes("--keep");
async function reachable(base) {
  try {
    await fetch(base.replace(/\/+$/, "") + "/models", { signal: AbortSignal.timeout(8000) });
    return true; // any HTTP answer means the host is reachable
  } catch {
    return false;
  }
}
for (const v of ["LLM_API_BASE_URL", "LLM_API_KEY", "LLM_API_FORMAT", "LLM_MODEL"]) {
  if (!process.env[v]) {
    console.error(`PREFLIGHT FAILED: ${v} is not set. Set all four LLM_* variables to the values your live understory uses.`);
    process.exit(2);
  }
}
if (!(await reachable(process.env.LLM_API_BASE_URL))) {
  const alt = process.env.LLM_API_BASE_URL.replace("host.docker.internal", "localhost");
  if (alt !== process.env.LLM_API_BASE_URL && (await reachable(alt))) {
    console.log(`NOTE: ${process.env.LLM_API_BASE_URL} only resolves inside Docker; using ${alt} instead.`);
    process.env.LLM_API_BASE_URL = alt;
  } else {
    console.error(`PREFLIGHT FAILED: cannot reach the LLM at ${process.env.LLM_API_BASE_URL}. Nothing was run. Fix LLM_API_BASE_URL (use an address reachable from THIS machine, not host.docker.internal) and rerun.`);
    process.exit(2);
  }
}

const dest = path.join(os.tmpdir(), `ustory-rollout-${Date.now()}`);
fs.cpSync(srcBundle, dest, { recursive: true });

const req = createRequire(path.join(repo, "packages/server/package.json"));
const imp = (p) => import(pathToFileURL(req.resolve(p)).href);
const { Client } = await imp("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await imp("@modelcontextprotocol/sdk/client/stdio.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [stdioJs],
  env: { ...process.env, BUNDLE_ROOT: dest, GIT_AUTOCOMMIT: "true" },
  stderr: "pipe",
});
const client = new Client({ name: "rollout-test", version: "1" });
await client.connect(transport);

const results = [];
const log = [];
const say = (s = "") => {
  console.log(s);
  log.push(s);
};
const record = (id, name, status, detail = "") => {
  results.push({ id, name, status, detail });
  say(`  => ${status}: ${name}${detail ? ` (${detail})` : ""}`);
};

async function call(tool, args = {}) {
  say(`\n--- CALL ${tool} ${JSON.stringify(args)}`);
  try {
    const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 600000 });
    const text = r.content.map((c) => c.text ?? "").join("\n");
    say(`${r.isError ? "[isError] " : ""}${text.slice(0, 1800)}${text.length > 1800 ? "\n...(truncated)" : ""}`);
    return { text, isError: !!r.isError };
  } catch (e) {
    say(`[exception] ${e.message}`);
    return { text: String(e.message), isError: true };
  }
}

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === ".git") return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
/** Files (outside .git) whose text contains the token. */
const filesWith = (token) => walk(dest).filter((f) => fs.readFileSync(f, "utf8").includes(token));
const split = (file) => {
  const t = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const m = t.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return m ? { fm: m[1], body: m[2] } : { fm: "", body: t };
};
const refsIn = (fm) => [...fm.matchAll(/ref:\s*'?([^'\n]+?)'?\s*$/gm)].map((m) => m[1]);
const hist = (fm) => (fm.match(/^history:/m) ? [...fm.matchAll(/^\s+was:/gm)].length : 0);
const rel = (f) => "/" + path.relative(dest, f).split(path.sep).join("/");
const seed = (relPath, fm, body) => {
  const f = path.join(dest, relPath);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `---\n${fm}\n---\n${body}\n`);
};

say(`Rollout test. Test copy: ${dest}\nOriginal bundle was only read.\n`);

// ── S0 ────────────────────────────────────────────────────────────────
say("STEP 0: server exposes the new tools");
{
  const names = (await client.listTools()).tools.map((t) => t.name);
  say(`  tools: ${names.join(", ")}`);
  const ok = names.includes("memory_explain") && names.includes("memory_forget");
  record("0", "memory_explain and memory_forget are registered", ok ? "PASS" : "FAIL");
}

// ── S1-S4: LLM-driven add/update ─────────────────────────────────────
const T1 = "ZEPHYRSTAGE";
const URL1 = "https://example.com/zephyr-runbook";
let zFile = null;
let srcCount = 0;
let histCount = 0;

say("\nSTEP 1: memory_add records provenance");
await call("memory_add", {
  content: `The Zephyr project (${T1}) has its staging site at https://staging.zephyr.test. This comes from the ops runbook at ${URL1}.`,
});
{
  const hits = filesWith("staging.zephyr.test").filter((f) => !/[\\/](index|log)\.md$/.test(f) && !f.includes(".traces"));
  if (hits.length === 0) {
    record("1", "a concept containing the staging URL was written", "FAIL", "no file contains it");
  } else {
    zFile = hits[0];
    const { fm } = split(zFile);
    const refs = refsIn(fm);
    record("1a", "concept written", "PASS", rel(zFile));
    record("1b", "has a trace:<id> source", refs.some((r) => r.startsWith("trace:")) ? "PASS" : "FAIL", `sources: ${refs.join(" | ") || "none"}`);
    const cited = refs.includes(URL1);
    record("1c", "model cited the runbook URL as a source", cited ? "PASS" : "WARN", cited ? "" : "model only has the automatic trace source (prompt-dependent, not a code bug)");
    srcCount = refs.length;
  }
}

say("\nSTEP 2: memory_explain on that concept");
if (zFile) {
  const r = await call("memory_explain", { path: rel(zFile) });
  record("2", "explain shows Sources and a trace entry", !r.isError && r.text.includes("## Sources") && r.text.includes("trace:") ? "PASS" : "FAIL");
} else record("2", "explain", "SKIP", "step 1 wrote nothing");

say("\nSTEP 3: memory_update replaces a fact (supersession)");
if (zFile) {
  await call("memory_update", {
    instruction: `The ${T1} staging site moved to https://staging2.zephyr.test. Update the existing ${T1} concept.`,
  });
  const { fm, body } = split(zFile);
  record("3a", "body has the new URL", body.includes("staging2.zephyr.test") ? "PASS" : "FAIL");
  record("3b", "body no longer contains the old URL", body.includes("https://staging.zephyr.test") ? "FAIL" : "PASS");
  histCount = hist(fm);
  record("3c", "history entry recorded the old value", histCount > 0 ? "PASS" : "WARN", histCount > 0 ? "" : "model did not use 'replaced' (prompt-dependent)");
} else record("3", "update", "SKIP", "no concept");

say("\nSTEP 4: a further edit keeps earlier sources and history");
if (zFile) {
  await call("memory_update", { instruction: `Add to the ${T1} concept: the owning team is Platform. Do not change anything else.` });
  const { fm } = split(zFile);
  const now = refsIn(fm).length;
  record("4a", "no sources lost", now >= srcCount ? "PASS" : "FAIL", `before ${srcCount}, after ${now}`);
  record("4b", "no history lost", hist(fm) >= histCount ? "PASS" : "FAIL", `before ${histCount}, after ${hist(fm)}`);
} else record("4", "edit", "SKIP", "no concept");

// ── S5-S6: forget safety (no LLM involved) ────────────────────────────
say("\nSTEP 5: forget defaults to a dry run");
seed(
  "probe/dryrun.md",
  "type: Note\ntitle: Probe\nsources:\n  - ref: 'https://example.com/probe'\n    at: '2026-10-01'",
  "# Probe\n\nDRYRUNTOKEN stays put.\n"
);
{
  const r = await call("memory_forget", { source: "https://example.com/probe" });
  record("5a", "output says DRY RUN", r.text.includes("DRY RUN") ? "PASS" : "FAIL");
  record("5b", "the file still exists", fs.existsSync(path.join(dest, "probe/dryrun.md")) ? "PASS" : "FAIL");
  record("5c", "no tombstone was written", fs.existsSync(path.join(dest, ".forgotten.json")) ? "FAIL" : "PASS");
}

say("\nSTEP 6: forget with no arguments is rejected");
{
  const r = await call("memory_forget", {});
  record("6", "error mentions exactly one of source/path", r.isError && /exactly one/i.test(r.text) ? "PASS" : "FAIL");
}

// ── S7: mixed provenance rewrite (the one that needs the LLM to behave) ──
const KEEP = "KEEPTOKEN-OnCallWeekly";
const GONE = "GONETOKEN-PurpleElephant";
const URL2 = "https://example.com/oncall-policy";
const URL3 = "https://example.com/elephant-memo";
say("\nSTEP 7: forget rewrites a concept that mixes two sources");
seed(
  "mixed/rotation.md",
  `type: Note\ntitle: Rotation\nsources:\n  - ref: '${URL2}'\n    at: '2026-10-01'\n  - ref: '${URL3}'\n    quote: '${GONE} is the code word.'\n    at: '2026-10-02'\n  - ref: 'trace:seedmixed1'\n    at: '2026-10-02'`,
  `# Rotation\n\n${KEEP}: the on-call rotation is weekly.\n\n${GONE} is the code word for the incident channel.\n`
);
{
  const dry = await call("memory_forget", { source: URL3 });
  record("7a", "dry run lists /mixed/rotation.md under Rewrite", dry.text.includes("Rewrite") && dry.text.includes("/mixed/rotation.md") && !/Delete[^\n]*\n\s+- \/mixed\/rotation\.md/.test(dry.text) ? "PASS" : "FAIL");
  const go = await call("memory_forget", { source: URL3, dry_run: false });
  record("7b", "apply reports Forgotten", go.text.startsWith("Forgotten") || go.text.trimStart().startsWith("Forgotten") ? "PASS" : "FAIL", go.isError ? "aborted/error" : "");
  const f = path.join(dest, "mixed/rotation.md");
  if (fs.existsSync(f)) {
    const { fm, body } = split(f);
    record("7c", "forgotten text is gone from the body", body.includes(GONE) ? "FAIL" : "PASS");
    record("7d", "unrelated text is still in the body", body.includes(KEEP) ? "PASS" : "FAIL");
    record("7e", "forgotten source and its quote are gone from frontmatter", fm.includes(URL3) || fm.includes(GONE) ? "FAIL" : "PASS");
    record("7f", "the other source is still recorded", fm.includes(URL2) ? "PASS" : "FAIL");
  } else record("7c", "concept still exists after rewrite", "FAIL", "file was deleted");
  record("7g", "no warnings in the output", /Warnings:/.test(go.text) ? "FAIL" : "PASS");
}

// ── S8-S9: full delete + tombstone ────────────────────────────────────
const ORION = "ORIONTOKEN-LaunchInMarch";
const URL4 = "https://example.com/orion-brief";
say("\nSTEP 8: forget deletes a concept whose only source is forgotten");
seed(
  "launch/orion.md",
  `type: Note\ntitle: Orion\nsources:\n  - ref: '${URL4}'\n    at: '2026-10-01'\n  - ref: 'trace:seedorion1'\n    at: '2026-10-01'`,
  `# Orion\n\n${ORION}: Project Orion launches in March.\n`
);
{
  const go = await call("memory_forget", { source: URL4, dry_run: false });
  record("8a", "apply reports Forgotten", go.text.trimStart().startsWith("Forgotten") ? "PASS" : "FAIL");
  record("8b", "the concept file is gone", fs.existsSync(path.join(dest, "launch/orion.md")) ? "FAIL" : "PASS");
  record("8c", ".forgotten.json exists", fs.existsSync(path.join(dest, ".forgotten.json")) ? "PASS" : "FAIL");
  const leaks = filesWith(ORION);
  record("8d", "no file in the working tree mentions the token", leaks.length === 0 ? "PASS" : "FAIL", leaks.map(rel).join(", "));
}

say("\nSTEP 9: a forgotten source cannot be re-added");
{
  const r = await call("memory_add", { content: `${ORION}: Project Orion launches in March, per ${URL4}.` });
  record("9a", "memory_add is refused", r.isError && /forgotten/i.test(r.text) ? "PASS" : "FAIL");
  record("9b", "nothing was written", filesWith(ORION).length === 0 ? "PASS" : "FAIL");
}

await client.close();

// ── S10-S11: dream guardrails (#20). Dreams are not an MCP tool, so these
// drive the built core directly, on the same copy, after the server is closed.
const { KnowledgeBase, runDream, DreamReviews } = await imp("@understory/core");
const { execFileSync } = await import("node:child_process");
const git = (...args) => execFileSync("git", ["-C", dest, ...args], { encoding: "utf8" });
/** Working tree contents, minus run traces (written outside any transaction). */
const snapshot = () =>
  Object.fromEntries(
    walk(dest)
      .map((f) => [rel(f), f])
      .filter(([r]) => !r.startsWith("/.traces/"))
      .map(([r, f]) => [r, fs.readFileSync(f, "utf8")])
  );
const sameTree = (a, b) => {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.filter((k) => a[k] !== b[k]);
};
// Guaranteed dream work: two orphans and a broken link.
seed("dreamtest/kestrel.md", "type: Note\ntitle: Kestrel cache\ndescription: Kestrel is the read cache in front of the billing DB", "# Kestrel\n\nKestrel caches billing reads for 60s.\n");
seed("dreamtest/heron.md", "type: Note\ntitle: Heron queue\ndescription: Heron is the job queue that feeds Kestrel invalidations", "# Heron\n\nHeron sends cache invalidations to Kestrel. See [old runbook](/dreamtest/gone.md).\n");
git("add", "-A");
git("commit", "-q", "--allow-empty", "-m", "rollout: seed dream test");
const dkb = new KnowledgeBase(dest, { gitAutocommit: true });
await dkb.ensureGitReady();

say("\nSTEP 10: a dream over its change budget is rolled back in full");
{
  const before = snapshot();
  const r = await runDream(dkb, { maxConceptsChanged: 1 });
  say(`  outcome: ${r.outcome} — ${(r.summary ?? r.reason ?? "").slice(0, 300)}`);
  if (r.outcome === "too_broad") {
    record("10a", "outcome is too_broad and names the limit", /DREAM_MAX_CHANGES=1/.test(r.summary) ? "PASS" : "FAIL");
    const diff = sameTree(before, snapshot());
    record("10b", "working tree is exactly as before", diff.length === 0 ? "PASS" : "FAIL", diff.join(", "));
    record("10c", "the rollback commit is a dream commit", /^dream: revert:/.test(git("log", "-1", "--format=%s")) ? "PASS" : "FAIL");
  } else {
    // The model stayed within one concept or did nothing: legitimate, just untested.
    record("10", "budget rollback exercised", "WARN", `model produced outcome ${r.outcome}, not an over-budget run`);
  }
}

say("\nSTEP 11: dream commits are prefixed and one command reverts the run");
{
  const head = git("rev-parse", "HEAD").trim();
  const before = snapshot();
  const r = await runDream(dkb);
  say(`  outcome: ${r.outcome} — ${(r.summary ?? r.reason ?? "").slice(0, 300)}`);
  const subjects = git("log", "--format=%s", `${head}..HEAD`).trim().split("\n").filter(Boolean);
  record("11a", "every commit made by the dream starts with dream:", subjects.every((m) => m.startsWith("dream:")) ? "PASS" : "FAIL", subjects.filter((m) => !m.startsWith("dream:")).join(" | "));
  const listed = (await dkb.commitsWithPrefix("dream:", 50)).map((c) => c.commit);
  record("11b", "commitsWithPrefix lists them", (r.commits ?? []).every((c) => listed.includes(c)) ? "PASS" : "FAIL");
  if (r.outcome === "success" && r.commits?.length) {
    git("revert", "--no-edit", `${r.commits[0]}^..${r.commits.at(-1)}`);
    const diff = sameTree(before, snapshot());
    record("11c", "the revert command restores the tree exactly", diff.length === 0 ? "PASS" : "FAIL", diff.join(", "));
  } else {
    record("11c", "revert of a successful dream", "WARN", `model produced outcome ${r.outcome} with ${r.commits?.length ?? 0} commit(s)`);
  }
}

// ── S12-S14: review mode (#34). Step 11 reverted its dream, so the seeded
// orphans and broken link are back and there is dream work to do.
const reviews = new DreamReviews(dkb);
const conflictMarkers = (rel) => /^(<<<<<<<|>>>>>>>)/m.test(fs.readFileSync(path.join(dest, rel), "utf8"));

say("\nSTEP 12: a review-mode dream changes nothing live and leaves a branch");
let reviewId = null;
{
  const head = git("rev-parse", "HEAD").trim();
  const before = snapshot();
  const r = await runDream(dkb, { mode: "review" });
  say(`  outcome: ${r.outcome} — ${(r.summary ?? r.reason ?? "").slice(0, 300)}`);
  if (r.review) {
    reviewId = r.review.branch.slice("dream/".length);
    const diff = sameTree(before, snapshot());
    record("12a", "live tree unchanged", diff.length === 0 ? "PASS" : "FAIL", diff.join(", "));
    // A "snapshot before a review dream" commit of pending live changes is
    // expected; what must not appear on the live branch is a dream commit.
    const landed = git("log", "--format=%s", `${head}..HEAD`).split("\n").filter((m) => m.startsWith("dream:"));
    record("12b", "no dream commit on the live branch", landed.length === 0 ? "PASS" : "FAIL", landed.join(" | "));
    const listed = await reviews.list();
    record("12c", "the review is listed", listed.some((x) => x.id === reviewId) ? "PASS" : "FAIL");
    const patch = (await reviews.diff(reviewId)) ?? "";
    say(`  diff (first 1500 chars):\n${patch.slice(0, 1500)}`);
    record("12d", "the review has a non-empty diff", patch.trim() ? "PASS" : "FAIL");
  } else {
    record("12", "review branch created", "WARN", `model produced outcome ${r.outcome} with no changes to review`);
  }
}

say("\nSTEP 13: accepting the review merges it into the live bundle");
if (reviewId) {
  const files = (await reviews.get(reviewId)).filesChanged;
  const branchContent = Object.fromEntries(
    files.map((f) => [f, (() => { try { return git("show", `dream/${reviewId}:${f.slice(1)}`); } catch { return null; } })()])
  );
  // A user edit lands while the review is pending, so accept has to merge.
  seed("dreamtest/user-note.md", "type: Note\ntitle: User note", "# User note\n\nWritten while a review was pending.\n");
  git("add", "-A");
  git("commit", "-q", "-m", "rollout: user edit during review");
  const a = await reviews.accept(reviewId);
  say(`  accept: ${JSON.stringify(a).slice(0, 400)}`);
  if (a.ok) {
    const mismatched = files.filter((f) => {
      const p = path.join(dest, f.slice(1));
      const live = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
      return live !== branchContent[f];
    });
    record("13a", "every reviewed concept landed as reviewed", mismatched.length === 0 ? "PASS" : "FAIL", mismatched.join(", "));
    record("13b", "the user edit survived", fs.existsSync(path.join(dest, "dreamtest/user-note.md")) ? "PASS" : "FAIL");
    record("13c", "no conflict markers in log.md / index.md", !conflictMarkers("log.md") && !conflictMarkers("index.md") ? "PASS" : "FAIL");
    record("13d", "the review is gone", (await reviews.get(reviewId)) === null ? "PASS" : "FAIL");
  } else if (a.reason === "conflict") {
    record("13", "accept", "WARN", `the dream edited the same concept as the seeded user edit: ${a.conflicts.join(", ")}`);
  } else {
    record("13", "accept", "FAIL", JSON.stringify(a));
  }
} else {
  record("13", "accept", "SKIP", "no review from step 12");
}

say("\nSTEP 14: rejecting a review discards it");
{
  // Reintroduce dream work: a fresh orphan.
  seed("dreamtest/plover.md", "type: Note\ntitle: Plover alerts\ndescription: Plover pages on-call when Heron backs up", "# Plover\n\nPlover alerts when the Heron queue is deep.\n");
  git("add", "-A");
  git("commit", "-q", "-m", "rollout: seed another orphan");
  const before = snapshot();
  const r = await runDream(dkb, { mode: "review" });
  say(`  outcome: ${r.outcome} — ${(r.summary ?? r.reason ?? "").slice(0, 300)}`);
  if (r.review) {
    const id = r.review.branch.slice("dream/".length);
    record("14a", "reject succeeds", (await reviews.reject(id)) ? "PASS" : "FAIL");
    record("14b", "no review remains", (await reviews.list()).length === 0 ? "PASS" : "FAIL");
    const diff = sameTree(before, snapshot());
    record("14c", "live tree unchanged", diff.length === 0 ? "PASS" : "FAIL", diff.join(", "));
  } else {
    record("14", "reject", "WARN", `model produced outcome ${r.outcome} with no changes to review`);
  }
}

// ── Report ────────────────────────────────────────────────────────────
say("\n==================== SUMMARY ====================");
const order = { FAIL: 0, WARN: 1, SKIP: 2, PASS: 3 };
for (const r of results) say(`${r.status.padEnd(5)} ${String(r.id).padEnd(3)} ${r.name}${r.detail ? `  [${r.detail}]` : ""}`);
const count = (s) => results.filter((r) => r.status === s).length;
say(`\nPASS ${count("PASS")}  FAIL ${count("FAIL")}  WARN ${count("WARN")}  SKIP ${count("SKIP")}`);
say(`Git log of the test copy:`);
try {
  say(execFileSync("git", ["-C", dest, "log", "--oneline", "-n", "25"], { encoding: "utf8" }));
} catch {
  say("(no git log)");
}
const reportFile = path.join(os.tmpdir(), `ustory-rollout-report-${Date.now()}.txt`);
fs.writeFileSync(reportFile, log.join("\n"));
say(`Full log saved to: ${reportFile}`);
const failed = count("FAIL");
const warned = count("WARN");
say(
  failed === 0
    ? `
VERDICT: ALL CHECKS PASSED${warned ? ` (${warned} warning(s): model behaviour, not code)` : ""}`
    : `
VERDICT: ${failed} CHECK(S) FAILED. Paste the ENTIRE output above to the developer.`
);
if (!keep) {
  fs.rmSync(dest, { recursive: true, force: true });
  say(`Test copy deleted. (Use --keep to retain it.)`);
}
process.exitCode = failed > 0 ? 1 : 0;
