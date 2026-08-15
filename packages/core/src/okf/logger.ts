import { promises as fs } from "node:fs";
import path from "node:path";
import type { Bundle } from "./bundle.js";
import type { LogAction, LogEntry } from "./types.js";

const LOG_HEADER = "# Directory Update Log";

/**
 * Append an entry to the root log.md per spec §7: newest-first,
 * grouped under `## YYYY-MM-DD` headings.
 */
export async function appendLog(
  bundle: Bundle,
  action: LogAction,
  summary: string
): Promise<void> {
  const logPath = path.join(bundle.root, "log.md");
  const today = new Date().toISOString().slice(0, 10);
  const bullet = `* **${action}**: ${summary.trim()}`;

  let existing = "";
  try {
    existing = await fs.readFile(logPath, "utf-8");
  } catch {
    // No log yet.
  }

  let content: string;
  if (!existing.trim()) {
    content = `${LOG_HEADER}\n\n## ${today}\n\n${bullet}\n`;
  } else {
    const todayHeading = `## ${today}`;
    if (existing.includes(todayHeading)) {
      // Insert bullet directly under today's heading (newest bullet first).
      content = existing.replace(todayHeading, `${todayHeading}\n\n${bullet}`);
      // Collapse the doubled blank line the replace can introduce.
      content = content.replace(`${todayHeading}\n\n${bullet}\n\n\n`, `${todayHeading}\n\n${bullet}\n\n`);
    } else {
      // New date section goes right after the header (newest-first).
      const idx = existing.indexOf(LOG_HEADER);
      if (idx === -1) {
        content = `${LOG_HEADER}\n\n${todayHeading}\n\n${bullet}\n\n${existing.trimStart()}`;
      } else {
        const afterHeader = idx + LOG_HEADER.length;
        content =
          existing.slice(0, afterHeader) +
          `\n\n${todayHeading}\n\n${bullet}\n` +
          existing.slice(afterHeader).replace(/^\n+/, "\n");
      }
    }
  }
  // Through the bundle, not fs, so log appends are rollback-able.
  await bundle.writeFile(logPath, content);
}

/** Parse the root log.md into structured entries (best-effort, permissive). */
export async function readLog(bundle: Bundle): Promise<LogEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(bundle.root, "log.md"), "utf-8");
  } catch {
    return [];
  }
  const entries: LogEntry[] = [];
  let currentDate = "";
  for (const line of raw.split("\n")) {
    const dateMatch = line.match(/^##\s+(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      currentDate = dateMatch[1];
      continue;
    }
    const bulletMatch = line.match(/^\*\s+\*\*(Creation|Update|Deletion)\*\*:\s*(.*)$/);
    if (bulletMatch && currentDate) {
      entries.push({
        date: currentDate,
        action: bulletMatch[1] as LogAction,
        summary: bulletMatch[2],
      });
    }
  }
  return entries;
}
