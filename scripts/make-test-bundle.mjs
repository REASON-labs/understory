#!/usr/bin/env node
/**
 * Build a small, PREDICTABLE bundle for testing dreams, forgetting and review
 * mode. It is deliberately imperfect so every dream signal has something to
 * find, and it is a git repo with history, as a real autocommit bundle is.
 *
 *   node scripts/make-test-bundle.mjs <new-empty-directory>
 *
 * Nothing in it is real. Distinctive tokens (ZEPHYR, ORION, ...) make results
 * greppable.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/make-test-bundle.mjs <new-empty-directory>");
  process.exit(2);
}
if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
  console.error(`${dir} exists and is not empty; pick a new directory.`);
  process.exit(2);
}
const coreIndex = path.join(repo, "packages/core/dist/index.js");
if (!fs.existsSync(coreIndex)) {
  console.error("Not built. Run: pnpm install && pnpm -r build");
  process.exit(2);
}
const { KnowledgeBase } = await import(pathToFileURL(coreIndex).href);

fs.mkdirSync(dir, { recursive: true });
const kb = new KnowledgeBase(dir, { gitAutocommit: true });
const ready = await kb.ensureGitReady();
if (!ready.ok) {
  console.error(`git is not usable here: ${ready.reason}`);
  process.exit(1);
}

const w = (p, fm, body, msg) => kb.writeConcept(p, { type: "Note", ...fm }, body, msg);

// Linked cluster (healthy): billing <-> oncall <-> payments
await w("/svc/billing.md", { title: "Billing service", description: "Handles invoices and payment retries", sources: [{ ref: "https://example.com/billing-runbook", quote: "Invoices are retried three times." }] },
  "# Billing\nInvoices are retried three times. See [Oncall](/svc/oncall.md) and [Payments](/svc/payments.md).\n", "Added [Billing service](/svc/billing.md).");
await w("/svc/oncall.md", { title: "Oncall rotation", description: "Weekly rotation for platform services", sources: [{ ref: "https://example.com/oncall-policy" }] },
  "# Oncall\nRotation is weekly. Escalate to [Billing](/svc/billing.md) first.\n", "Added [Oncall rotation](/svc/oncall.md).");
await w("/svc/payments.md", { title: "Payments gateway", description: "Card processing integration" },
  "# Payments\nCard processing via the gateway. Owned with [Billing](/svc/billing.md).\n", "Added [Payments gateway](/svc/payments.md).");

// ORPHANS: nothing links to these (signal: orphans)
await w("/misc/lunch.md", { title: "Team lunch spot", description: "Where the team eats on Fridays" }, "# Lunch\nFridays at the noodle place.\n", "Added [Team lunch spot](/misc/lunch.md).");
await w("/misc/printer.md", { title: "Office printer", description: "How to reach the third floor printer" }, "# Printer\nThird floor, queue name ZEPHYR-PRINT.\n", "Added [Office printer](/misc/printer.md).");

// BROKEN LINK (signal: links)
await w("/svc/legacy.md", { title: "Legacy exporter", description: "Old export job" },
  "# Legacy\nReplaced by [the new exporter](/svc/new-exporter.md). Also see [Billing](/svc/billing.md).\n", "Added [Legacy exporter](/svc/legacy.md).");

// OVERSIZED (signal: oversized): >= 6 sections and > 6000 chars
const sections = ["Overview", "Deploys", "Rollbacks", "Alerts", "Capacity", "Costs", "History"];
const filler = (n) => `${n} notes. `.repeat(120) + "\n";
await w("/ops/handbook.md", { title: "Operations handbook", description: "Everything ops, grown over time", sources: [{ ref: "https://example.com/ops-wiki" }] },
  sections.map((s) => `# ${s}\n${filler(s)}`).join("\n") + "\nSee [Billing](/svc/billing.md).\n", "Added [Operations handbook](/ops/handbook.md).");

// DUPLICATE PAIR (signal: duplicates, only with DREAM_SIGNALS=all)
await w("/ref/rate-limits.md", { title: "API rate limits for billing", description: "100 requests per minute per client" },
  "# Rate limits\n100 requests per minute per client. See [Billing](/svc/billing.md).\n", "Added [API rate limits for billing](/ref/rate-limits.md).");
await w("/ref/billing-limits.md", { title: "Billing API rate limits", description: "per client limit of 100 requests per minute" },
  "# Billing limits\nEach client may make 100 requests per minute. See [Billing](/svc/billing.md).\n", "Added [Billing API rate limits](/ref/billing-limits.md).");

// A concept with a distinctive secret-ish fact, for forget tests
await w("/people/dana.md", { title: "Dana", description: "A colleague", sources: [{ ref: "https://example.com/hr-memo", quote: "Dana is allergic to peanuts." }, { ref: "trace:seed-1" }] },
  "# Dana\nDana is allergic to peanuts. Dana joined the platform team in March.\nSee [Oncall](/svc/oncall.md).\n", "Added [Dana](/people/dana.md).");

await kb.commitPending("test bundle");
const lint = await kb.lint();
console.log(`Test bundle ready: ${dir}`);
console.log(`  concepts ${lint.conceptCount}, orphans ${lint.orphans.length}, broken links ${lint.brokenLinks.length}`);
console.log("  expected dream signals (with DREAM_SIGNALS=all): orphans, links, oversized, insights, duplicates");
