/**
 * Recall benchmark (PR-1a).
 *
 * Measures recall@k of the current retrieval path — kb.search(), which today is
 * the keyword scan in okf/search.ts — against a gold set of query→expected-path
 * pairs over a fixture bundle. This is the baseline every Phase 1 change is
 * judged against: hybrid retrieval (PR-1d) must beat these numbers, especially
 * the `paraphrase` split, without wrecking the `exact` split or precision.
 *
 * "Recall@k (any)" = for a query, at least one expected concept appears in the
 * top-k results. Matches the LongMemEval / iai-pme recall_any@k convention, so
 * numbers are comparable to what those projects report.
 *
 * Run (core must be built first, so @understory/core resolves to dist):
 *   pnpm build
 *   pnpm bench:recall            # human table
 *   pnpm bench:recall -- --json  # machine-readable, for CI diffing
 *
 * Point it at a real bundle / gold set instead of the fixture:
 *   BENCH_BUNDLE=/path/to/bundle BENCH_GOLD=/path/to/gold.json pnpm bench:recall
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { KnowledgeBase } from "@understory/core";

const HERE = dirname(fileURLToPath(import.meta.url));
const KS = [1, 5, 10] as const;
const TOP_K = Math.max(...KS);

interface GoldQuery {
  query: string;
  expected: string[];
  category?: string;
}
interface Gold {
  queries: GoldQuery[];
}

interface Row {
  query: string;
  category: string;
  /** 0-based rank of the first expected hit in the results, or -1 for a miss. */
  rank: number;
}

const jsonOut = process.argv.includes("--json");

const bundleRoot = process.env.BENCH_BUNDLE
  ? resolve(process.env.BENCH_BUNDLE)
  : resolve(HERE, "../fixtures/recall-bundle");
const goldPath = process.env.BENCH_GOLD
  ? resolve(process.env.BENCH_GOLD)
  : resolve(HERE, "./gold.json");

const gold = JSON.parse(readFileSync(goldPath, "utf8")) as Gold;
const kb = new KnowledgeBase(bundleRoot, {});

async function firstExpectedRank(q: GoldQuery): Promise<number> {
  const expected = new Set(q.expected);
  const hits = await kb.search(q.query, { limit: TOP_K });
  return hits.findIndex((h) => expected.has(h.path));
}

function recallAtK(rows: Row[], k: number): number {
  if (rows.length === 0) return 0;
  const hit = rows.filter((r) => r.rank >= 0 && r.rank < k).length;
  return hit / rows.length;
}

function pct(x: number): string {
  return (x * 100).toFixed(1).padStart(5) + "%";
}

async function main(): Promise<void> {
  const rows: Row[] = [];
  for (const q of gold.queries) {
    rows.push({
      query: q.query,
      category: q.category ?? "uncategorized",
      rank: await firstExpectedRank(q),
    });
  }

  const categories = [...new Set(rows.map((r) => r.category))].sort();
  const summarize = (subset: Row[]) =>
    Object.fromEntries(KS.map((k) => [`recall@${k}`, recallAtK(subset, k)]));

  const report = {
    bundle: bundleRoot,
    gold: goldPath,
    n: rows.length,
    overall: summarize(rows),
    byCategory: Object.fromEntries(
      categories.map((c) => [c, summarize(rows.filter((r) => r.category === c))])
    ),
    perQuery: rows.map((r) => ({
      query: r.query,
      category: r.category,
      firstHitRank: r.rank < 0 ? null : r.rank + 1, // 1-based for humans
      hit: r.rank >= 0 && r.rank < TOP_K,
    })),
  };

  if (jsonOut) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  console.log(`\nRecall benchmark — ${rows.length} queries`);
  console.log(`bundle: ${bundleRoot}`);
  console.log(`retrieval: keyword scan (baseline)\n`);

  const line = (label: string, s: Record<string, number>) =>
    console.log(
      `  ${label.padEnd(14)} ` + KS.map((k) => `r@${k} ${pct(s[`recall@${k}`])}`).join("   ")
    );
  line("overall", report.overall);
  for (const c of categories) line(c, report.byCategory[c]);

  console.log(`\n  per query (rank of first expected hit, — = miss in top ${TOP_K}):`);
  for (const r of report.perQuery) {
    const mark = r.hit ? String(r.firstHitRank).padStart(2) : " —";
    console.log(`    [${r.category.padEnd(10)}] ${mark}  ${r.query}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("[bench:recall]", err instanceof Error ? err.message : err);
  process.exit(1);
});
