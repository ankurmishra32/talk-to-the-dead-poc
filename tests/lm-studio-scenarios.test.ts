import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { lmStudioAdapter } from "../lib/llm/lm-studio";
import { parseSseEvent } from "../lib/sse";

const encoder = new TextEncoder();

/** Response whose body yields one chunk per pull, then closes or errors. */
function bodyResponse(chunks: string[], opts: { errorAfter?: Error } = {}) {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else if (opts.errorAfter) controller.error(opts.errorAfter);
      else controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

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

const chunk = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const DONE = "data: [DONE]\n\n";
const req = { system: "SYS", messages: [{ role: "user" as const, content: "hi" }] };

let fetchMock: ReturnType<typeof vi.fn>;
const ENV = ["LM_STUDIO_BASE_URL", "LM_STUDIO_MODEL", "LM_STUDIO_API_KEY"];

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const k of ENV) delete process.env[k];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV) delete process.env[k];
});

describe("lmStudioAdapter request", () => {
  it("posts to /chat/completions with defaults and no auth header", async () => {
    fetchMock.mockResolvedValue(bodyResponse([DONE]));
    const r = await lmStudioAdapter.streamChat(req, new AbortController().signal);
    await readEvents(r.stream);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:1234/v1/chat/completions");
    expect(init.headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(init.body)).toEqual({
      model: "qwen3.5:9b",
      stream: true,
      messages: [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }],
    });
  });

  it("strips a trailing slash from the base URL and sends the API key", async () => {
    process.env.LM_STUDIO_BASE_URL = "https://llm.example/v1/";
    process.env.LM_STUDIO_MODEL = "m";
    process.env.LM_STUDIO_API_KEY = "sk-1";
    fetchMock.mockResolvedValue(bodyResponse([DONE]));
    const r = await lmStudioAdapter.streamChat(req, new AbortController().signal);
    await readEvents(r.stream);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://llm.example/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-1");
    expect(JSON.parse(init.body).model).toBe("m");
  });
});

