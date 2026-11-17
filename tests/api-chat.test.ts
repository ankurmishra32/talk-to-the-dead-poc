// Scenario tests for the /api/chat route (pages/api/chat.ts).
//
// The route's collaborators (auth, Firestore, rate limiter, LLM adapter) are
// mocked; req/res are small fakes that behave like Node's IncomingMessage /
// ServerResponse for the parts the route uses, including the "close" event
// that signals a client disconnect.

import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

const mocks = vi.hoisted(() => ({
  verifyAccessToken: vi.fn(),
  getPersona: vi.fn(),
  listMemoriesForPersona: vi.fn(),
  appendConversationMessage: vi.fn(),
  checkRequestRate: vi.fn(),
  acquireStreamSlot: vi.fn(),
  releaseStreamSlot: vi.fn(),
  streamChat: vi.fn(),
}));

vi.mock("../lib/auth/server", () => ({
  authAdapter: { verifyAccessToken: mocks.verifyAccessToken },
}));
vi.mock("../lib/firestore", () => ({
  getPersona: mocks.getPersona,
  listMemoriesForPersona: mocks.listMemoriesForPersona,
  appendConversationMessage: mocks.appendConversationMessage,
}));
vi.mock("../lib/rate-limit", () => ({
  checkRequestRate: mocks.checkRequestRate,
  acquireStreamSlot: mocks.acquireStreamSlot,
  releaseStreamSlot: mocks.releaseStreamSlot,
}));
vi.mock("../lib/llm", () => ({
  llmAdapter: { streamChat: mocks.streamChat },
}));

import handler from "../pages/api/chat";

// ---------- fakes ----------

type FakeRes = EventEmitter & {
  statusCode: number;
  headers: Record<string, string>;
  jsonBody: unknown;
  writes: string[];
  writesAfterDisconnect: string[];
  writableEnded: boolean;
  destroyed: boolean;
  endCalls: number;
  setHeader(name: string, value: string): void;
  status(code: number): FakeRes;
  json(body: unknown): void;
  write(chunk: string | Uint8Array): boolean;
  flushHeaders(): void;
  end(): void;
  disconnect(): void;
};

function makeRes(): FakeRes {
  const res = new EventEmitter() as FakeRes;
  res.statusCode = 200;
  res.headers = {};
  res.jsonBody = undefined;
  res.writes = [];
  res.writesAfterDisconnect = [];
  res.writableEnded = false;
  res.destroyed = false;
  res.endCalls = 0;
  res.setHeader = (name, value) => {
    res.headers[name.toLowerCase()] = value;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.jsonBody = body;
    res.end();
  };
  res.write = (chunk) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (res.destroyed) {
      // A real ServerResponse silently drops these; record them as a smell.
      res.writesAfterDisconnect.push(text);
      return false;
    }
    res.writes.push(text);
    return true;
  };
  res.flushHeaders = () => {};
  res.end = () => {
    res.endCalls += 1;
    if (res.writableEnded) return;
    res.writableEnded = true;
    res.emit("finish");
    if (!res.destroyed) {
      res.destroyed = true;
      res.emit("close");
    }
  };
  res.disconnect = () => {
    if (res.destroyed) return;
    res.destroyed = true;
    res.emit("close");
  };
  return res;
}

function makeReq(overrides: Partial<{ method: string; body: unknown; headers: Record<string, string> }> = {}) {
  const req = new EventEmitter() as EventEmitter & {
    method: string;
    body: unknown;
    headers: Record<string, string>;
  };
  req.method = overrides.method ?? "POST";
  req.body = "body" in overrides ? overrides.body : validBody();
  req.headers = overrides.headers ?? { authorization: "Bearer token-1" };
  return req;
}

function validBody(extra: Partial<{ personaId: unknown; messages: unknown }> = {}) {
  return {
    personaId: "persona-1",
    messages: [{ role: "user", content: "hello" }],
    ...extra,
  };
}

async function call(req: ReturnType<typeof makeReq>, res: FakeRes) {
  await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
}

