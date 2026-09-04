// Shared byte-writers for the server's SSE event vocabulary.
//
// Both LLM adapters (ollama.ts, lm-studio.ts) translate their upstream
// provider's stream into these events, which the /api/chat route pipes
// straight to the client:
//   event: delta { "delta": "<token>" }
//   event: done  { "reply": "<full reply>" }
//   event: error { "error": "<message>" }

export const sseDelta = (delta: string): Uint8Array =>
  new TextEncoder().encode(`event: delta\ndata: ${JSON.stringify({ delta })}\n\n`);

export const sseDone = (reply: string): Uint8Array =>
  new TextEncoder().encode(`event: done\ndata: ${JSON.stringify({ reply })}\n\n`);

export const sseError = (error: string): Uint8Array =>
  new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);
