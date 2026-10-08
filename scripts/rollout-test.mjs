#!/usr/bin/env node
/**
 * Rollout test for provenance / memory_explain / supersession history /
 * memory_forget. One command, mechanical checks, no judgment needed.
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
    instruction: `The ${T1} staging site moved to https://staging2.zephyr.test. The old address https://staging.zephyr.test is retired. Update the existing ${T1} concept.`,
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

// ── Report ────────────────────────────────────────────────────────────
say("\n==================== SUMMARY ====================");
const order = { FAIL: 0, WARN: 1, SKIP: 2, PASS: 3 };
for (const r of results) say(`${r.status.padEnd(5)} ${String(r.id).padEnd(3)} ${r.name}${r.detail ? `  [${r.detail}]` : ""}`);
const count = (s) => results.filter((r) => r.status === s).length;
say(`\nPASS ${count("PASS")}  FAIL ${count("FAIL")}  WARN ${count("WARN")}  SKIP ${count("SKIP")}`);
say(`Git log of the test copy:`);
try {
  const { execFileSync } = await import("node:child_process");
  say(execFileSync("git", ["-C", dest, "log", "--oneline", "-n", "15"], { encoding: "utf8" }));
} catch {
  say("(no git log)");
}
const reportFile = path.join(os.tmpdir(), `ustory-rollout-report-${Date.now()}.txt`);
fs.writeFileSync(reportFile, log.join("\n"));
say(`Full log saved to: ${reportFile}`);
process.exit(count("FAIL") > 0 ? 1 : 0);
