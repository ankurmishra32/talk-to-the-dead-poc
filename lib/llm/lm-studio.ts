// LM Studio implementation of LlmAdapter.
//
// LM Studio exposes an OpenAI-compatible Chat Completions endpoint. Its
// streamed response is SSE, where each `data:` payload contains an OpenAI
// chat-completion chunk and the final payload is `data: [DONE]`.

import type { ChatRequest, LlmAdapter, LlmStream } from "./types";

function getBaseUrl(): string {
  return (process.env.LM_STUDIO_BASE_URL || "http://localhost:1234/v1").replace(/\/$/, "");
}

function getModel(): string {
  return process.env.LM_STUDIO_MODEL || "qwen3.5:9b";
}

function getHeaders(): HeadersInit {
  const apiKey = process.env.LM_STUDIO_API_KEY;
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

const SSE_DELTA = (delta: string) =>
  new TextEncoder().encode(`event: delta\ndata: ${JSON.stringify({ delta })}\n\n`);
const SSE_DONE = (reply: string) =>
  new TextEncoder().encode(`event: done\ndata: ${JSON.stringify({ reply })}\n\n`);
const SSE_ERROR = (error: string) =>
  new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);

function eventData(block: string): string {
  return block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
}

export const lmStudioAdapter: LlmAdapter = {
  async streamChat(req: ChatRequest, signal: AbortSignal): Promise<LlmStream> {
    let response: globalThis.Response;
    try {
      response = await fetch(`${getBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          model: getModel(),
          stream: true,
          messages: [{ role: "system", content: req.system }, ...req.messages],
        }),
        signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown network error";
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(SSE_ERROR(`Could not reach LM Studio: ${message}`));
          controller.close();
        },
      });
      return { stream, finalReply: Promise.resolve(""), completed: Promise.resolve(false) };
    }

    if (!response.ok || !response.body) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        // Ignore an unreadable error body.
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            SSE_ERROR(`LM Studio responded ${response.status}: ${detail || "(no body)"}`)
          );
          controller.close();
        },
      });
      return { stream, finalReply: Promise.resolve(""), completed: Promise.resolve(false) };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalReply = "";

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
              try {
                controller.enqueue(SSE_ERROR("LM Studio ended before completing the reply."));
                controller.close();
              } catch {
                // The client may already be disconnected.
              }
              resolveFinal(totalReply);
              resolveCompleted(false);
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            let separatorIndex: number;
            while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
              const block = buffer.slice(0, separatorIndex);
              buffer = buffer.slice(separatorIndex + 2);
              const data = eventData(block);
              if (!data) continue;

              if (data === "[DONE]") {
                try {
                  controller.enqueue(SSE_DONE(totalReply));
                  controller.close();
                } catch {
                  // The client may already be disconnected.
                }
                resolveFinal(totalReply);
                resolveCompleted(true);
                return;
              }

              try {
                const chunk = JSON.parse(data) as {
                  choices?: Array<{ delta?: { content?: string } }>;
                  error?: { message?: string } | string;
                };
                if (chunk.error) {
                  const error =
                    typeof chunk.error === "string"
                      ? chunk.error
                      : chunk.error.message || "LM Studio stream error.";
                  controller.enqueue(SSE_ERROR(error));
                  controller.close();
                  resolveFinal(totalReply);
                  resolveCompleted(false);
                  return;
                }

                const delta = chunk.choices?.[0]?.delta?.content;
                if (delta) {
                  totalReply += delta;
                  controller.enqueue(SSE_DELTA(delta));
                }
              } catch {
                // Ignore non-JSON keep-alives or malformed chunks. The
                // provider's final [DONE] event still decides completion.
              }
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Stream interrupted";
          try {
            controller.enqueue(SSE_ERROR(message));
            controller.close();
          } catch {
            // The client may already be disconnected.
          }
          resolveFinal(totalReply);
          resolveCompleted(false);
        }
      },
      cancel() {
        resolveFinal(totalReply);
        resolveCompleted(false);
        reader.cancel().catch(() => {});
      },
    });

    return { stream, finalReply, completed };
  },
};
