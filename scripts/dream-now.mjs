#!/usr/bin/env node
/**
 * Run ONE dream immediately against a bundle, instead of waiting for the
 * background timer (whose minimum interval is 5 minutes).
 *
 *   node scripts/dream-now.mjs <bundle> [--dry-run] [--mode apply|review]
 *
 * --dry-run  detect signals only: no model call, no tokens, nothing written.
 * Honors DREAM_SIGNALS, DREAM_MAX_CHANGES, DREAM_VERIFY, DREAM_MODE and the
 * LLM_* settings exactly like the server does. Point it at a COPY of a bundle.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const bundle = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--mode");
const dryRun = args.includes("--dry-run");
const modeIdx = args.indexOf("--mode");
const mode = modeIdx >= 0 ? args[modeIdx + 1] : undefined;

if (!bundle || !fs.existsSync(bundle)) {
  console.error("usage: node scripts/dream-now.mjs <bundle> [--dry-run] [--mode apply|review]");
  process.exit(2);
}
if (mode && mode !== "apply" && mode !== "review") {
  console.error(`--mode must be apply or review, got "${mode}"`);
  process.exit(2);
}
const coreIndex = path.join(repo, "packages/core/dist/index.js");
if (!fs.existsSync(coreIndex)) {
  console.error("Not built. Run: pnpm install && pnpm -r build");
  process.exit(2);
}
const { KnowledgeBase, runDream } = await import(pathToFileURL(coreIndex).href);

const kb = new KnowledgeBase(bundle, { gitAutocommit: true });
const ready = await kb.ensureGitReady();
if (!ready.ok) {
  console.error(`git is not usable for this bundle: ${ready.reason}`);
  process.exit(1);
}

const t0 = Date.now();
const report = await runDream(kb, { dryRun, ...(mode ? { mode } : {}) });
const out = {
  ran: report.ran,
  outcome: report.outcome ?? null,
  reason: report.reason ?? null,
  maxChanges: report.maxChanges ?? null,
  signals: (report.signals ?? []).map((s) => ({ kind: s.kind, count: s.count })),
  suppressed: report.suppressed ?? [],
  filesChanged: report.filesChanged ?? [],
  review: report.review ?? null,
  commits: report.commits ?? [],
  seconds: Math.round((Date.now() - t0) / 1000),
  summary: report.summary ?? null,
};
console.log(JSON.stringify(out, null, 2));
process.exitCode = report.outcome && report.outcome !== "success" ? 1 : 0;
