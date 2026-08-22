import express, { type Router } from "express";
import { convertToModelMessages, type UIMessage } from "ai";
import { streamChat, type KnowledgeBase } from "@understory/core";

interface ChatBody {
  messages: UIMessage[];
  model?: string;
}

/** Cap on turns accepted per request — the UI never sends more than a session. */
const MAX_MESSAGES = 200;

/**
 * Streaming chat endpoint for the web UI (`useChat`). Full agent toolset —
 * the chat exists to exercise the same agent the MCP server uses.
 *
 * Failure handling here is deliberately split into three phases, because
 * once the first byte is written the status code is no longer negotiable:
 *
 *   1. before streaming  → validation + setup errors become clean JSON 4xx/5xx
 *   2. during streaming  → surfaced as an error part in the UI message stream
 *                          (useChat renders it) rather than a truncated body
 *   3. client disconnect → abort the agent loop instead of burning tokens on
 *                          a stream nobody is reading
 */
export function chatRouter(kb: KnowledgeBase): Router {
  const router = express.Router();

  router.post("/chat", async (req, res) => {
    // ── Phase 1: validation. Nothing written yet, so real status codes work.
    const body = req.body as ChatBody | undefined;
    if (!body || !Array.isArray(body.messages)) {
      res.status(400).json({ error: "body.messages must be an array of UI messages" });
      return;
    }
    if (body.messages.length === 0) {
      res.status(400).json({ error: "body.messages must not be empty" });
      return;
    }
    if (body.messages.length > MAX_MESSAGES) {
      res.status(413).json({ error: `too many messages (max ${MAX_MESSAGES})` });
      return;
    }
    if (body.model !== undefined && typeof body.model !== "string") {
      res.status(400).json({ error: "body.model must be a string" });
      return;
    }

    // Client disconnect aborts the agent loop. Registered before the first
    // await so a fast disconnect can't slip through.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    let stream: Awaited<ReturnType<typeof streamChat>>["result"];
    try {
      // convertToModelMessages throws MessageConversionError on malformed
      // parts — that's a client bug, not a server fault, hence 400.
      const modelMessages = convertToModelMessages(body.messages);
      ({ result: stream } = await streamChat(kb, modelMessages, {
        model: body.model,
        abortSignal: abort.signal,
      }));
    } catch (err) {
      const message = (err as Error)?.message ?? "chat failed";
      const isConversion = (err as Error)?.name === "AI_MessageConversionError";
      console.error("[understory] chat setup failed:", message);
      res.status(isConversion ? 400 : 500).json({ error: message });
      return;
    }

    // ── Phase 2: streaming. Headers are about to go out; from here on a
    // failure can only be reported inside the stream body.
    try {
      const response = stream.toUIMessageStreamResponse({
        onError: (error) => {
          const message = (error as Error)?.message ?? "chat stream failed";
          console.error("[understory] chat stream error:", message);
          return message;
        },
      });

      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));

      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          if (res.writableEnded) break;
          // Respect backpressure — write() returning false and being ignored
          // is how a slow client turns into unbounded server memory.
          if (!res.write(chunk)) {
            await once(res, "drain");
          }
        }
      }
      res.end();
    } catch (err) {
      // Transport-level failure mid-stream (socket reset, aborted request).
      // Status is already sent; all we can do is log and close cleanly so the
      // connection doesn't hang open.
      console.error("[understory] chat stream aborted:", (err as Error)?.message);
      if (!res.writableEnded) res.end();
    }
  });

  return router;
}

/** Promise wrapper for a one-shot stream event, without pulling in node:events typings noise. */
function once(emitter: NodeJS.WritableStream, event: string): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}
