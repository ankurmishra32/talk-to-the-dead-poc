import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ollamaAdapter } from "../lib/llm/ollama";
import { parseSseEvent } from "../lib/sse";

const encoder = new TextEncoder();

/** A fetch Response whose body yields `chunks`, optionally then erroring. */
function bodyResponse(chunks: string[], opts: { errorAfter?: Error; status?: number } = {}) {
  // Chunks are delivered one per pull, so an error after them doesn't discard
  // ones already queued (controller.error() drops the queue).
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else if (opts.errorAfter) {
        controller.error(opts.errorAfter);
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, { status: opts.status ?? 200 });
}

/** A body that yields `first`, then waits until the fetch signal aborts. */
function abortableResponse(first: string[], signal: AbortSignal) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of first) controller.enqueue(encoder.encode(c));
      signal.addEventListener("abort", () =>
        controller.error(new DOMException("The operation was aborted.", "AbortError"))
      );
    },
  });
  return new Response(body, { status: 200 });
}

async function readEvents(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out
    .split("\n\n")
    .filter(Boolean)
    .map((b) => parseSseEvent(b)!);
}

const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;
const delta = (content: string) => line({ message: { content }, done: false });
const req = { system: "SYS", messages: [{ role: "user" as const, content: "hi" }] };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  delete process.env.OLLAMA_HOST;
  delete process.env.OLLAMA_MODEL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.OLLAMA_HOST;
  delete process.env.OLLAMA_MODEL;
});

describe("ollamaAdapter request", () => {
  it("posts a streaming chat with the system message first, using defaults", async () => {
    fetchMock.mockResolvedValue(bodyResponse([line({ done: true })]));
    const r = await ollamaAdapter.streamChat(req, new AbortController().signal);
    await readEvents(r.stream);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/chat");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      model: "llama3.2",
      stream: true,
      messages: [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }],
    });
  });

  it("uses OLLAMA_HOST and OLLAMA_MODEL", async () => {
    process.env.OLLAMA_HOST = "http://gpu:9999";
    process.env.OLLAMA_MODEL = "minimax";
    fetchMock.mockResolvedValue(bodyResponse([line({ done: true })]));
    const r = await ollamaAdapter.streamChat(req, new AbortController().signal);
    await readEvents(r.stream);
    expect(fetchMock.mock.calls[0][0]).toBe("http://gpu:9999/api/chat");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("minimax");
  });
});