const enc = new TextEncoder();
const sseDelta = (d: string) => `event: delta\ndata: ${JSON.stringify({ delta: d })}\n\n`;
const sseDone = (r: string) => `event: done\ndata: ${JSON.stringify({ reply: r })}\n\n`;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An LLM stream that emits `chunks` then closes, with fixed outcome. */
function fixedLlm(chunks: string[], reply: string, completed: boolean) {
  return {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    }),
    finalReply: Promise.resolve(reply),
    completed: Promise.resolve(completed),
  };
}

/**
 * An LLM stream like the real adapters: emits some deltas, then waits until
 * the abort signal fires, then closes and reports the partial text as
 * incomplete. `onStarted` runs after the first delta has been pulled.
 */
function abortableLlm(signal: AbortSignal, firstDeltas: string[], onStarted: () => void) {
  const final = deferred<string>();
  const done = deferred<boolean>();
  let text = "";
  let step = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (step < firstDeltas.length) {
        text += firstDeltas[step];
        controller.enqueue(enc.encode(sseDelta(firstDeltas[step])));
        step += 1;
        if (step === firstDeltas.length) queueMicrotask(onStarted);
        return;
      }
      if (!signal.aborted) {
        await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
      }
      // Tokens generated after the client stopped reading ("in flight").
      text += " more";
      controller.enqueue(enc.encode(`event: error\ndata: {"error":"cut"}\n\n`));
      controller.close();
      final.resolve(text);
      done.resolve(false);
    },
  });
  return { stream, finalReply: final.promise, completed: done.promise };
}

const persona = { id: "persona-1", name: "Ammi", ownerId: "uid-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyAccessToken.mockResolvedValue({ uid: "uid-1", email: "a@b.c" });
  mocks.checkRequestRate.mockResolvedValue({ allowed: true, retryAfterSec: 0 });
  mocks.getPersona.mockResolvedValue(persona);
  mocks.listMemoriesForPersona.mockResolvedValue([]);
  mocks.acquireStreamSlot.mockResolvedValue({ acquired: true });
  mocks.releaseStreamSlot.mockResolvedValue(undefined);
  mocks.appendConversationMessage.mockResolvedValue("msg-42");
  mocks.streamChat.mockImplementation(async () =>
    fixedLlm([sseDelta("Hi "), sseDelta("there"), sseDone("Hi there")], "Hi there", true)
  );
});

// ---------- request validation ----------

