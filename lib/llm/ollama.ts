// Ollama implementation of LlmAdapter.
//
// Today the equivalent code lives inline in pages/api/chat.ts:
//   1. fetch(`${OLLAMA_HOST}/api/chat`) with stream:true
//   2. Read NDJSON lines from Ollama
//   3. Re-emit each line as the server's SSE vocabulary:
//        {"message":{"content":"<delta>"},"done":false}  -> "event: delta"
//        {"done":true,...}                                -> "event: done"
//        {"error":"..."}                                  -> "event: error"
//
// This module owns all three. The chat route just calls streamChat
// and pipes the resulting stream to the client. The stream is
// already SSE-formatted bytes, so the route doesn't need to know
// what an NDJSON line is. The route also gets a finalReply promise
// for persistence, so it doesn't need to re-parse the SSE bytes it
// just wrote.

import type { LlmAdapter, ChatRequest, LlmStream } from "./types";

function getOllamaHost(): string {
  return process.env.OLLAMA_HOST || "http://localhost:11434";
}

function getOllamaModel(): string {
  return process.env.OLLAMA_MODEL || "llama3.2";
}

const SSE_DELTA = (delta: string) =>
  new TextEncoder().encode(`event: delta\ndata: ${JSON.stringify({ delta })}\n\n`);
const SSE_DONE = (reply: string) =>
  new TextEncoder().encode(`event: done\ndata: ${JSON.stringify({ reply })}\n\n`);
const SSE_ERROR = (error: string) =>
  new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);

export const ollamaAdapter: LlmAdapter = {
  async streamChat(req: ChatRequest, signal: AbortSignal): Promise<LlmStream> {
    let ollamaRes: globalThis.Response;
    try {
      ollamaRes = await fetch(`${getOllamaHost()}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: getOllamaModel(),
          stream: true,
          messages: [{ role: "system", content: req.system }, ...req.messages],
        }),
        signal,
      });
    } catch (err) {
      // Network-level failure to reach Ollama. Build a stream that
      // emits an error event and resolves finalReply to "".
      const message = err instanceof Error ? err.message : "Unknown network error";
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(SSE_ERROR(`Could not reach Ollama: ${message}`));
          controller.close();
        },
      });
      return {
        stream,
        finalReply: Promise.resolve(""),
        completed: Promise.resolve(false),
      };
    }

    if (!ollamaRes.ok || !ollamaRes.body) {
      let detail = "";
      try {
        detail = await ollamaRes.text();
      } catch {
        // ignore
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(SSE_ERROR(`Ollama responded ${ollamaRes.status}: ${detail || "(no body)"}`));
          controller.close();
        },
      });
      return {
        stream,
        finalReply: Promise.resolve(""),
        completed: Promise.resolve(false),
      };
    }

    // The transform stream consumes Ollama's NDJSON and emits SSE bytes.
    // The route just pipes this stream to res.
    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalReply = "";

    // finalReply resolves when the byte stream closes, to whatever
    // accumulated text was emitted. Resolves to "" on error paths.
    let resolveFinal!: (reply: string) => void;
    const finalReply = new Promise<string>((resolve) => {
      resolveFinal = resolve;
    });
    let resolveCompleted!: (completed: boolean) => void;
    const completed = new Promise<boolean>((resolve) => {
      resolveCompleted = resolve;
    });

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              // A normal Ollama response ends with a done record. Without
              // one, the accumulated text may be a truncated reply.
              try {
                controller.enqueue(SSE_ERROR("Ollama ended before completing the reply."));
                controller.close();
              } catch {
                // already closed
              }
              resolveFinal(totalReply);
              resolveCompleted(false);
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const parsed = JSON.parse(trimmed) as {
                  message?: { content?: string };
                  done?: boolean;
                  error?: string;
                };
                if (parsed.error) {
                  try {
                    controller.enqueue(SSE_ERROR(parsed.error));
                    controller.close();
                  } catch {
                    // already closed
                  }
                  resolveFinal(totalReply);
                  resolveCompleted(false);
                  return;
                }
                if (parsed.done) {
                  try {
                    controller.enqueue(SSE_DONE(totalReply));
                    controller.close();
                  } catch {
                    // already closed
                  }
                  resolveFinal(totalReply);
                  resolveCompleted(true);
                  return;
                }
                const delta = parsed.message?.content ?? "";
                if (delta) {
                  totalReply += delta;
                  controller.enqueue(SSE_DELTA(delta));
                }
              } catch {
                // Malformed NDJSON line — skip. Ollama should never
                // emit these but if it does, dropping them is safer
                // than crashing the stream.
              }
            }
          }
        } catch (err) {
          // Transport error mid-stream (client disconnect, network
          // drop). Emit error event if we can; otherwise the route
          // will see the stream close and surface a generic message.
          const message = err instanceof Error ? err.message : "Stream interrupted";
          try {
            controller.enqueue(SSE_ERROR(message));
            controller.close();
          } catch {
            // Already closed.
          }
          resolveFinal(totalReply);
          resolveCompleted(false);
        }
      },
      cancel() {
        // Client disconnected. Cancel the upstream read so Ollama
        // stops generating tokens. Keep the partial text available to
        // the caller, but mark the stream incomplete so it isn't saved
        // as a completed conversation turn.
        resolveFinal(totalReply);
        resolveCompleted(false);
        reader.cancel().catch(() => {});
      },
    });

    return { stream, finalReply, completed };
  },
};