describe("lmStudioAdapter streaming", () => {
  it("emits deltas then done, and resolves the full reply as completed", async () => {
    fetchMock.mockResolvedValue(bodyResponse([chunk("Hel"), chunk("lo"), DONE]));
    const r = await lmStudioAdapter.streamChat(req, new AbortController().signal);
    const events = await readEvents(r.stream);
    expect(events.map((e) => e.event)).toEqual(["delta", "delta", "done"]);
    expect(events[2].data).toEqual({ reply: "Hello" });
    expect(await r.completed).toBe(true);
  });

  it("handles an event split across chunks", async () => {
    const c = chunk("split");
    fetchMock.mockResolvedValue(bodyResponse([c.slice(0, 7), c.slice(7), DONE]));
    const r = await lmStudioAdapter.streamChat(req, new AbortController().signal);
    await readEvents(r.stream);
    expect(await r.finalReply).toBe("split");
  });

  it("ignores keep-alive comments, empty deltas and role-only chunks", async () => {
    fetchMock.mockResolvedValue(
      bodyResponse([
        ": ping\n\n",
        `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`,
        chunk(""),
        chunk("ok"),
        DONE,
      ])
    );
    const r = await lmStudioAdapter.streamChat(req, new AbortController().signal);
    const events = await readEvents(r.stream);
    expect(events.map((e) => e.event)).toEqual(["delta", "done"]);
  });

  it("skips malformed JSON payloads", async () => {
    fetchMock.mockResolvedValue(bodyResponse(["data: {not json\n\n", chunk("ok"), DONE]));
    const r = await lmStudioAdapter.streamChat(req, new AbortController().signal);
    await readEvents(r.stream);
    expect(await r.finalReply).toBe("ok");
    expect(await r.completed).toBe(true);
  });

  it.each([
    ["string", { error: "context length exceeded" }],
    ["object", { error: { message: "context length exceeded" } }],
  ])("turns an %s error payload into an error event", async (_kind, payload) => {
    fetchMock.mockResolvedValue(bodyResponse([chunk("par"), `data: ${JSON.stringify(payload)}\n\n`]));
    const r = await lmStudioAdapter.streamChat(req, new AbortController().signal);
    const events = await readEvents(r.stream);
    expect(events.map((e) => e.event)).toEqual(["delta", "error"]);
    expect(JSON.stringify(events[1].data)).not.toContain("context length");
    expect(await r.finalReply).toBe("par");
    expect(await r.completed).toBe(false);
  });

  it("treats a stream without [DONE] as truncated", async () => {
    fetchMock.mockResolvedValue(bodyResponse([chunk("cut")]));
    const r = await lmStudioAdapter.streamChat(req, new AbortController().signal);
    const events = await readEvents(r.stream);
    expect(events.at(-1)!.event).toBe("error");
    expect(await r.completed).toBe(false);
  });

  // Regression (fixed today): like the Ollama parser, events are only processed once a blank line
  // ("\n\n") follows them. A final "data: [DONE]" without the trailing blank
  // line is left in the buffer at EOF and a complete reply is reported as cut
  // off (and not saved).
  it("accepts a final [DONE] without a trailing blank line", async () => {
    fetchMock.mockResolvedValue(bodyResponse([chunk("Hi"), "data: [DONE]"]));
    const r = await lmStudioAdapter.streamChat(req, new AbortController().signal);
    const events = await readEvents(r.stream);
    expect(events.map((e) => e.event)).toEqual(["delta", "done"]);
    expect(await r.completed).toBe(true);
  });

  it("reports a transport error mid-stream as incomplete", async () => {
    fetchMock.mockResolvedValue(bodyResponse([chunk("par")], { errorAfter: new Error("ECONNRESET") }));
    const r = await lmStudioAdapter.streamChat(req, new AbortController().signal);
    const events = await readEvents(r.stream);
    expect(events.at(-1)!.event).toBe("error");
    expect(await r.finalReply).toBe("par");
    expect(await r.completed).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  it("on abort: keeps the partial reply, marks it incomplete, logs info not error", async () => {
    const ac = new AbortController();
    fetchMock.mockImplementation(async (_u: string, init: RequestInit) =>
      abortableResponse([chunk("part")], init.signal as AbortSignal)
    );
    const r = await lmStudioAdapter.streamChat(req, ac.signal);
    const reader = r.stream.getReader();
    await reader.read();
    ac.abort();
    while (!(await reader.read()).done) {
      // drain
    }
    expect(await r.finalReply).toBe("part");
    expect(await r.completed).toBe(false);
    expect(console.info).toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("on consumer cancel: resolves and cancels upstream", async () => {
    let upstreamCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunk("x")));
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    fetchMock.mockResolvedValue(new Response(body));
    const r = await lmStudioAdapter.streamChat(req, new AbortController().signal);
    const reader = r.stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(await r.completed).toBe(false);
    expect(upstreamCancelled).toBe(true);
  });
});

describe("lmStudioAdapter failures before streaming", () => {
  it("returns an error stream when unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const r = await lmStudioAdapter.streamChat(req, new AbortController().signal);
    const events = await readEvents(r.stream);
    expect(events.map((e) => e.event)).toEqual(["error"]);
    expect(await r.finalReply).toBe("");
    expect(await r.completed).toBe(false);
  });

  it("returns an error stream on a non-OK status", async () => {
    fetchMock.mockResolvedValue(new Response("no model loaded", { status: 400 }));
    const r = await lmStudioAdapter.streamChat(req, new AbortController().signal);
    const events = await readEvents(r.stream);
    expect(events[0].event).toBe("error");
    expect(JSON.stringify(events[0].data)).not.toContain("no model");
    expect(await r.completed).toBe(false);
  });
});
