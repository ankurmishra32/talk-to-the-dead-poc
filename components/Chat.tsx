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
import Confirm from "./Confirm";
import { strings } from "../lib/strings";

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
  const pendingAssistantIdRef = useRef<string | null>(null);
  const nearBottomRef = useRef(true);
  const dirtyIdsRef = useRef<Set<string>>(new Set());
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
          isFirstMessagesSnap = false;
          const loaded = mapMessageDocs(snap.docs);
          setMessages(loaded);
          setCursor(snap.docs[snap.docs.length - 1] ?? null);
          setHasMore(snap.docs.length === PAGE_SIZE);
          setHistoryLoading(false);
          return;
        }
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
            : strings.chat.syncFailed
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
      setError(
        err instanceof Error ? err.message : strings.chat.loadOlderFailed
      );
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
      setError(
        err instanceof Error ? err.message : strings.chat.saveEditFailed
      );
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
      setError(
        err instanceof Error ? err.message : strings.chat.deleteMessageFailed
      );
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

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
    pendingAssistantIdRef.current = null;

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

    const idToken = await getAccessToken();
    if (!idToken) {
      setLoading(false);
      setError(strings.chat.signedOut);
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
      setError(err instanceof Error ? err.message : strings.chat.networkError);
      return;
    }

    if (res.status === 401) {
      setLoading(false);
      setError(strings.chat.sessionExpired);
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
      setError(detail || strings.chat.sendFailure);
      return;
    }

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
            sawDone = true;
          } else if (ev.event === "id") {
            const d = ev.data as { id?: unknown };
            if (typeof d.id === "string") {
              pendingAssistantIdRef.current = d.id;
            }
          } else if (ev.event === "error") {
            const d = ev.data as { error?: unknown };
            setError(typeof d.error === "string" ? d.error : strings.chat.streamError);
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
      setError(err instanceof Error ? err.message : strings.chat.streamInterrupted);
      setStreamingContent("");
      return;
    }

    setLoading(false);
    const assistantId = pendingAssistantIdRef.current ?? undefined;
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: accumulated },
    ]);
    setStreamingContent("");
    if (!sawDone && !accumulated) {
      setError(strings.chat.emptyReply);
    }
  };

  return (
    <div className="max-w-2xl mx-auto bg-white rounded shadow">
      <header className="flex items-center justify-between p-4 border-b">
        <div>
          <div className="flex items-center space-x-2">
            <span className="text-lg font-semibold text-gray-900">
              {strings.chat.header(persona.name)}
            </span>
            {profile?.relationship && (
              <span className="text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full font-medium">
                {profile.relationship}
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500">{strings.chat.disclaimer}</div>
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
            {showProfile ? strings.chat.hideProfile : strings.chat.viewProfile}
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
            {showMemoryInput ? strings.chat.hideMemories : strings.chat.memories}
          </button>
          <button
            type="button"
            onClick={onBack}
            className="text-sm border px-3 py-1 rounded hover:bg-gray-50 text-gray-700"
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
            {strings.chat.loadingEarlier}
          </p>
        )}
        {historyLoading && messages.length === 0 && !streamingContent && (
          <p className="text-center text-gray-500 text-sm pt-12">
            {strings.chat.loadingConversation}
          </p>
        )}
        {!historyLoading && messages.length === 0 && !streamingContent && (
          <p className="text-center text-gray-500 text-sm pt-12">
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
              {strings.chat.typing(persona.name)}
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
