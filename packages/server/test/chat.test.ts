import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { KnowledgeBase } from "@understory/core";

// streamChat is the seam: these tests are about the HTTP handler's failure
// behaviour, not the agent loop, so the agent is always mocked.
const streamChat = vi.hoisted(() => vi.fn());
vi.mock("@understory/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  streamChat,
}));

const { chatRouter } = await import("../src/api/chat.js");

let server: Server;
let baseUrl: string;

function start(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/api", chatRouter({} as KnowledgeBase));
  return new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

function post(body: unknown) {
  return fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validMessages = [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }];

/** Minimal stand-in for a streamText result. */
function fakeStream(response: Response) {
  return { result: { toUIMessageStreamResponse: () => response }, filesChanged: new Set() };
}

beforeEach(async () => {
  streamChat.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  await start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("POST /api/chat — validation (phase 1)", () => {
  it("rejects a missing or non-array messages field with 400 JSON", async () => {
    for (const body of [{}, { messages: "nope" }, { messages: 5 }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/must be an array/);
    }
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("rejects an empty conversation with 400", async () => {
    const res = await post({ messages: [] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/must not be empty/);
  });

  it("rejects an over-long conversation with 413", async () => {
    const messages = Array.from({ length: 201 }, (_, i) => ({
      id: String(i),
      role: "user",
      parts: [{ type: "text", text: "x" }],
    }));
    const res = await post({ messages });
    expect(res.status).toBe(413);
  });

  it("rejects a non-string model with 400", async () => {
    const res = await post({ messages: validMessages, model: 7 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/model must be a string/);
  });

  it("returns 400 JSON — not an HTML stack trace — for malformed message parts", async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ id: "1", role: "wizard", parts: [] }] }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });
});

describe("POST /api/chat — setup failure (phase 1)", () => {
  it("returns 500 JSON when the agent fails before streaming", async () => {
    streamChat.mockRejectedValue(new Error("model discovery failed"));

    const res = await post({ messages: validMessages });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "model discovery failed" });
  });

  it("does not leave the connection hanging on setup failure", async () => {
    streamChat.mockRejectedValue(new Error("boom"));
    // A hung response would time out rather than resolve.
    await expect(post({ messages: validMessages })).resolves.toBeDefined();
  });
});

describe("POST /api/chat — streaming (phase 2)", () => {
  it("passes the stream through and preserves headers", async () => {
    streamChat.mockResolvedValue(
      fakeStream(
        new Response("data: hello\n\n", {
          status: 200,
          headers: { "x-vercel-ai-ui-message-stream": "v1" },
        })
      )
    );

    const res = await post({ messages: validMessages });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    expect(await res.text()).toBe("data: hello\n\n");
  });

  it("surfaces a mid-stream error through onError instead of a bare truncation", async () => {
    const captured: { onError?: (e: unknown) => string } = {};
    streamChat.mockResolvedValue({
      result: {
        toUIMessageStreamResponse: (opts: { onError: (e: unknown) => string }) => {
          captured.onError = opts.onError;
          return new Response("data: partial\n\n", { status: 200 });
        },
      },
      filesChanged: new Set(),
    });

    await post({ messages: validMessages });

    expect(captured.onError).toBeTypeOf("function");
    // The message is returned so the SDK writes it into the stream as an
    // error part; useChat renders that instead of silently stalling.
    expect(captured.onError!(new Error("provider died"))).toBe("provider died");
  });

  it("ends the response cleanly when the stream body throws mid-flight", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        controller.error(new Error("socket reset"));
      },
    });
    streamChat.mockResolvedValue(fakeStream(new Response(body, { status: 200 })));

    const res = await post({ messages: validMessages });
    expect(res.status).toBe(200);
    // Reading the truncated body must not hang; the handler called res.end().
    await expect(res.text().catch(() => "")).resolves.toBeDefined();
  });
});

describe("POST /api/chat — client disconnect (phase 3)", () => {
  it("aborts the agent when the client goes away", async () => {
    let signal: AbortSignal | undefined;
    streamChat.mockImplementation((_kb, _msgs, opts) => {
      signal = opts.abortSignal;
      // Never-ending stream, so the client aborts first.
      return Promise.resolve(
        fakeStream(new Response(new ReadableStream({ start() {} }), { status: 200 }))
      );
    });

    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: validMessages }),
      signal: controller.signal,
    }).catch(() => undefined);

    await vi.waitFor(() => expect(signal).toBeDefined());
    controller.abort();
    await pending;

    await vi.waitFor(() => expect(signal!.aborted).toBe(true));
  });
});
