import type { NextApiRequest, NextApiResponse } from "next";
import { buildSystemPrompt } from "../../lib/prompts";
import {
  getPersona,
  listMemoriesForPersona,
  getUidFromAuthHeader,
  UnauthenticatedError,
} from "../../lib/firestore";
import type { PersonaDoc, MemoryDoc } from "../../lib/firestore";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type Body = {
  personaId: string;
  messages: ChatMessage[];
};

type Response =
  | { reply: string }
  | { error: string };

function isValidMessage(m: unknown): m is ChatMessage {
  if (!m || typeof m !== "object") return false;
  const msg = m as { role?: unknown; content?: unknown };
  return (
    (msg.role === "user" || msg.role === "assistant") &&
    typeof msg.content === "string" &&
    msg.content.trim().length > 0
  );
}

function getOllamaHost(): string {
  return process.env.OLLAMA_HOST || "http://localhost:11434";
}

function getOllamaModel(): string {
  return process.env.OLLAMA_MODEL || "llama3.2";
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Response>
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body as Partial<Body> | undefined;
  if (!body || typeof body.personaId !== "string" || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: "Body must be { personaId, messages[] }." });
  }
  if (!body.messages.every(isValidMessage)) {
    return res.status(400).json({ error: "Each message must be { role: 'user'|'assistant', content: string }." });
  }
  // Cap conversation length so a single request can't blow the token budget.
  const messages = body.messages.slice(-40);

  let uid: string;
  try {
    uid = await getUidFromAuthHeader(req.headers.authorization);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(401).json({ error: "Unauthenticated." });
    }
    const message = err instanceof Error ? err.message : "Unknown auth error";
    return res.status(502).json({ error: `Auth lookup failed: ${message}` });
  }

  let persona: PersonaDoc;
  let memories: MemoryDoc[];
  try {
    // getPersona enforces ownership — returns null if persona.ownerId !== uid.
    const found = await getPersona(body.personaId, uid);
    if (!found) {
      return res.status(404).json({ error: "Persona not found." });
    }
    persona = found;
    memories = await listMemoriesForPersona(body.personaId, 20);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown Firestore error";
    return res.status(502).json({ error: `Firestore: ${message}` });
  }

  const system = buildSystemPrompt(persona, memories);

  // Ollama chat completion, streaming. We set stream:true so Ollama returns
  // NDJSON — one JSON object per line, each carrying a delta in
  // message.content. We pipe the body straight through to the client as
  // Server-Sent Events so the browser can render tokens as they arrive.
  let ollamaRes: globalThis.Response;
  try {
    ollamaRes = await fetch(`${getOllamaHost()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: getOllamaModel(),
        stream: true,
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown network error";
    return res
      .status(502)
      .json({ error: `Could not reach Ollama at ${getOllamaHost()}: ${message}` });
  }

  if (!ollamaRes.ok || !ollamaRes.body) {
    let detail = "";
    try {
      detail = await ollamaRes.text();
    } catch {
      // ignore
    }
    return res.status(502).json({
      error: `Ollama responded ${ollamaRes.status}: ${detail || "(no body)"}`,
    });
  }

  // Re-emit each NDJSON line as an SSE "data:" event. The shape is:
  //   {"message":{"content":"<delta>"},"done":false}   -> forward as data
  //   {"done":true,"...stats..."}                       -> forward as "done"
  // On any parse failure or transport error mid-stream, send an "error"
  // event so the client can surface it instead of hanging.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const reader = ollamaRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalReply = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
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
            res.write(`event: error\ndata: ${JSON.stringify({ error: parsed.error })}\n\n`);
            return res.end();
          }
          if (parsed.done) {
            res.write(`event: done\ndata: ${JSON.stringify({ reply: totalReply })}\n\n`);
            return res.end();
          }
          const delta = parsed.message?.content ?? "";
          if (delta) {
            totalReply += delta;
            res.write(`event: delta\ndata: ${JSON.stringify({ delta })}\n\n`);
          }
        } catch {
          // Malformed NDJSON line — skip. Ollama should never emit these
          // but if it does, dropping them is safer than crashing the stream.
        }
      }
    }
    // Stream closed without a done event. Treat as success with whatever
    // we accumulated.
    res.write(`event: done\ndata: ${JSON.stringify({ reply: totalReply })}\n\n`);
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stream interrupted";
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    } catch {
      // Client already disconnected.
    }
  }
}