describe("method and body validation", () => {
  it("rejects non-POST with 405 and an Allow header", async () => {
    const res = makeRes();
    await call(makeReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("POST");
    expect(mocks.verifyAccessToken).not.toHaveBeenCalled();
  });

  const bad400: Array<[string, unknown]> = [
    ["missing body", undefined],
    ["null body", null],
    ["missing personaId", { messages: [{ role: "user", content: "hi" }] }],
    ["non-string personaId", validBody({ personaId: 42 })],
    ["empty personaId", validBody({ personaId: "" })],
    ["whitespace personaId", validBody({ personaId: "   " })],
    ["non-array messages", validBody({ messages: "hi" })],
    ["empty messages", validBody({ messages: [] })],
    [
      "more than 200 messages",
      validBody({ messages: Array.from({ length: 201 }, () => ({ role: "user", content: "x" })) }),
    ],
    ["invalid role", validBody({ messages: [{ role: "system", content: "x" }] })],
    ["non-string content", validBody({ messages: [{ role: "user", content: 5 }] })],
    ["null entry", validBody({ messages: [null] })],
    [
      "last message from assistant",
      validBody({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }),
    ],
    ["last message empty", validBody({ messages: [{ role: "user", content: "   " }] })],
    ["last message over 4000 chars", validBody({ messages: [{ role: "user", content: "x".repeat(4001) }] })],
  ];

  it.each(bad400)("returns 400 for %s, before auth", async (_name, body) => {
    const res = makeRes();
    await call(makeReq({ body }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toHaveProperty("error");
    expect(mocks.verifyAccessToken).not.toHaveBeenCalled();
    expect(mocks.streamChat).not.toHaveBeenCalled();
  });

  it("accepts exactly 200 messages and a 4000-char last message", async () => {
    const messages = Array.from({ length: 199 }, () => ({ role: "assistant", content: "x" }));
    messages.push({ role: "user", content: "y".repeat(4000) });
    const res = makeRes();
    await call(makeReq({ body: validBody({ messages }) }), res);
    expect(res.statusCode).toBe(200);
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
  });

  it("accepts empty older messages (they are trimmed, not rejected)", async () => {
    const res = makeRes();
    await call(
      makeReq({
        body: validBody({
          messages: [
            { role: "assistant", content: "" },
            { role: "user", content: "hi" },
          ],
        }),
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    const sent = mocks.streamChat.mock.calls[0][0].messages;
    expect(sent).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("history sent to the LLM", () => {
  it("strips ids and other fields, forwarding only { role, content }", async () => {
    const res = makeRes();
    await call(
      makeReq({
        body: validBody({
          messages: [
            { id: "m1", createdAtMs: 1, role: "user", content: "q1" },
            { id: "m2", interrupted: true, role: "assistant", content: "a1" },
            { id: "m3", role: "user", content: "q2" },
          ],
        }),
      }),
      res
    );
    const sent = mocks.streamChat.mock.calls[0][0].messages;
    expect(sent).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
  });

  it("trims long history to 40 messages / 24000 chars, keeping the latest", async () => {
    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 150; i++) {
      messages.push({ role: i % 2 ? "assistant" : "user", content: `m${i}-` + "r".repeat(3000) });
    }
    messages.push({ role: "user", content: "latest" });
    const res = makeRes();
    await call(makeReq({ body: validBody({ messages }) }), res);
    expect(res.statusCode).toBe(200);
    const sent: Array<{ role: string; content: string }> = mocks.streamChat.mock.calls[0][0].messages;
    expect(sent.length).toBeLessThanOrEqual(40);
    expect(sent.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(24_000);
    expect(sent[sent.length - 1]).toEqual({ role: "user", content: "latest" });
  });

  it("passes a system prompt built from the persona", async () => {
    const res = makeRes();
    await call(makeReq(), res);
    const req = mocks.streamChat.mock.calls[0][0];
    expect(typeof req.system).toBe("string");
    expect(req.system).toContain("Ammi");
  });
});

// ---------- auth, rate limit, lookups ----------

describe("auth, rate limit, persona lookup", () => {
  it("returns 401 when the token is rejected", async () => {
    mocks.verifyAccessToken.mockRejectedValue(new Error("bad token"));
    const res = makeRes();
    await call(makeReq(), res);
    expect(res.statusCode).toBe(401);
    expect(mocks.checkRequestRate).not.toHaveBeenCalled();
  });

  it("passes the raw Authorization header (or empty string) to the adapter", async () => {
    const res = makeRes();
    await call(makeReq({ headers: {} }), res);
    expect(mocks.verifyAccessToken).toHaveBeenCalledWith("");
  });

  it("returns 429 with Retry-After when rate limited", async () => {
    mocks.checkRequestRate.mockResolvedValue({ allowed: false, retryAfterSec: 17 });
    const res = makeRes();
    await call(makeReq(), res);
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("17");
    expect(mocks.getPersona).not.toHaveBeenCalled();
    expect(mocks.acquireStreamSlot).not.toHaveBeenCalled();
  });

  it("returns 404 when the persona is missing or not owned", async () => {
    mocks.getPersona.mockResolvedValue(null);
    const res = makeRes();
    await call(makeReq(), res);
    expect(res.statusCode).toBe(404);
    expect(mocks.getPersona).toHaveBeenCalledWith("persona-1", "uid-1", "Bearer token-1");
    expect(mocks.acquireStreamSlot).not.toHaveBeenCalled();
  });

  it("returns 502 when reading the persona fails", async () => {
    mocks.getPersona.mockRejectedValue(new Error("firestore down"));
    const res = makeRes();
    await call(makeReq(), res);
    expect(res.statusCode).toBe(502);
    expect(mocks.acquireStreamSlot).not.toHaveBeenCalled();
  });

  it("returns 502 when listing memories fails", async () => {
    mocks.listMemoriesForPersona.mockRejectedValue(new Error("index missing"));
    const res = makeRes();
    await call(makeReq(), res);
    expect(res.statusCode).toBe(502);
    expect(mocks.acquireStreamSlot).not.toHaveBeenCalled();
  });

  it("requests the 20 most recent memories", async () => {
    const res = makeRes();
    await call(makeReq(), res);
    expect(mocks.listMemoriesForPersona).toHaveBeenCalledWith("persona-1", "uid-1", "Bearer token-1", 20);
  });

  it("returns 503 when no stream slot is available, without releasing", async () => {
    mocks.acquireStreamSlot.mockResolvedValue({ acquired: false });
    const res = makeRes();
    await call(makeReq(), res);
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(mocks.streamChat).not.toHaveBeenCalled();
    expect(mocks.releaseStreamSlot).not.toHaveBeenCalled();
  });

  it("returns 502 and releases the slot once when streamChat throws", async () => {
    mocks.streamChat.mockRejectedValue(new Error("boom"));
    const res = makeRes();
    await call(makeReq(), res);
    expect(res.statusCode).toBe(502);
    expect(mocks.releaseStreamSlot).toHaveBeenCalledTimes(1);
    expect(mocks.releaseStreamSlot).toHaveBeenCalledWith("uid-1");
  });
});

// ---------- streaming ----------

describe("streaming happy path", () => {
  it("sets SSE headers, pipes bytes, saves the reply, emits its id, releases, ends", async () => {
    const res = makeRes();
    await call(makeReq(), res);

    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(res.writes[0]).toBe(": connected\n\n");
    const out = res.writes.join("");
    expect(out).toContain(sseDelta("Hi "));
    expect(out).toContain(sseDone("Hi there"));

    expect(mocks.appendConversationMessage).toHaveBeenCalledTimes(1);
    const [pid, message, uid, auth] = mocks.appendConversationMessage.mock.calls[0];
    expect(pid).toBe("persona-1");
    expect(message).toMatchObject({ role: "assistant", content: "Hi there" });
    expect(message.interrupted).toBeFalsy();
    expect(uid).toBe("uid-1");
    expect(auth).toBe("Bearer token-1");

    // id comes after done.
    expect(out.indexOf("event: id")).toBeGreaterThan(out.indexOf("event: done"));
    expect(out).toContain(`event: id\ndata: {"id":"msg-42"}\n\n`);
    expect(mocks.releaseStreamSlot).toHaveBeenCalledTimes(1);
    expect(res.writableEnded).toBe(true);
    expect(res.endCalls).toBe(1);
  });

  it("releases the slot before ending the response", async () => {
    const order: string[] = [];
    mocks.releaseStreamSlot.mockImplementation(async () => {
      order.push("release");
    });
    const res = makeRes();
    res.on("finish", () => order.push("end"));
    await call(makeReq(), res);
    expect(order).toEqual(["release", "end"]);
  });

  it("does not save anything on an upstream error while the client is connected", async () => {
    mocks.streamChat.mockImplementation(async () =>
      fixedLlm([sseDelta("Par"), `event: error\ndata: {"error":"x"}\n\n`], "Par", false)
    );
    const res = makeRes();
    await call(makeReq(), res);
    expect(res.writes.join("")).toContain("event: error");
    expect(mocks.appendConversationMessage).not.toHaveBeenCalled();
    expect(res.writes.join("")).not.toContain("event: id");
    expect(mocks.releaseStreamSlot).toHaveBeenCalledTimes(1);
    expect(res.writableEnded).toBe(true);
  });

  it("does not save an empty completed reply", async () => {
    mocks.streamChat.mockImplementation(async () => fixedLlm([sseDone("")], "", true));
    const res = makeRes();
    await call(makeReq(), res);
    expect(mocks.appendConversationMessage).not.toHaveBeenCalled();
    expect(mocks.releaseStreamSlot).toHaveBeenCalledTimes(1);
    expect(res.writableEnded).toBe(true);
  });

  it("still releases and ends when saving the reply fails", async () => {
    mocks.appendConversationMessage.mockRejectedValue(new Error("permission denied"));
    const res = makeRes();
    await call(makeReq(), res);
    expect(res.writes.join("")).not.toContain("event: id");
    expect(mocks.releaseStreamSlot).toHaveBeenCalledTimes(1);
    expect(res.writableEnded).toBe(true);
  });

  it("still releases and ends when finalReply rejects", async () => {
    mocks.streamChat.mockImplementation(async () => ({
      ...fixedLlm([sseDone("x")], "x", true),
      finalReply: Promise.reject(new Error("bad")),
    }));
    const res = makeRes();
    await call(makeReq(), res);
    expect(mocks.appendConversationMessage).not.toHaveBeenCalled();
    expect(mocks.releaseStreamSlot).toHaveBeenCalledTimes(1);
    expect(res.writableEnded).toBe(true);
  });

  it("writes an error event and releases once when reading the stream throws", async () => {
    let pulls = 0;
    mocks.streamChat.mockImplementation(async () => ({
      stream: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(enc.encode(sseDelta("Hel")));
            return;
          }
          controller.error(new Error("socket hang up"));
        },
      }),
      finalReply: Promise.resolve("Hel"),
      completed: Promise.resolve(false),
    }));
    const res = makeRes();
    await call(makeReq(), res);
    const out = res.writes.join("");
    expect(out).toContain(sseDelta("Hel"));
    expect(out).toContain("event: error");
    expect(mocks.appendConversationMessage).not.toHaveBeenCalled();
    expect(mocks.releaseStreamSlot).toHaveBeenCalledTimes(1);
    expect(res.writableEnded).toBe(true);
  });

  it("does not treat the normal end of the response as a disconnect", async () => {
    let signal: AbortSignal | undefined;
    mocks.streamChat.mockImplementation(async (_req: unknown, s: AbortSignal) => {
      signal = s;
      return fixedLlm([sseDone("ok")], "ok", true);
    });
    const res = makeRes();
    await call(makeReq(), res);
    expect(signal?.aborted).toBe(false);
  });
});

describe("client disconnect", () => {
  it("aborts generation, saves the partial as interrupted, stops writing, releases once", async () => {
    let signal: AbortSignal | undefined;
    const res = makeRes();
    mocks.streamChat.mockImplementation(async (_req: unknown, s: AbortSignal) => {
      signal = s;
      return abortableLlm(s, ["Hel", "lo"], () => res.disconnect());
    });

    await call(makeReq(), res);

    expect(signal?.aborted).toBe(true);
    expect(mocks.appendConversationMessage).toHaveBeenCalledTimes(1);
    const message = mocks.appendConversationMessage.mock.calls[0][1];
    expect(message).toMatchObject({ role: "assistant", content: "Hello more", interrupted: true });
    // The upstream error event produced by the abort is not forwarded.
    expect(res.writes.join("")).not.toContain("event: error");
    expect(mocks.releaseStreamSlot).toHaveBeenCalledTimes(1);
    expect(res.endCalls).toBe(1);
  });

  // Regression (fixed today): after the client disconnects, the route still writes the
  // `event: id` line to the closed response (pages/api/chat.ts:220 is not
  // guarded by `clientGone`, unlike the read loop at :181).
  it("writes nothing to the response after the client disconnects", async () => {
    const res = makeRes();
    mocks.streamChat.mockImplementation(async (_req: unknown, s: AbortSignal) =>
      abortableLlm(s, ["Hel"], () => res.disconnect())
    );
    await call(makeReq(), res);
    expect(res.writesAfterDisconnect).toEqual([]);
  });

  it("saves a reply that completed even if the client left right after", async () => {
    const res = makeRes();
    mocks.streamChat.mockImplementation(async () => {
      const llm = fixedLlm([sseDelta("Done"), sseDone("Done")], "Done", true);
      return llm;
    });
    // Disconnect as soon as persistence starts (after the stream ended).
    mocks.appendConversationMessage.mockImplementation(async () => {
      res.disconnect();
      return "msg-7";
    });
    await call(makeReq(), res);
    const message = mocks.appendConversationMessage.mock.calls[0][1];
    expect(message).toMatchObject({ content: "Done" });
    expect(message.interrupted).toBeFalsy();
    expect(mocks.releaseStreamSlot).toHaveBeenCalledTimes(1);
  });

  it("does not save when the client leaves before any text was generated", async () => {
    const res = makeRes();
    mocks.streamChat.mockImplementation(async (_req: unknown, s: AbortSignal) => {
      queueMicrotask(() => res.disconnect());
      const final = deferred<string>();
      const done = deferred<boolean>();
      return {
        stream: new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!s.aborted) {
              await new Promise<void>((r) => s.addEventListener("abort", () => r(), { once: true }));
            }
            controller.close();
            final.resolve("");
            done.resolve(false);
          },
        }),
        finalReply: final.promise,
        completed: done.promise,
      };
    });
    await call(makeReq(), res);
    expect(mocks.appendConversationMessage).not.toHaveBeenCalled();
    expect(mocks.releaseStreamSlot).toHaveBeenCalledTimes(1);
  });

  // Regression (fixed today): a disconnect that happens before the "close" listener is attached
  // (pages/api/chat.ts:128 — it's registered only after auth, rate limit and
  // the Firestore reads) is never noticed: the LLM is called with a live
  // signal, generates the whole reply for nobody, and it is saved as a normal
  // completed turn. Expected: generation is skipped/aborted.
  it("does not generate a reply when the client left during the Firestore reads", async () => {
    const res = makeRes();
    mocks.getPersona.mockImplementation(async () => {
      res.disconnect();
      return persona;
    });
    let signal: AbortSignal | undefined;
    mocks.streamChat.mockImplementation(async (_req: unknown, s: AbortSignal) => {
      signal = s;
      return fixedLlm([sseDone("unseen")], "unseen", true);
    });
    await call(makeReq(), res);
    const generatedForNobody = mocks.streamChat.mock.calls.length > 0 && signal?.aborted === false;
    expect(generatedForNobody).toBe(false);
  });

  it("releases the slot if the client leaves while waiting for a slot", async () => {
    const res = makeRes();
    mocks.acquireStreamSlot.mockImplementation(async () => {
      res.disconnect();
      return { acquired: true };
    });
    let signal: AbortSignal | undefined;
    mocks.streamChat.mockImplementation(async (_req: unknown, s: AbortSignal) => {
      signal = s;
      // A real adapter's fetch rejects on an aborted signal and the adapter
      // turns that into an error stream.
      return fixedLlm([`event: error\ndata: {"error":"x"}\n\n`], "", false);
    });
    await call(makeReq(), res);
    // Generation is skipped entirely (or, if it started, its signal is aborted).
    expect(signal === undefined || signal.aborted).toBe(true);
    expect(mocks.appendConversationMessage).not.toHaveBeenCalled();
    expect(mocks.releaseStreamSlot).toHaveBeenCalledTimes(1);
  });
});

describe("robustness", () => {
  // Regression (fixed today): if the adapter's finalReply/completed promises never settle (e.g.
  // its stream errors without resolving them), the `finally` block awaits
  // forever (pages/api/chat.ts:203): the slot is never released and the
  // response never ends, so the user's concurrency slot leaks until restart.
  // The real adapters do resolve them on every path today, so this is a
  // contract-fragility issue rather than a live bug.
  it("releases the slot even if the adapter never settles finalReply", async () => {
    mocks.streamChat.mockImplementation(async () => ({
      stream: new ReadableStream<Uint8Array>({
        start(c) {
          c.error(new Error("upstream died"));
        },
      }),
      finalReply: new Promise<string>(() => {}),
      completed: new Promise<boolean>(() => {}),
    }));
    const res = makeRes();
    const outcome = await Promise.race([
      call(makeReq(), res).then(() => "finished"),
      new Promise((r) => setTimeout(() => r("hung"), 300)),
    ]);
    expect(outcome).toBe("finished");
  });

  it("still ends the response if releasing the slot throws", async () => {
    mocks.releaseStreamSlot.mockRejectedValue(new Error("redis"));
    const res = makeRes();
    await expect(call(makeReq(), res)).resolves.toBeUndefined();
    expect(res.writableEnded).toBe(true);
  });
});
