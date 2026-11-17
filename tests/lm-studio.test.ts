import { describe, it, expect, vi, afterEach } from "vitest";
import { lmStudioAdapter } from "../lib/llm/lm-studio";
import { parseSseEvent } from "../lib/sse";

// Builds a fake fetch Response whose body yields the given string chunks.
function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

const chunk = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lmStudioAdapter", () => {
  it("parses an upstream stream that uses CRLF line endings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamingResponse([
          `${chunk("Hel")}\r\n\r\n`,
          // A CRLF pair split across two network chunks.
          `${chunk("lo")}\r\n\r`,
          `\n`,
          `data: [DONE]\r\n\r\n`,
        ])
      )
    );

    const result = await lmStudioAdapter.streamChat(
      { system: "s", messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal
    );
    const sse = await readAll(result.stream);
    const events = sse
      .split("\n\n")
      .filter(Boolean)
      .map((block) => parseSseEvent(block));

    expect(events.map((e) => e?.event)).toEqual(["delta", "delta", "done"]);
    expect(await result.finalReply).toBe("Hello");
    expect(await result.completed).toBe(true);
  });
});
