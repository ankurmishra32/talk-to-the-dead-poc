import type { NextApiRequest, NextApiResponse } from "next";
import { buildSystemPrompt } from "../../lib/prompts";
import { getPersona, listMemoriesForPersona, appendConversationMessage } from "../../lib/firestore";
import type { PersonaDoc, MemoryDoc } from "../../lib/types";
import type { ChatMessage } from "../../lib/llm/types";
import { authAdapter } from "../../lib/auth/server";
import { llmAdapter } from "../../lib/llm";
import {
  checkRequestRate,
  acquireStreamSlot,
  releaseStreamSlot,
} from "../../lib/rate-limit";
import { createLogger } from "../../lib/logger";
import { HISTORY_LIMITS, trimHistory } from "../../lib/messages";

const logger = createLogger("api/chat");

type Body = {
  personaId: string;
  messages: ChatMessage[];
};

type Response =
  | { reply: string }
  | { error: string };

// Upper bound on the raw array we're willing to look at. Anything beyond the
// history limits is trimmed (not rejected), so this only guards against abuse.
const MAX_RAW_MESSAGES = 200;

// How long to wait for the adapter's finalReply/completed after its stream
// has ended. Both adapters settle them immediately; this only guards against
// one that doesn't, so a stuck promise can't leak the user's stream slot.
const SETTLE_TIMEOUT_MS = 5_000;

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isValidMessage(m: unknown): m is ChatMessage {
  if (!m || typeof m !== "object") return false;
  const msg = m as { role?: unknown; content?: unknown };
  return (
    (msg.role === "user" || msg.role === "assistant") &&
    typeof msg.content === "string"
  );
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Response>
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Detect the client going away (Stop button, closed tab, navigation) from
  // the start, so a disconnect during auth / Firestore reads is noticed too.
  // `req` "close" is not usable for this: on Node 16+ it fires as soon as the
  // request body has been read, not when the connection drops. `res` "close"
  // fires when the connection closes; if we haven't ended the response yet,
  // the client disconnected.
  const ac = new AbortController();
  let clientGone = false;
  res.on("close", () => {
    if (!res.writableEnded) {
      clientGone = true;
      ac.abort();
    }
  });

  const body = req.body as Partial<Body> | undefined;
  if (
    !body ||
    typeof body.personaId !== "string" ||
    !body.personaId.trim() ||
    !Array.isArray(body.messages)
  ) {
    return res.status(400).json({ error: "Body must be { personaId, messages[] }." });
  }
  if (body.messages.length === 0 || body.messages.length > MAX_RAW_MESSAGES) {
    return res.status(400).json({ error: `messages[] must contain 1–${MAX_RAW_MESSAGES} entries.` });
  }
  if (!body.messages.every(isValidMessage)) {
    return res.status(400).json({ error: "Each message must be { role: 'user'|'assistant', content: string }." });
  }
  // The turn being answered must be the user's, and must fit on its own.
  // Older history is trimmed to the limits instead of rejected, so a long
  // conversation never gets stuck.
  const latest = body.messages[body.messages.length - 1];
  if (latest.role !== "user" || !latest.content.trim()) {
    return res.status(400).json({ error: "The last message must be a non-empty user message." });
  }
  if (latest.content.length > HISTORY_LIMITS.maxMessageChars) {
    return res.status(400).json({
      error: `Messages must be at most ${HISTORY_LIMITS.maxMessageChars} characters.`,
    });
  }
  // Also strips any extra fields (ids etc.) so only { role, content } reaches the LLM.
  const messages: ChatMessage[] = trimHistory(body.messages);

  const authorization = req.headers.authorization ?? "";
  let uid: string;
  try {
    const user = await authAdapter.verifyAccessToken(authorization);
    uid = user.uid;
  } catch (err) {
    logger.error("Auth token verification failed", err);
    return res.status(401).json({ error: "Please sign in again." });
  }

  // Rate limit (per UID). Happens after auth so the bucket is keyed
  // on a verified identity, not an IP. A real user chatting normally
  // never hits this — the burst allowance covers multi-message
  // exchanges and the sustained rate caps scripted abuse.
  const rate = await checkRequestRate(uid);
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    return res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
  }

  let persona: PersonaDoc;
  let memories: MemoryDoc[];
  try {
    // getPersona enforces ownership — returns null if persona.ownerId !== uid.
    const found = await getPersona(body.personaId, uid, authorization);
    if (!found) {
      return res.status(404).json({ error: "Persona not found." });
    }
    persona = found;
    memories = await listMemoriesForPersona(body.personaId, uid, authorization, 20);
  } catch (err) {
    logger.error("Firestore read failed", err);
    return res.status(502).json({ error: "Something went wrong on our end. Please try again." });
  }

  const system = buildSystemPrompt(persona, memories);

  // The LLM adapter returns a ReadableStream whose chunks are already
  // SSE-formatted bytes (event: delta / done / error). We stream them
  // to the response one chunk at a time so a transport error mid-stream
  // can emit an `event: error` event before closing, matching the
  // pre-refactor behavior.
  // Nobody to answer: skip generation entirely.
  if (clientGone) return;

  // Concurrency cap on in-flight streams. Once the rate check is
  // past, what protects the local model server is how many simultaneous streams this
  // UID (and the server overall) is holding. If we can't get a slot
  // we return 503 — it's not the user's fault, so no Retry-After.
  const slot = await acquireStreamSlot(uid);
  if (!slot.acquired) {
    return res.status(503).json({ error: "Server is busy. Please wait a moment and try again." });
  }
  if (clientGone) {
    await releaseSlot(uid);
    return;
  }

  let upstream: ReadableStream<Uint8Array>;
  let finalReply: Promise<string>;
  let completed: Promise<boolean>;
  try {
    const llmStream = await llmAdapter.streamChat({ system, messages }, ac.signal);
    upstream = llmStream.stream;
    finalReply = llmStream.finalReply;
    completed = llmStream.completed;
  } catch (err) {
    await releaseSlot(uid);
    logger.error("Could not reach LLM provider", err);
    return res.status(502).json({ error: "Something went wrong on our end. Please try again." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Send an immediate keepalive comment so proxies/buffering layers see the
  // connection as "active" before the first token arrives. SSE comment
  // lines (starting with ":") are ignored by clients but keep
  // intermediaries from treating the stream as idle during the model's
  // first-token latency.
  try {
    res.write(": connected\n\n");
  } catch {
    // Client already disconnected before the stream began.
  }

  const reader = upstream.getReader();
  // Set when the adapter's stream itself errors (adapters normally report
  // problems as `event: error` instead). Its reply can't be trusted then.
  let streamFailed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // After a disconnect, keep draining (the adapter closes promptly once
      // aborted) but don't write to the closed response.
      if (value && !clientGone) {
        // res.write accepts Buffer or string; Uint8Array is fine.
        res.write(Buffer.from(value));
      }
    }
  } catch (err) {
    streamFailed = true;
    logger.error("Stream interrupted", err);
    if (!clientGone) {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error: "The reply was cut off. Please try again." })}\n\n`);
      } catch {
        // Client already disconnected.
      }
    }
  } finally {
    // Await persistence before closing the response so we can emit
    // the new doc id as an SSE event. The LLM stream has already
    // ended (we're past the read loop) so the client has seen `done`
    // and committed the reply to local state — we just need to hand
    // back the Firestore doc id so the client can edit/delete this
    // message later via the client SDK. The cost is one extra
    // Firestore REST round-trip on the request hot path; acceptable
    // for a PoC.
    try {
      const settled = streamFailed
        ? null
        : await settleWithin(Promise.all([finalReply, completed]), SETTLE_TIMEOUT_MS);
      if (!streamFailed && settled === null) {
        logger.error("LLM adapter did not settle its reply; not saving it");
      }
      const [reply, didComplete] = settled ?? ["", false];
      // Save a completed reply, or — when the user stopped it / left — the
      // partial text, flagged `interrupted` so it reloads as a stopped reply.
      // Partial text from an upstream error is not saved: the user sees an
      // error and retries.
      const interrupted = !didComplete && clientGone;
      if (reply && (didComplete || interrupted)) {
        try {
          const messageId = await appendConversationMessage(
            persona.id,
            { role: "assistant", content: reply, interrupted },
            uid,
            authorization
          );
          // After a disconnect nobody is listening; don't write to the
          // closed response.
          if (!clientGone) {
            try {
              res.write(`event: id\ndata: ${JSON.stringify({ id: messageId })}\n\n`);
            } catch {
              // Client disconnected in the meantime.
            }
          }
        } catch (err) {
          logger.error("Failed to persist assistant reply", err);
        }
      }
    } catch (err) {
      logger.error("Failed to resolve finalReply", err);
    }

    await releaseSlot(uid);
    res.end();
  }
}

// Releasing must never stop the response from ending; a failure is logged
// (the limiter's own TTLs eventually recover the slot).
async function releaseSlot(uid: string): Promise<void> {
  try {
    await releaseStreamSlot(uid);
  } catch (err) {
    logger.error("Failed to release stream slot", err);
  }
}
