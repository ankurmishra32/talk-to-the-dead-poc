import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth/useAuth";
import { db } from "../firebase/config";
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  getDoc,
  addDoc,
  deleteDoc,
  updateDoc,
  doc,
  startAfter,
  onSnapshot,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import MemoryInput from "./MemoryInput";
import { parseSseEvent } from "../lib/sse";
import {
  isPersistedId,
  mapMessageDocs,
  reconcileMessages,
} from "../lib/messages";
import type {
  ChatMessage,
  FullPersonaProfile,
  MinimalUser,
  PersonaFirestoreDoc,
  PersonaReference,
} from "../lib/types";
import { createLogger } from "../lib/logger";
import MessageBubble from "./chat/MessageBubble";
import ProfilePanel from "./chat/ProfilePanel";
import ChatComposer from "./chat/ChatComposer";

const PAGE_SIZE = 40;

const logger = createLogger("Chat");

export default function Chat({ persona, user, onBack }: { persona: PersonaReference; user: MinimalUser; onBack: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMemoryInput, setShowMemoryInput] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [profile, setProfile] = useState<FullPersonaProfile | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  // Cursor-based pagination state. `cursor` is the oldest doc currently
  // loaded (i.e. the last doc in the desc-ordered Firestore query). When
  // non-null and `hasMore` is true, calling loadOlder() fetches 40 more
  // docs older than this one. Captured as a snapshot — Firestore SDK
  // startAfter accepts the full snapshot, not just a field value.
  const [cursor, setCursor] = useState<QueryDocumentSnapshot | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // When older messages prepend to the list, the user would jump down by
  // the height of the prepended content. We capture the offset from the
  // bottom before the prepend and restore it after the DOM updates, so
  // the viewport stays anchored on the same message.
  const pendingScrollAdjustRef = useRef<{
    distanceFromBottom: number;
  } | null>(null);
  // id of the message currently being edited (user messages only).
  // null when nothing is being edited.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Firestore doc id of the assistant message currently being
  // streamed. Populated when the SSE `event: id` arrives; read when
  // we commit the streamed assistant text to `messages` at the end
  // of the turn (or on cancel). Lives in a ref because the SSE
  // event fires inside the read loop, but the message is appended
  // after the loop exits.
  const pendingAssistantIdRef = useRef<string | null>(null);
  // Messages the user is currently editing locally. Remote changes to
  // these ids are ignored so an edit on another device doesn't clobber
  // the user's in-progress draft. Cleared on save or cancel.
  const dirtyIdsRef = useRef<Set<string>>(new Set());
  const { getAccessToken } = useAuth();

  // Load the most recent messages and profile for this persona on mount and
  // whenever the user switches personas.
  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    setMessages([]);
    setCursor(null);
    setHasMore(false);
    setLoadingMore(false);
    setEditingId(null);
    dirtyIdsRef.current = new Set();
    setError(null);
    setProfile(null);
    setShowProfile(false);

    async function loadProfile() {
      try {
        const snap = await getDoc(doc(db, "personas", persona.id));
        if (cancelled) return;
        if (snap.exists()) {
          const data = snap.data() as PersonaFirestoreDoc;
          setProfile({
            id: snap.id,
            name: data.name ?? persona.name,
            relationship: data.relationship ?? null,
            theyCalledYou: data.theyCalledYou ?? null,
            languages: Array.isArray(data.languages) ? data.languages : [],
            howTheySpoke: Array.isArray(data.howTheySpoke) ? data.howTheySpoke : [],
            speechExamples: Array.isArray(data.speechExamples) ? data.speechExamples : [],
            oftenSaid: Array.isArray(data.oftenSaid) ? data.oftenSaid : [],
            distinctiveStory: data.distinctiveStory ?? null,
          });
        }
      } catch (err) {
        if (!cancelled) {
          logger.error("Failed to load persona profile", err);
        }
      }
    }

    // Live subscription to the active persona's most recent PAGE_SIZE
    // messages. onSnapshot keeps the list in sync with writes from any
    // device — a message sent from a phone shows up here without a
    // reload. Older paginated messages stay as one-shot getDocs() loads.
    // The returned unsubscribe is called on cleanup.
    const messagesQuery = query(
      collection(db, "conversations", persona.id, "messages"),
      where("userId", "==", user.uid),
      orderBy("createdAt", "desc"),
      limit(PAGE_SIZE)
    );
    let isFirstMessagesSnap = true;
    const unsubscribeMessages = onSnapshot(
      messagesQuery,
      (snap) => {
        if (cancelled) return;
        if (isFirstMessagesSnap) {
          // Seed from the full snap rather than the change list, so
          // chronological order comes straight from Firestore and the
          // cursor lands on the oldest doc in one shot.
          isFirstMessagesSnap = false;
          const loaded = mapMessageDocs(snap.docs);
          setMessages(loaded);
          // Cursor for the next page is the last doc of the desc-ordered
          // snap (the oldest message currently in our window). If we got
          // fewer than a full page, there's nothing older to fetch.
          setCursor(snap.docs[snap.docs.length - 1] ?? null);
          setHasMore(snap.docs.length === PAGE_SIZE);
          setHistoryLoading(false);
          return;
        }
        // Subsequent events: apply docChanges incrementally.
        setMessages((prev) =>
          reconcileMessages(prev, snap.docChanges(), dirtyIdsRef.current)
        );
      },
      (err) => {
        if (cancelled) return;
        logger.error("Conversation subscription failed", err);
        setError(
          err instanceof Error
            ? err.message
            : "Live conversation sync failed."
        );
        setHistoryLoading(false);
      }
    );

    loadProfile();
    return () => {
      cancelled = true;
      unsubscribeMessages();
    };
  }, [persona.id, persona.name, user.uid]);

  useEffect(() => {
    // Auto-scroll to the bottom on each new message.
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamingContent, loading]);

  // Clean up any in-flight request when the persona changes or the
  // component unmounts.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, [persona.id]);

  // Restore scroll position after older messages are prepended. The
  // ref is set just before setMessages() in loadOlder; this effect
  // fires after the DOM updates and adjusts scrollTop so the
  // previously-visible message stays in place. Skips if no ref is
  // pending (e.g. on initial mount or normal new-message append).
  useLayoutEffect(() => {
    const pending = pendingScrollAdjustRef.current;
    if (!pending) return;
    pendingScrollAdjustRef.current = null;
    const el = listRef.current;
    if (!el) return;
    const newScrollTop = el.scrollHeight - pending.distanceFromBottom;
    el.scrollTop = newScrollTop;
  }, [messages]);

  const cancel = () => {
    abortRef.current?.abort();
  };

  // ---- Pagination: load older messages -----------------------------

  const loadOlder = async () => {
    if (loadingMore || !hasMore || !cursor) return;
    const el = listRef.current;
    if (!el) return;
    setLoadingMore(true);
    // Capture how far the user is from the bottom of the scroll
    // container BEFORE we prepend. After the prepend, the scroll
    // height grows by the prepended content's height; we restore the
    // viewport so the user lands back on the same message.
    const distanceFromBottom = el.scrollHeight - el.scrollTop;
    pendingScrollAdjustRef.current = { distanceFromBottom };
    try {
      const q = query(
        collection(db, "conversations", persona.id, "messages"),
        where("userId", "==", user.uid),
        orderBy("createdAt", "desc"),
        startAfter(cursor),
        limit(PAGE_SIZE)
      );
      const snap = await getDocs(q);
      const older = mapMessageDocs(snap.docs);
      setMessages((prev) => [...older, ...prev]);
      setCursor(snap.docs[snap.docs.length - 1] ?? null);
      setHasMore(snap.docs.length === PAGE_SIZE);
    } catch (err) {
      // Drop the pending scroll adjustment so the next render doesn't
      // try to restore from a stale snapshot.
      pendingScrollAdjustRef.current = null;
      logger.error("Failed to load older messages", err);
      setError(
        err instanceof Error ? err.message : "Failed to load older messages."
      );
    } finally {
      setLoadingMore(false);
    }
  };

  // Infinite scroll upward: when the user nears the top of the list
  // and there are more pages, fetch the next batch. The threshold is
  // generous (80px) so the fetch starts before the user actually hits
  // the top, hiding latency.
  const handleListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!hasMore || loadingMore) return;
    if (e.currentTarget.scrollTop < 80) {
      loadOlder();
    }
  };

  // ---- Edit / delete handlers --------------------------------------

  const startEdit = (m: ChatMessage) => {
    if (!m.id) return; // local-only message — no edit affordance
    // Mark this id as locally-dirty so the onSnapshot subscription
    // ignores remote updates to it until we save or cancel. "Local
    // unsaved wins" — the user's draft is preserved even if another
    // device edits the same message.
    dirtyIdsRef.current.add(m.id);
    setEditingId(m.id);
    setEditingDraft(m.content);
  };

  const cancelEdit = () => {
    if (editingId) dirtyIdsRef.current.delete(editingId);
    setEditingId(null);
    setEditingDraft("");
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const trimmed = editingDraft.trim();
    if (!trimmed) return;
    const id = editingId;
    const original = messages.find((m) => m.id === id);
    if (!original) return;
    // Optimistic local update.
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content: trimmed } : m))
    );
    setEditingId(null);
    setEditingDraft("");
    try {
      await updateDoc(
        doc(db, "conversations", persona.id, "messages", id),
        { content: trimmed }
      );
      // Once the write resolves, drop the dirty flag. Any subsequent
      // remote update to this id should be visible to the user again.
      dirtyIdsRef.current.delete(id);
    } catch (err) {
      // Save failed — keep the dirty flag so the rollback below isn't
      // clobbered by a remote event, then clear it after we restore.
      logger.error("Failed to update message", err);
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? original : m))
      );
      dirtyIdsRef.current.delete(id);
      setError(
        err instanceof Error ? err.message : "Failed to save edit."
      );
    }
  };

  const deleteMessage = async (m: ChatMessage) => {
    // Local-only message (cancelled partial assistant reply): no
    // Firestore doc, just drop from local state. Confirmed via the
    // same confirm() dialog so the UX is consistent.
    if (!m.id) {
      if (!window.confirm("Delete this message?")) return;
      setMessages((prev) => prev.filter((x) => x !== m));
      return;
    }
    if (!window.confirm("Delete this message?")) return;
    const id = m.id;
    const originalIndex = messages.findIndex((item) => item.id === id);
    // Optimistic local removal.
    setMessages((prev) => prev.filter((x) => x.id !== id));
    if (editingId === id) {
      setEditingId(null);
      setEditingDraft("");
    }
    // Block the snapshot from re-adding the doc mid-flight. If the
    // delete fails we'll restore the local copy and clear the flag.
    dirtyIdsRef.current.add(id);
    try {
      await deleteDoc(
        doc(db, "conversations", persona.id, "messages", id)
      );
      dirtyIdsRef.current.delete(id);
    } catch (err) {
      logger.error("Failed to delete message", err);
      setMessages((prev) => {
        if (prev.some((item) => item.id === id)) return prev;
        const restored = [...prev];
        restored.splice(Math.min(originalIndex, restored.length), 0, m);
        return restored;
      });
      dirtyIdsRef.current.delete(id);
      setError(
        err instanceof Error ? err.message : "Failed to delete message."
      );
    }
  };

  // ---- Send handler -----------------------------------------------

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    // A local-only key for this message. Lets us attach the Firestore
    // doc id back to *this specific* message later, even if the user
    // has sent more messages in the meantime. The key is never sent
    // over the wire — it's a purely client-side identifier.
    const localKey = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const next: ChatMessage[] = [
      ...messages,
      { role: "user", content: text, id: localKey },
    ];
    setMessages(next);
    setInput("");
    setError(null);
    setStreamingContent("");
    setLoading(true);
    // Reset the pending-assistant-id slot for this new turn. The SSE
    // event: id handler will populate it.
    pendingAssistantIdRef.current = null;

    // Persist the user message and capture its Firestore doc id so
    // the user can edit/delete this turn later. The optimistic local
    // update above renders immediately regardless of write success —
    // when the write resolves we patch the local message (matched by
    // its localKey) with the real Firestore id.
    addDoc(collection(db, "conversations", persona.id, "messages"), {
      ownerUid: user.uid,
      userId: user.uid,
      personaId: persona.id,
      role: "user",
      content: text,
      createdAt: new Date(),
    })
      .then((docRef) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === localKey ? { ...m, id: docRef.id } : m))
        );
      })
      .catch((err) => {
        logger.error("Failed to persist user message", err);
      });

    // Get a fresh access token for the chat route. The auth adapter
    // refreshes the underlying ID token automatically when the cached
    // value is within ~5 min of expiry.
    const idToken = await getAccessToken();
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
        body: JSON.stringify({ personaId: persona.id, messages: next.slice(-40) }),
        signal: controller.signal,
      });
    } catch (err) {
      setLoading(false);
      if (err instanceof DOMException && err.name === "AbortError") {
        // User cancelled — keep whatever was streamed so far.
        if (streamingContent) {
          const assistantId = pendingAssistantIdRef.current ?? undefined;
          setMessages((prev) => [
            ...prev,
            { id: assistantId, role: "assistant", content: streamingContent },
          ]);
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
        const assistantId = pendingAssistantIdRef.current ?? undefined;
        setMessages((prev) => [
          ...prev,
          { id: assistantId, role: "assistant", content: accumulated },
        ]);
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
          } else if (ev.event === "id") {
            // Server hands back the Firestore doc id of the just-
            // persisted assistant reply. We don't try to patch an
            // existing assistant message in place here because the
            // streamed assistant message isn't appended to state until
            // after this read loop exits (line 397 below). Instead,
            // stash the id in a ref and apply it when we commit the
            // streamed text.
            const d = ev.data as { id?: unknown };
            if (typeof d.id === "string") {
              pendingAssistantIdRef.current = d.id;
            }
          } else if (ev.event === "error") {
            const d = ev.data as { error?: unknown };
            setError(typeof d.error === "string" ? d.error : "Stream error.");
            setLoading(false);
            setStreamingContent("");
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
      setStreamingContent("");
      return;
    }

    // Stream completed. Commit the accumulated text as a real message.
    setLoading(false);
    const assistantId = pendingAssistantIdRef.current ?? undefined;
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: accumulated },
    ]);
    setStreamingContent("");
    if (!sawDone && !accumulated) {
      setError("The model returned an empty reply.");
    }
  };

  // ---- Render ------------------------------------------------------

  return (
    <div className="max-w-2xl mx-auto bg-white rounded shadow">
      <header className="flex items-center justify-between p-4 border-b">
        <div>
          <div className="flex items-center space-x-2">
            <span className="text-lg font-semibold text-gray-900">
              Speaking with: {persona.name}
            </span>
            {profile?.relationship && (
              <span className="text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full font-medium">
                {profile.relationship}
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500">simulation / character — not a real person</div>
        </div>
        <div className="flex space-x-2">
          <button
            type="button"
            onClick={() => {
              setShowProfile((v) => !v);
              if (!showProfile) setShowMemoryInput(false);
            }}
            className={`text-sm border px-3 py-1 rounded transition-colors ${
              showProfile
                ? "bg-gray-100 border-gray-400 text-gray-900 font-medium"
                : "hover:bg-gray-50 text-gray-700"
            }`}
          >
            {showProfile ? "Hide profile" : "View profile"}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowMemoryInput((v) => !v);
              if (!showMemoryInput) setShowProfile(false);
            }}
            className={`text-sm border px-3 py-1 rounded transition-colors ${
              showMemoryInput
                ? "bg-gray-100 border-gray-400 text-gray-900 font-medium"
                : "hover:bg-gray-50 text-gray-700"
            }`}
          >
            {showMemoryInput ? "Hide memories" : "Memories"}
          </button>
          <button
            type="button"
            onClick={onBack}
            className="text-sm border px-3 py-1 rounded hover:bg-gray-50 text-gray-700"
          >
            Change persona
          </button>
        </div>
      </header>

      {showProfile && (
        <ProfilePanel
          personaName={persona.name}
          profile={profile}
          onClose={() => setShowProfile(false)}
        />
      )}

      {showMemoryInput && (
        <div className="p-4 border-b bg-gray-50">
          <MemoryInput user={user} persona={persona} />
        </div>
      )}

      <div
        ref={listRef}
        onScroll={handleListScroll}
        className="p-4 space-y-3 h-96 overflow-y-auto bg-gray-100"
      >
        {loadingMore && (
          <p className="text-center text-gray-500 text-xs pt-2">
            Loading earlier messages…
          </p>
        )}
        {historyLoading && messages.length === 0 && !streamingContent && (
          <p className="text-center text-gray-500 text-sm pt-12">
            Loading conversation…
          </p>
        )}
        {!historyLoading && messages.length === 0 && !streamingContent && (
          <p className="text-center text-gray-500 text-sm pt-12">
            Start the conversation. {persona.name.split(" ")[0]} will reply in the style you described.
          </p>
        )}
        {messages.map((m, i) => {
          const isEditing = editingId !== null && m.id === editingId;
          const persisted = isPersistedId(m.id);
          const canEdit = m.role === "user" && persisted && !loading;
          const canDelete = persisted && !loading && !isEditing;
          return (
            <MessageBubble
              key={m.id ?? `local-${i}`}
              m={m}
              index={i}
              isEditing={isEditing}
              canEdit={canEdit}
              canDelete={canDelete}
              editingDraft={editingDraft}
              onDraftChange={setEditingDraft}
              onSaveEdit={saveEdit}
              onCancelEdit={cancelEdit}
              onEdit={() => startEdit(m)}
              onDelete={() => deleteMessage(m)}
            />
          );
        })}
        {streamingContent && (
          <div className="flex justify-start">
            <div
              role="status"
              aria-live="polite"
              aria-atomic="false"
              className="max-w-[80%] px-3 py-2 rounded shadow-sm bg-white text-gray-900 border"
            >
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

      <ChatComposer
        input={input}
        loading={loading}
        onInputChange={setInput}
        onSend={send}
        onCancel={cancel}
      />
    </div>
  );
}
