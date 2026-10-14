#!/usr/bin/env node
/**
 * Call one MCP tool on a running understory over HTTP, with a bearer key.
 *
 *   node scripts/mcp-call.mjs <mcp-url> <key|-> <tool> ['<json arguments>']
 *
 *   node scripts/mcp-call.mjs http://localhost:3801/mcp - memory_status
 *   node scripts/mcp-call.mjs http://localhost:3801/mcp usk_abc memory_forget '{"source":"https://x"}'
 *
 * Use "-" when the server has no auth. Prints the tool's text. Exit code 0 when
 * the tool succeeded, 1 when it reported an error, 2 on a usage or connection
 * problem. "list" as the tool name prints the tool names instead.
 */
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [url, key, tool, argsJson] = process.argv.slice(2);
if (!url || !key || !tool) {
  console.error("usage: node scripts/mcp-call.mjs <mcp-url> <key|-> <tool|list> ['<json>']");
  process.exit(2);
}
let args = {};
try {
  args = argsJson ? JSON.parse(argsJson) : {};
} catch (e) {
  console.error(`arguments are not valid JSON: ${e.message}`);
  process.exit(2);
}

const req = createRequire(path.join(repo, "packages/server/package.json"));
const imp = (p) => import(pathToFileURL(req.resolve(p)).href);
const { Client } = await imp("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await imp("@modelcontextprotocol/sdk/client/streamableHttp.js");

// Exit via process.exitCode, never process.exit() right after closing the
// connection: on Windows that races libuv's handle teardown and aborts with an
// assertion, which turned "tool reported an error" (1) into 127.
let code = 0;
const client = new Client({ name: "mcp-call", version: "1" });
try {
  const headers = key === "-" ? {} : { Authorization: `Bearer ${key}` };
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  if (tool === "list") {
    console.log((await client.listTools()).tools.map((t) => t.name).join("\n"));
  } else {
    const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 900000 });
    console.log(r.content.map((c) => c.text ?? "").join("\n"));
    code = r.isError ? 1 : 0;
  }
} catch (e) {
  console.error(`could not call ${tool} at ${url}: ${e.message}`);
  code = 2;
} finally {
  await client.close().catch(() => {});
}
process.exitCode = code;
