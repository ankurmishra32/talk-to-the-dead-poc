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
  setDoc,
  deleteDoc,
  updateDoc,
  doc,
  startAfter,
  onSnapshot,
  serverTimestamp,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import MemoryInput from "./MemoryInput";
import { parseSseEvent } from "../lib/sse";
import {
  appendUniqueMessage,
  isPersistedId,
  mapMessageDocs,
  reconcileMessages,
  settledReplies,
  swapMessageId,
  trimHistory,
  type PendingReply,
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
import Confirm from "./Confirm";
import { strings } from "../lib/strings";

const PAGE_SIZE = 40;
// How long to wait for the user's message to save before giving up.
const SAVE_TIMEOUT_MS = 15_000;

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

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
  const [cursor, setCursor] = useState<QueryDocumentSnapshot | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pendingScrollAdjustRef = useRef<{
    distanceFromBottom: number;
  } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ChatMessage | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Replies shown under a temporary id until the server's saved copy (live
  // listener) or its real id (SSE "id" event) arrives. See settledReplies.
  const pendingRepliesRef = useRef<PendingReply[]>([]);
  const nearBottomRef = useRef(true);
  const dirtyIdsRef = useRef<Set<string>>(new Set());
  const sendingRef = useRef(false);
  const { getAccessToken } = useAuth();

  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    setMessages([]);
    setCursor(null);
    setHasMore(false);
    setLoadingMore(false);
    setEditingId(null);
    dirtyIdsRef.current = new Set();
    pendingRepliesRef.current = [];
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
            distinctiveStory: data.distinctiveStory ?? null,
          });
        }
      } catch (err) {
        if (!cancelled) {
          logger.error("Failed to load persona profile", err);
        }
      }
    }

    // History loading (A3): the first page is read once, then a live listener
    // covers everything from the oldest loaded message onwards with NO limit.
    // A limit(40) listener would report the oldest message as "removed" every
    // time a new one arrives (it falls out of the window), making messages
    // vanish mid-conversation. Older pages (loadOlder) stay static.
    let unsubscribeMessages: (() => void) | null = null;
    const messagesCol = collection(db, "conversations", persona.id, "messages");

    async function loadMessages() {
      try {
        const firstPage = await getDocs(
          query(
            messagesCol,
            where("userId", "==", user.uid),
            orderBy("createdAt", "desc"),
            limit(PAGE_SIZE)
          )
        );
        if (cancelled) return;
        setMessages(mapMessageDocs(firstPage.docs));
        const oldest = firstPage.docs[firstPage.docs.length - 1] ?? null;
        setCursor(oldest);
        setHasMore(firstPage.docs.length === PAGE_SIZE);
        setHistoryLoading(false);

        const oldestCreatedAt = oldest?.get("createdAt");
        const liveQuery = oldestCreatedAt
          ? query(
              messagesCol,
              where("userId", "==", user.uid),
              where("createdAt", ">=", oldestCreatedAt),
              orderBy("createdAt", "desc")
            )
          : query(messagesCol, where("userId", "==", user.uid), orderBy("createdAt", "desc"));
        unsubscribeMessages = onSnapshot(
          liveQuery,
          (snap) => {
            if (cancelled) return;
            const changes = snap.docChanges();
            // Computed outside the state updater (which StrictMode may run
            // twice) so the ref is only updated once.
            const settled = settledReplies(changes, pendingRepliesRef.current);
            if (settled.length > 0) {
              pendingRepliesRef.current = pendingRepliesRef.current.filter(
                (p) => !settled.includes(p.localId)
              );
            }
            setMessages((prev) => {
              const next = reconcileMessages(prev, changes, dirtyIdsRef.current);
              return settled.length > 0
                ? next.filter((m) => !m.id || !settled.includes(m.id))
                : next;
            });
          },
          (err) => {
            if (cancelled) return;
            logger.error("Conversation subscription failed", err);
            setError(strings.chat.syncFailed);
          }
        );
      } catch (err) {
        if (cancelled) return;
        logger.error("Failed to load conversation", err);
        setError(strings.chat.syncFailed);
        setHistoryLoading(false);
      }
    }

    loadMessages();
    loadProfile();
    return () => {
      cancelled = true;
      unsubscribeMessages?.();
    };
  }, [persona.id, persona.name, user.uid]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (!nearBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, streamingContent, loading]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, [persona.id]);

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

  const loadOlder = async () => {
    if (loadingMore || !hasMore || !cursor) return;
    const el = listRef.current;
    if (!el) return;
    setLoadingMore(true);
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
      pendingScrollAdjustRef.current = null;
      logger.error("Failed to load older messages", err);
      setError(strings.chat.loadOlderFailed);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (!hasMore || loadingMore) return;
    if (el.scrollTop < 80) {
      loadOlder();
    }
  };

  const startEdit = (m: ChatMessage) => {
    if (!m.id) return;
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
      dirtyIdsRef.current.delete(id);
    } catch (err) {
      logger.error("Failed to update message", err);
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? original : m))
      );
      dirtyIdsRef.current.delete(id);
      setError(strings.chat.saveEditFailed);
    }
  };

  const deleteMessage = async (m: ChatMessage) => {
    if (!m.id) {
      setMessages((prev) => prev.filter((x) => x !== m));
      return;
    }
    const id = m.id;
    const originalIndex = messages.findIndex((item) => item.id === id);
    setMessages((prev) => prev.filter((x) => x.id !== id));
    if (editingId === id) {
      setEditingId(null);
      setEditingDraft("");
    }
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
      setError(strings.chat.deleteMessageFailed);
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sendingRef.current) return;
    const text = input.trim();
    if (!text || loading) return;
    sendingRef.current = true;
    setError(null);
    setStreamingContent("");
    setLoading(true);

    // The doc id is assigned up front, so the optimistic message and the
    // realtime listener's copy share one id (no placeholder swap, no duplicate).
    const userRef = doc(collection(db, "conversations", persona.id, "messages"));
    const userMessage: ChatMessage = {
      id: userRef.id,
      role: "user",
      content: text,
      createdAtMs: Date.now(),
    };
    const history = [...messages, userMessage];
    setMessages((prev) => appendUniqueMessage(prev, userMessage));
    setInput("");

    let controller: AbortController | null = null;
    // Every exit path below goes through `finally`, so the composer can never
    // be left locked (A1).
    try {
      // Save the user's turn before asking for a reply (A5), so history never
      // has a reply without the message it answers. serverTimestamp keeps the
      // order right regardless of the browser's clock (A4).
      try {
        await withTimeout(
          setDoc(userRef, {
            userId: user.uid,
            personaId: persona.id,
            role: "user",
            content: text,
            createdAt: serverTimestamp(),
          }),
          SAVE_TIMEOUT_MS
        );
      } catch (err) {
        logger.error("Failed to persist user message", err);
        // If the write is only slow (e.g. offline queue), cancel it too, so the
        // message can't reappear later as a duplicate of the retry.
        deleteDoc(userRef).catch(() => {});
        setMessages((prev) => prev.filter((m) => m.id !== userRef.id));
        setInput((current) => current || text);
        setError(strings.chat.messageNotSaved);
        return;
      }

      const idToken = await getAccessToken();
      if (!idToken) {
        setError(strings.chat.signedOut);
        return;
      }

      controller = new AbortController();
      abortRef.current = controller;

      let res: Response;
      try {
        res = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          // Trimmed to the shared limits, so a long chat never hits a 400 (A2).
          body: JSON.stringify({ personaId: persona.id, messages: trimHistory(history) }),
          signal: controller.signal,
        });
      } catch (err) {
        if (!isAbortError(err)) setError(strings.chat.networkError);
        return;
      }

      if (res.status === 401) {
        setError(strings.chat.sessionExpired);
        return;
      }
      if (!res.ok || !res.body) {
        let detail = "";
        try {
          const data = (await res.json()) as { error?: string };
          detail = data.error ?? "";
        } catch {
          // ignore
        }
        setError(detail || strings.chat.sendFailure);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      let aborted = false;
      // Temporary id of this reply once it's shown as a message.
      let replyLocalId: string | null = null;

      // Shows the reply as a regular message right away (at "done", or with
      // the partial text after Stop) under a temporary id, and closes the
      // streaming bubble. The server's saved copy then replaces it.
      const commitReply = (text: string, interrupted: boolean) => {
        if (!text || replyLocalId) return;
        const localId = `local-reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        replyLocalId = localId;
        pendingRepliesRef.current = [...pendingRepliesRef.current, { localId, text }];
        const message: ChatMessage = { id: localId, role: "assistant", content: text };
        if (interrupted) message.interrupted = true;
        setMessages((prev) => [...prev, message]);
        setStreamingContent("");
        setLoading(false);
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const eventBlock = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const ev = parseSseEvent(eventBlock);
            if (!ev) continue;
            if (ev.event === "delta") {
              const d = ev.data as { delta?: unknown };
              if (typeof d.delta === "string") {
                accumulated += d.delta;
                setStreamingContent(accumulated);
              }
            } else if (ev.event === "done") {
              commitReply(accumulated, false);
            } else if (ev.event === "id") {
              const d = ev.data as { id?: unknown };
              if (typeof d.id === "string" && replyLocalId) {
                const fromId = replyLocalId;
                const toId = d.id;
                pendingRepliesRef.current = pendingRepliesRef.current.filter(
                  (p) => p.localId !== fromId
                );
                setMessages((prev) => swapMessageId(prev, fromId, toId));
              }
            } else if (ev.event === "error") {
              const d = ev.data as { error?: unknown };
              setError(typeof d.error === "string" ? d.error : strings.chat.streamError);
              return;
            }
          }
        }
      } catch (err) {
        if (!isAbortError(err)) {
          setError(strings.chat.streamInterrupted);
          return;
        }
        aborted = true;
      }

      // Normally the reply was committed at "done". Otherwise: after Stop,
      // show the partial text (the server saves it as `interrupted`). Empty
      // replies are never added (they'd be sent back as invalid history).
      if (!replyLocalId) {
        if (accumulated) {
          commitReply(accumulated, aborted);
        } else if (!aborted) {
          setError(strings.chat.emptyReply);
        }
      }
    } finally {
      if (controller && abortRef.current === controller) abortRef.current = null;
      setLoading(false);
      setStreamingContent("");
      sendingRef.current = false;
    }
  };

  const headerBtnClass = (active: boolean) =>
    `text-xs font-medium px-3 py-1.5 rounded-xl border transition-all duration-150 ${
      active
        ? "shadow-sm"
        : "hover:bg-stone-50"
    }`;

  return (
    <div
      className="max-w-2xl mx-auto rounded-3xl overflow-hidden flex flex-col"
      style={{ background: "var(--color-surface-raised)", boxShadow: "0 8px 40px -8px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.03)", height: "min(85vh, 720px)" }}
    >
      {/* Header */}
      <header
        className="shrink-0 px-6 py-4 flex items-center justify-between"
        style={{ borderBottom: "1px solid var(--color-border)", background: "var(--color-surface-raised)" }}
      >
        <div>
          <div className="flex items-center gap-2.5">
            <span className="text-lg font-semibold" style={{ color: "var(--color-text-primary)" }}>
              {strings.chat.header(persona.name)}
            </span>
            {profile?.relationship && (
              <span
                className="text-xs px-2.5 py-0.5 rounded-full font-medium"
                style={{ background: "var(--color-brand-light)", color: "var(--color-brand)" }}
              >
                {profile.relationship}
              </span>
            )}
          </div>
          <div className="text-xs mt-0.5" style={{ color: "var(--color-text-muted)" }}>
            {strings.chat.disclaimer}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setShowProfile((v) => !v);
              if (!showProfile) setShowMemoryInput(false);
            }}
            className={headerBtnClass(showProfile)}
            style={{
              background: showProfile ? "var(--color-brand-light)" : "transparent",
              borderColor: showProfile ? "transparent" : "var(--color-border)",
              color: showProfile ? "var(--color-brand)" : "var(--color-text-secondary)",
            }}
          >
            {showProfile ? strings.chat.hideProfile : strings.chat.viewProfile}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowMemoryInput((v) => !v);
              if (!showMemoryInput) setShowProfile(false);
            }}
            className={headerBtnClass(showMemoryInput)}
            style={{
              background: showMemoryInput ? "var(--color-brand-light)" : "transparent",
              borderColor: showMemoryInput ? "transparent" : "var(--color-border)",
              color: showMemoryInput ? "var(--color-brand)" : "var(--color-text-secondary)",
            }}
          >
            {showMemoryInput ? strings.chat.hideMemories : strings.chat.memories}
          </button>
          <button
            type="button"
            onClick={onBack}
            className="text-xs font-medium px-3 py-1.5 rounded-xl border hover:bg-stone-50"
            style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}
          >
            {strings.chat.changePersona}
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
        <div className="px-6 py-4 border-b" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
          <MemoryInput user={user} persona={persona} />
        </div>
      )}

      {/* Messages */}
      <div
        ref={listRef}
        onScroll={handleListScroll}
        className="flex-1 px-6 py-4 space-y-4 overflow-y-auto"
        style={{ background: "var(--color-surface)" }}
      >
        {loadingMore && (
          <p className="text-center text-xs pt-2" style={{ color: "var(--color-text-muted)" }}>
            {strings.chat.loadingEarlier}
          </p>
        )}
        {historyLoading && messages.length === 0 && !streamingContent && (
          <p className="text-center text-sm pt-16" style={{ color: "var(--color-text-muted)" }}>
            {strings.chat.loadingConversation}
          </p>
        )}
        {!historyLoading && messages.length === 0 && !streamingContent && (
          <p className="text-center text-sm pt-16 max-w-xs mx-auto leading-relaxed" style={{ color: "var(--color-text-muted)" }}>
            {strings.chat.emptyPrompt(persona.name)}
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
              onDelete={() => setPendingDelete(m)}
            />
          );
        })}
        {streamingContent && (
          <div className="flex justify-start">
            <div
              role="status"
              aria-live="polite"
              aria-atomic="false"
              className="max-w-[80%] px-4 py-3 rounded-2xl rounded-bl-md text-sm leading-relaxed border shadow-sm"
              style={{ background: "var(--color-surface-raised)", borderColor: "var(--color-border)", color: "var(--color-text-primary)" }}
            >
              {streamingContent}
              <span className="inline-block w-1.5 h-4 ml-0.5 animate-pulse align-middle rounded-full" style={{ background: "var(--color-brand)" }} />
            </div>
          </div>
        )}
        {loading && !streamingContent && (
          <div className="flex justify-start">
            <div
              className="px-4 py-3 rounded-2xl rounded-bl-md text-sm italic border shadow-sm"
              style={{ background: "var(--color-surface-raised)", borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
            >
              {strings.chat.typing(persona.name)}
            </div>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div
          className="px-6 py-3 border-t text-sm"
          style={{ background: "var(--color-danger-light)", borderColor: "rgba(220, 38, 38, 0.15)", color: "var(--color-danger)" }}
        >
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

      <Confirm
        open={pendingDelete !== null}
        title={strings.chat.confirmDeleteTitle}
        message={strings.chat.confirmDeleteMessage}
        onConfirm={() => {
          if (pendingDelete) deleteMessage(pendingDelete);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
