import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/knowledge-base.js";

let root: string;
let kb: KnowledgeBase;

const fm = (title: string) => ({ type: "note", title, description: `about ${title}` });

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), "utf-8");
}

async function exists(rel: string): Promise<boolean> {
  return fs
    .access(path.join(root, rel))
    .then(() => true)
    .catch(() => false);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "understory-tx-"));
  kb = new KnowledgeBase(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("KnowledgeBase.transaction — commit path", () => {
  it("keeps every write when the transaction succeeds", async () => {
    await kb.transaction(async () => {
      await kb.writeConcept("/alpha.md", fm("Alpha"), "# Alpha\n\nbody\n", "Added Alpha.");
      await kb.writeConcept("/beta.md", fm("Beta"), "# Beta\n\nbody\n", "Added Beta.");
    });

    expect(await exists("alpha.md")).toBe(true);
    expect(await exists("beta.md")).toBe(true);
    expect(await read("index.md")).toContain("Alpha");
    expect(await read("log.md")).toContain("Added Beta.");
  });
});

describe("KnowledgeBase.transaction — rollback path", () => {
  it("deletes concepts that were created before the failure", async () => {
    await expect(
      kb.transaction(async () => {
        await kb.writeConcept("/alpha.md", fm("Alpha"), "# Alpha\n", "Added Alpha.");
        await kb.writeConcept("/beta.md", fm("Beta"), "# Beta\n", "Added Beta.");
        throw new Error("model died at step 7");
      })
    ).rejects.toThrow("model died at step 7");

    expect(await exists("alpha.md")).toBe(false);
    expect(await exists("beta.md")).toBe(false);
  });

  it("restores the previous contents of concepts that existed before", async () => {
    await kb.writeConcept("/alpha.md", fm("Alpha"), "# Alpha\n\noriginal\n", "Added Alpha.");
    const before = await read("alpha.md");

    await expect(
      kb.transaction(async () => {
        await kb.writeConcept("/alpha.md", fm("Alpha"), "# Alpha\n\nCLOBBERED\n", "Changed Alpha.");
        throw new Error("boom");
      })
    ).rejects.toThrow();

    expect(await read("alpha.md")).toBe(before);
    expect(await read("alpha.md")).not.toContain("CLOBBERED");
  });

  it("restores a concept the agent deleted", async () => {
    await kb.writeConcept("/gone.md", fm("Gone"), "# Gone\n\nkeep me\n", "Added Gone.");
    const before = await read("gone.md");

    await expect(
      kb.transaction(async () => {
        await kb.deleteConcept("/gone.md", "Removed Gone.");
        throw new Error("boom");
      })
    ).rejects.toThrow();

    expect(await read("gone.md")).toBe(before);
  });

  it("rolls back index.md and log.md too, not just concepts", async () => {
    await kb.writeConcept("/alpha.md", fm("Alpha"), "# Alpha\n", "Added Alpha.");
    const indexBefore = await read("index.md");
    const logBefore = await read("log.md");

    await expect(
      kb.transaction(async () => {
        await kb.writeConcept("/beta.md", fm("Beta"), "# Beta\n", "Added Beta.");
        throw new Error("boom");
      })
    ).rejects.toThrow();

    // Regression guard: index/log are written by indexer.ts and logger.ts,
    // which used to write via fs directly and so escaped the journal.
    expect(await read("index.md")).toBe(indexBefore);
    expect(await read("log.md")).toBe(logBefore);
    expect(await read("index.md")).not.toContain("Beta");
  });

  it("only keeps the first pre-image when a file is written repeatedly", async () => {
    await kb.writeConcept("/alpha.md", fm("Alpha"), "# Alpha\n\nv1\n", "Added Alpha.");
    const before = await read("alpha.md");

    await expect(
      kb.transaction(async () => {
        await kb.writeConcept("/alpha.md", fm("Alpha"), "# Alpha\n\nv2\n", "Update.");
        await kb.writeConcept("/alpha.md", fm("Alpha"), "# Alpha\n\nv3\n", "Update.");
        throw new Error("boom");
      })
    ).rejects.toThrow();

    expect(await read("alpha.md")).toBe(before);
  });

  it("attaches a rollback report to the rethrown error", async () => {
    const err = await kb
      .transaction(async () => {
        await kb.writeConcept("/alpha.md", fm("Alpha"), "# Alpha\n", "Added Alpha.");
        throw new Error("boom");
      })
      .catch((e) => e as Error & { rollback?: { restored: string[]; failed: string[] } });

    expect(err.rollback).toBeDefined();
    expect(err.rollback!.failed).toEqual([]);
    expect(err.rollback!.restored).toContain("/alpha.md");
    expect(err.rollback!.restored).toContain("/index.md");
    expect(err.rollback!.restored).toContain("/log.md");
  });

  it("leaves the bundle usable after a rollback", async () => {
    await expect(
      kb.transaction(async () => {
        await kb.writeConcept("/alpha.md", fm("Alpha"), "# Alpha\n", "Added Alpha.");
        throw new Error("boom");
      })
    ).rejects.toThrow();

    // The journal must be detached in the finally block, or this write would
    // be recorded into a dead transaction.
    await kb.writeConcept("/later.md", fm("Later"), "# Later\n", "Added Later.");
    expect(await exists("later.md")).toBe(true);
    expect(await read("index.md")).toContain("Later");
  });
});

describe("KnowledgeBase.transaction — isolation", () => {
  it("does not journal writes made outside the transaction", async () => {
    // Concurrency guard: a standalone write must not be reverted by an
    // unrelated failing transaction.
    const failing = kb
      .transaction(async () => {
        await kb.writeConcept("/inside.md", fm("Inside"), "# Inside\n", "Added Inside.");
        await new Promise((r) => setTimeout(r, 20));
        throw new Error("boom");
      })
      .catch(() => undefined);

    const outside = kb.writeConcept("/outside.md", fm("Outside"), "# Outside\n", "Added Outside.");

    await Promise.all([failing, outside]);

    expect(await exists("inside.md")).toBe(false);
    expect(await exists("outside.md")).toBe(true);
  });

  it("serializes overlapping transactions rather than interleaving journals", async () => {
    const order: string[] = [];

    const first = kb.transaction(async () => {
      order.push("first:start");
      await new Promise((r) => setTimeout(r, 30));
      await kb.writeConcept("/one.md", fm("One"), "# One\n", "Added One.");
      order.push("first:end");
    });

    const second = kb.transaction(async () => {
      order.push("second:start");
      await kb.writeConcept("/two.md", fm("Two"), "# Two\n", "Added Two.");
      order.push("second:end");
    });

    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(await exists("one.md")).toBe(true);
    expect(await exists("two.md")).toBe(true);
  });

  it("releases the write lock when a transaction throws", async () => {
    await kb.transaction(async () => {
      throw new Error("boom");
    }).catch(() => undefined);

    // Would hang if the lock leaked on the error path.
    await expect(
      kb.transaction(async () => {
        await kb.writeConcept("/after.md", fm("After"), "# After\n", "Added After.");
      })
    ).resolves.toBeUndefined();
    expect(await exists("after.md")).toBe(true);
  });

  it("reports inTransaction only inside the transaction scope", async () => {
    expect(kb.inTransaction).toBe(false);
    await kb.transaction(async () => {
      expect(kb.inTransaction).toBe(true);
    });
    expect(kb.inTransaction).toBe(false);
  });
});
