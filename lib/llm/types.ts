// Shared LLM contract. The PoC ships with one implementation
// (lib/llm/lm-studio.ts). A future provider swap (OpenAI, Anthropic, Groq,
// etc.) is a new file in lib/llm/ + an env var change.
//
// streamChat() returns a ReadableStream of bytes that already conform
// to the server's SSE event vocabulary:
//   event: delta { "delta": "<token>" }
//   event: done  { "reply": "<full reply>" }
//   event: error { "error": "<message>" }
// The route pipes this stream directly to the client. The chat route
// does not need to know which upstream provider produced it.

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ChatRequest = {
  system: string;
  messages: ChatMessage[];
};

export type LlmStream = {
  // Bytes to pipe to the client. Already in the SSE event vocabulary
  // (event: delta / done / error). The route does not need to parse
  // these — it just res.write()s each chunk.
  stream: ReadableStream<Uint8Array>;
  // Resolves to the final accumulated assistant reply when the stream
  // completes. Empty string if the stream errored before any reply.
  // The route uses this for persistence (writing the assistant's
  // message to Firestore) without re-parsing the SSE bytes it just
  // sent to the client.
  finalReply: Promise<string>;
  // Resolves true only after the upstream provider has explicitly
  // completed the response. Interrupted/error streams may have partial
  // text in finalReply, but that text must not be persisted as a turn.
  completed: Promise<boolean>;
};

export type LlmAdapter = {
  streamChat(req: ChatRequest, signal: AbortSignal): Promise<LlmStream>;
};