describe("ollamaAdapter streaming", () => {
  it("emits deltas then done, and resolves the full reply as completed", async () => {
    fetchMock.mockResolvedValue(bodyResponse([delta("Hel"), delta("lo"), line({ done: true })]));
    const r = await ollamaAdapter.streamChat(req, new AbortController().signal);
    const events = await readEvents(r.stream);
    expect(events.map((e) => e.event)).toEqual(["delta", "delta", "done"]);
    expect(events[2].data).toEqual({ reply: "Hello" });
    expect(await r.finalReply).toBe("Hello");
    expect(await r.completed).toBe(true);
  });

  it("handles an NDJSON record split across chunks", async () => {
    const rec = delta("split");
    fetchMock.mockResolvedValue(bodyResponse([rec.slice(0, 10), rec.slice(10), line({ done: true })]));
    const r = await ollamaAdapter.streamChat(req, new AbortController().signal);
    await readEvents(r.stream);
    expect(await r.finalReply).toBe("split");
  });

  it("skips malformed lines", async () => {
    fetchMock.mockResolvedValue(bodyResponse(["not json\n", delta("ok"), line({ done: true })]));
    const r = await ollamaAdapter.streamChat(req, new AbortController().signal);
    const events = await readEvents(r.stream);
    expect(events.map((e) => e.event)).toEqual(["delta", "done"]);
    expect(await r.completed).toBe(true);
  });

  it("turns an error record into an error event and marks the reply incomplete", async () => {
    fetchMock.mockResolvedValue(bodyResponse([delta("par"), line({ error: "model crashed" })]));
    const r = await ollamaAdapter.streamChat(req, new AbortController().signal);
    const events = await readEvents(r.stream);
    expect(events.map((e) => e.event)).toEqual(["delta", "error"]);
    expect(await r.finalReply).toBe("par");
    expect(await r.completed).toBe(false);
  });

  it("treats a stream that ends without a done record as truncated", async () => {
    fetchMock.mockResolvedValue(bodyResponse([delta("cut")]));
    const r = await ollamaAdapter.streamChat(req, new AbortController().signal);
    const events = await readEvents(r.stream);
    expect(events.at(-1)!.event).toBe("error");
    expect(await r.finalReply).toBe("cut");
    expect(await r.completed).toBe(false);
  });

  // Regression (fixed today): the NDJSON parser only handles records followed by "\n". If the final
  // `{"done":true}` record arrives without a trailing newline, it stays in the
  // buffer, the stream end is treated as truncated, and a complete reply is
  // reported as cut off (and not saved).
  it("accepts a final done record without a trailing newline", async () => {
    fetchMock.mockResolvedValue(bodyResponse([delta("Hi"), JSON.stringify({ done: true })]));
    const r = await ollamaAdapter.streamChat(req, new AbortController().signal);
    const events = await readEvents(r.stream);
    expect(events.map((e) => e.event)).toEqual(["delta", "done"]);
    expect(await r.completed).toBe(true);
  });

  // Regression (fixed today): content carried on the done record itself is dropped. Ollama normally
  // sends an empty message there, but OpenAI-style proxies (and some Ollama
  // versions with `think`/tool output) put the last tokens on the final record.
  it("keeps content that arrives on the done record", async () => {
    fetchMock.mockResolvedValue(
      bodyResponse([delta("Hel"), line({ message: { content: "lo" }, done: true })])
    );
    const r = await ollamaAdapter.streamChat(req, new AbortController().signal);
    await readEvents(r.stream);
    expect(await r.finalReply).toBe("Hello");
  });

  it("reports a transport error mid-stream as incomplete", async () => {
    fetchMock.mockResolvedValue(bodyResponse([delta("par")], { errorAfter: new Error("socket hang up") }));
    const r = await ollamaAdapter.streamChat(req, new AbortController().signal);
    const events = await readEvents(r.stream);
    expect(events.at(-1)!.event).toBe("error");
    expect(await r.finalReply).toBe("par");
    expect(await r.completed).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  it("on abort: keeps the partial reply, marks it incomplete, logs info not error", async () => {
    const ac = new AbortController();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      abortableResponse([delta("part")], init.signal as AbortSignal)
    );
    const r = await ollamaAdapter.streamChat(req, ac.signal);
    const reader = r.stream.getReader();
    await reader.read(); // first delta
    ac.abort();
    while (!(await reader.read()).done) {
      // drain
    }
    expect(await r.finalReply).toBe("part");
    expect(await r.completed).toBe(false);
    expect(console.info).toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("on consumer cancel: resolves finalReply/completed and cancels upstream", async () => {
    let upstreamCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(delta("x")));
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    fetchMock.mockResolvedValue(new Response(body));
    const r = await ollamaAdapter.streamChat(req, new AbortController().signal);
    const reader = r.stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(await r.completed).toBe(false);
    expect(await r.finalReply).toBe("x");
    expect(upstreamCancelled).toBe(true);
  });
});

describe("ollamaAdapter failures before streaming", () => {
  it("returns an error stream when Ollama is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const r = await ollamaAdapter.streamChat(req, new AbortController().signal);
    const events = await readEvents(r.stream);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("error");
    expect(await r.finalReply).toBe("");
    expect(await r.completed).toBe(false);
  });

  it("returns an error stream on a non-OK status without leaking the body", async () => {
    fetchMock.mockResolvedValue(new Response("model 'x' not found", { status: 404 }));
    const r = await ollamaAdapter.streamChat(req, new AbortController().signal);
    const events = await readEvents(r.stream);
    expect(events[0].event).toBe("error");
    expect(JSON.stringify(events[0].data)).not.toContain("not found");
    expect(await r.completed).toBe(false);
  });
});
