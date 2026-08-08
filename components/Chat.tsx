import { useEffect, useRef, useState } from "react";
import { auth } from "../firebase/config";
import MemoryInput from "./MemoryInput";

/**
 * Parses a single SSE event block (text between two blank lines) into
 * { event, data }. Returns null if the block has no data line.
 */
function parseSseEvent(
  block: string
): { event: string; data: unknown } | null {
  let eventName = "message";
  let dataLine = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLine += line.slice(5).trim();
    }
  }
  if (!dataLine) return null;
  try {
    return { event: eventName, data: JSON.parse(dataLine) };
  } catch {
    return { event: eventName, data: { raw: dataLine } };
  }
}

type Persona = {
  id: string;
  name: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type User = {
  uid: string;
};

export default function Chat({ persona, user, onBack }: { persona: Persona; user: User; onBack: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMemoryInput, setShowMemoryInput] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Auto-scroll to the bottom on each new message.
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamingContent, loading]);

  // Clean up any in-flight request when the persona changes or the
  // component unmounts.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, [persona.id]);

  const cancel = () => {
    abortRef.current?.abort();
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setError(null);
    setStreamingContent("");
    setLoading(true);

    // Get a fresh ID token for the chat route. `getIdToken()` refreshes
    // automatically when the cached token is within ~5min of expiry.
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) {
      setLoading(false);
      setError("You're signed out. Please sign in again.");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    let res: Response;
    try {
      res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ personaId: persona.id, messages: next }),
        signal: controller.signal,
      });
    } catch (err) {
      setLoading(false);
      if (err instanceof DOMException && err.name === "AbortError") {
        // User cancelled — keep whatever was streamed so far.
        if (streamingContent) {
          setMessages((prev) => [...prev, { role: "assistant", content: streamingContent }]);
          setStreamingContent("");
        }
        return;
      }
      setError(err instanceof Error ? err.message : "Network error.");
      return;
    }

    if (res.status === 401) {
      setLoading(false);
      setError("Session expired. Please sign in again.");
      return;
    }
    if (!res.ok || !res.body) {
      setLoading(false);
      let detail = "";
      try {
        const data = (await res.json()) as { error?: string };
        detail = data.error ?? "";
      } catch {
        // ignore
      }
      setError(detail || `Request failed (${res.status}).`);
      return;
    }

    // Stream SSE events: lines come in groups separated by blank lines.
    // Each event is "event: <name>\ndata: <json>\n\n".
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";
    let sawDone = false;

    const handleAbort = () => {
      setLoading(false);
      if (accumulated) {
        setMessages((prev) => [...prev, { role: "assistant", content: accumulated }]);
        setStreamingContent("");
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by a blank line.
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const eventBlock = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev = parseSseEvent(eventBlock);
          if (!ev) continue;
          if (ev.event === "delta") {
            // ev.data is unknown from the parser; narrow it to the shape we expect.
            const d = ev.data as { delta?: unknown };
            if (typeof d.delta === "string") {
              accumulated += d.delta;
              setStreamingContent(accumulated);
            }
          } else if (ev.event === "done") {
            sawDone = true;
          } else if (ev.event === "error") {
            const d = ev.data as { error?: unknown };
            setError(typeof d.error === "string" ? d.error : "Stream error.");
            setLoading(false);
            return;
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        handleAbort();
        return;
      }
      setLoading(false);
      setError(err instanceof Error ? err.message : "Stream interrupted.");
      return;
    }

    // Stream completed. Commit the accumulated text as a real message.
    setLoading(false);
    setMessages((prev) => [...prev, { role: "assistant", content: accumulated }]);
    setStreamingContent("");
    if (!sawDone && !accumulated) {
      setError("The model returned an empty reply.");
    }
  };

  return (
    <div className="max-w-2xl mx-auto bg-white rounded shadow">
      <header className="flex items-center justify-between p-4 border-b">
        <div>
          <div className="text-lg font-semibold">
            Speaking with: {persona.name}
          </div>
          <div className="text-xs text-gray-500">simulation / character — not a real person</div>
        </div>
        <div className="flex space-x-2">
          <button
            onClick={() => setShowMemoryInput((v) => !v)}
            className="text-sm border px-3 py-1 rounded hover:bg-gray-50"
          >
            {showMemoryInput ? "Hide memory" : "Add memory"}
          </button>
          <button
            onClick={onBack}
            className="text-sm border px-3 py-1 rounded hover:bg-gray-50"
          >
            Change persona
          </button>
        </div>
      </header>

      {showMemoryInput && (
        <div className="p-4 border-b bg-gray-50">
          <MemoryInput user={user} persona={persona} />
        </div>
      )}

      <div ref={listRef} className="p-4 space-y-3 h-96 overflow-y-auto bg-gray-100">
        {messages.length === 0 && !streamingContent && (
          <p className="text-center text-gray-500 text-sm pt-12">
            Start the conversation. {persona.name.split(" ")[0]} will reply in the style you described.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] px-3 py-2 rounded shadow-sm ${
                m.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-900 border"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {streamingContent && (
          <div className="flex justify-start">
            <div className="max-w-[80%] px-3 py-2 rounded shadow-sm bg-white text-gray-900 border">
              {streamingContent}
              <span className="inline-block w-1.5 h-4 ml-0.5 bg-gray-400 animate-pulse align-middle" />
            </div>
          </div>
        )}
        {loading && !streamingContent && (
          <div className="flex justify-start">
            <div className="bg-white text-gray-500 border px-3 py-2 rounded shadow-sm italic">
              {persona.name.split(" ")[0]} is typing…
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="px-4 py-2 bg-red-50 border-t border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={send} className="p-4 border-t flex space-x-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(e as unknown as React.FormEvent);
            }
          }}
          placeholder="Type a message…"
          rows={2}
          className="flex-1 border p-2 rounded resize-none"
          disabled={loading}
        />
        {loading ? (
          <button
            type="button"
            onClick={cancel}
            className="bg-gray-700 text-white px-4 rounded hover:bg-gray-800"
          >
            Cancel
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            className="bg-blue-600 text-white px-4 rounded hover:bg-blue-700 disabled:bg-gray-400"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
