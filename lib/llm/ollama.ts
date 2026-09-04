// Ollama implementation of LlmAdapter.
//
// Uses Ollama's NDJSON chat stream (/api/chat with stream:true) and
// re-emits each record as the server's SSE event vocabulary:
//   {"message":{"content":"<delta>"},"done":false}  -> "event: delta"
//   {"done":true,...}                                -> "event: done"
//   {"error":"..."}                                  -> "event: error"
//
// The chat route just calls streamChat and pipes the resulting SSE bytes
// to the client, and reads finalReply for persistence.

import type { LlmAdapter, ChatRequest, LlmStream } from "./types";
import { sseDelta, sseDone, sseError } from "./sse";

function getOllamaHost(): string {
  return process.env.OLLAMA_HOST || "http://localhost:11434";
}

function getOllamaModel(): string {
  return process.env.OLLAMA_MODEL || "llama3.2";
}

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
          controller.enqueue(sseError(`Could not reach Ollama: ${message}`));
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
          controller.enqueue(sseError(`Ollama responded ${ollamaRes.status}: ${detail || "(no body)"}`));
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
                controller.enqueue(sseError("Ollama ended before completing the reply."));
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
                    controller.enqueue(sseError(parsed.error));
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
                    controller.enqueue(sseDone(totalReply));
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
                  controller.enqueue(sseDelta(delta));
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
            controller.enqueue(sseError(message));
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
