import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { KnowledgeBase } from "../src/okf/index.js";

let outer: string;

beforeEach(async () => {
  outer = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-nested-"));
});
afterEach(async () => {
  await fs.rm(outer, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("ensureGitReady and bundles inside another repository", () => {
  it("warns (does not refuse) when the bundle is a subfolder of another repo", async () => {
    const git = simpleGit(outer);
    await git.init();
    await git.addConfig("user.name", "t");
    await git.addConfig("user.email", "t@t");
    const bundle = path.join(outer, "notes", "bundle");
    await fs.mkdir(bundle, { recursive: true });

    const kb = new KnowledgeBase(bundle, { gitAutocommit: true });
    const ready = await kb.ensureGitReady();

    expect(ready.ok).toBe(true);
    expect(ready.note).toMatch(/inside the git repository at/);
    expect(ready.note).toMatch(/GIT_AUTOCOMMIT=false/);
  }, 60_000);

  it("says nothing for a bundle that is its own repository", async () => {
    const bundle = path.join(outer, "bundle");
    await fs.mkdir(bundle, { recursive: true });
    const ready = await new KnowledgeBase(bundle, { gitAutocommit: true }).ensureGitReady();
    expect(ready.ok).toBe(true);
    expect(ready.note).toBeUndefined();
  }, 60_000);

  it("says nothing when the bundle root is itself the repository's top level", async () => {
    await simpleGit(outer).init();
    const ready = await new KnowledgeBase(outer, { gitAutocommit: true }).ensureGitReady();
    expect(ready.ok).toBe(true);
    expect(ready.note).toBeUndefined();
  }, 60_000);
});
