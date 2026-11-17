// Pure helpers for transforming Firestore message documents into the
// UI's ChatMessage shape, and for applying incremental onSnapshot change
// batches. Kept side-effect free and dependency-free (no Firebase imports —
// operates on the minimal FirestoreDocLike / FirestoreChangeLike shapes) so
// they can be unit-tested in isolation with lightweight fakes.

import type { ChatMessage, FirestoreDocLike, FirestoreChangeLike } from "./types";

/**
 * Limits on the conversation history sent to /api/chat. Shared by the client
 * (which trims before sending) and the server (which trims again rather than
 * rejecting), so a long chat never gets stuck on a 400.
 */
export const HISTORY_LIMITS = {
  maxMessages: 40,
  maxMessageChars: 4_000,
  maxTotalChars: 24_000,
} as const;

type HistoryLimits = {
  maxMessages: number;
  maxMessageChars: number;
  maxTotalChars: number;
};

/**
 * Picks the most recent messages that fit within `limits`, newest first, and
 * returns them in chronological order as bare `{ role, content }` objects
 * (ids and other UI fields are stripped).
 *
 * - Empty / whitespace-only messages are skipped.
 * - A message longer than `maxMessageChars` is shortened (keeping its start)
 *   instead of dropped, so a single long reply doesn't block the chat.
 * - The newest message is always kept, even if it alone exceeds the total.
 */
export function trimHistory(
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
  limits: HistoryLimits = HISTORY_LIMITS
): Array<{ role: "user" | "assistant"; content: string }> {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (out.length >= limits.maxMessages) break;
    const { role, content } = messages[i];
    if (!content.trim()) continue;
    const text =
      content.length > limits.maxMessageChars
        ? `${sliceCodeUnits(content, limits.maxMessageChars - 1)}…`
        : content;
    if (out.length > 0 && total + text.length > limits.maxTotalChars) break;
    out.push({ role, content: text });
    total += text.length;
  }
  return out.reverse();
}

/**
 * `str.slice(0, end)` that never ends on the first half of a surrogate pair
 * (an emoji), which would leave a broken character.
 */
function sliceCodeUnits(str: string, end: number): string {
  const code = str.charCodeAt(end - 1);
  const cutsPair = code >= 0xd800 && code <= 0xdbff;
  return str.slice(0, cutsPair ? end - 1 : end);
}

/**
 * Converts a Firestore `createdAt` value to epoch milliseconds. Handles SDK
 * Timestamps (`toMillis`), Dates, and returns undefined for anything else
 * (e.g. a pending server timestamp, which reads as null).
 */
export function toMillis(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { toMillis?: unknown }).toMillis === "function"
  ) {
    return (value as { toMillis: () => number }).toMillis();
  }
  return undefined;
}

/**
 * Inserts `incoming` keeping the list in time order: it goes after the last
 * message that is not newer than it. Messages without a timestamp (local-only
 * ones) don't move it. In the common case (a new message) this is an append.
 */
function insertByTime(list: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const t = incoming.createdAtMs;
  let idx = list.length;
  if (t !== undefined) {
    while (idx > 0) {
      const prevT = list[idx - 1].createdAtMs;
      if (prevT === undefined || prevT <= t) break;
      idx--;
    }
  }
  return [...list.slice(0, idx), incoming, ...list.slice(idx)];
}

/** The message document fields the mapping helpers read. */
type MessageDocData = {
  role?: string;
  content?: string;
  createdAt?: unknown;
  interrupted?: unknown;
};

/**
 * A reply the client has shown under a temporary local id while the server
 * saves it. Settled when the saved copy arrives (live listener) or its id
 * arrives over SSE.
 */
export type PendingReply = { localId: string; text: string };

/**
 * Pairs each pending reply with its saved copy among `changes` (an "added"
 * assistant doc):
 * - a completed reply is saved exactly as shown, so it must match exactly;
 * - a stopped (`interrupted`) reply may be saved with a few more tokens (in
 *   flight when the user pressed Stop), so its saved text only has to start
 *   with what was shown. The longest such match wins.
 * Each doc settles at most one pending reply and vice versa. Requiring exact
 * matches for completed replies stops a later reply that merely starts with
 * the same words from settling an older stopped one.
 */
export function matchSettledReplies(
  changes: FirestoreChangeLike[],
  pending: PendingReply[]
): Array<{ localId: string; docId: string }> {
  if (pending.length === 0) return [];
  const pairs: Array<{ localId: string; docId: string }> = [];
  const used = new Set<string>();
  for (const change of changes) {
    if (change.type !== "added") continue;
    const data = change.doc.data() as MessageDocData;
    if (data.role !== "assistant" || typeof data.content !== "string") continue;
    const content = data.content;
    const candidates = pending.filter((p) => !used.has(p.localId) && p.text !== "");
    let match = candidates.find((p) => p.text === content);
    if (!match && data.interrupted === true) {
      match = candidates
        .filter((p) => content.startsWith(p.text))
        .sort((a, b) => b.text.length - a.text.length)[0];
    }
    if (match) {
      used.add(match.localId);
      pairs.push({ localId: match.localId, docId: change.doc.id });
    }
  }
  return pairs;
}

/** The local ids of pending replies settled by `changes` (see matchSettledReplies). */
export function settledReplies(
  changes: FirestoreChangeLike[],
  pending: PendingReply[]
): string[] {
  return matchSettledReplies(changes, pending).map((p) => p.localId);
}

/**
 * Gives each settled temporary message its saved doc's id, in place, so the
 * following reconcileMessages updates it (content, timestamp, interrupted)
 * without moving it. Keeping the temporary copy's position is what keeps a
 * stopped reply right after the message it answers, whatever the clocks say.
 */
export function applySettledReplies(
  prev: ChatMessage[],
  pairs: Array<{ localId: string; docId: string }>
): ChatMessage[] {
  return pairs.reduce((list, p) => swapMessageId(list, p.localId, p.docId), prev);
}

/**
 * Prepends an older page, skipping messages already in the list. A message
 * sharing the oldest loaded message's exact timestamp can arrive both through
 * the live listener (createdAt >=) and through the next page (startAfter).
 */
export function prependOlder(prev: ChatMessage[], older: ChatMessage[]): ChatMessage[] {
  const known = new Set(prev.map((m) => m.id).filter(Boolean));
  const fresh = older.filter((m) => !m.id || !known.has(m.id));
  return fresh.length === 0 ? prev : [...fresh, ...prev];
}

/**
 * Gives a temporarily-keyed message its real document id. If the saved copy
 * already arrived under the real id, the temporary one is dropped instead,
 * so the message never shows twice.
 */
export function swapMessageId(
  prev: ChatMessage[],
  fromId: string,
  toId: string
): ChatMessage[] {
  if (!prev.some((m) => m.id === fromId)) return prev;
  if (prev.some((m) => m.id === toId)) return prev.filter((m) => m.id !== fromId);
  return prev.map((m) => (m.id === fromId ? { ...m, id: toId } : m));
}

/** True when a message id corresponds to a real persisted Firestore doc. */
export function isPersistedId(id: string | undefined): id is string {
  return typeof id === "string" && !id.startsWith("local-");
}

/**
 * Appends an incoming message to the list without introducing duplicate ids.
 *
 * The assistant reply can arrive twice: once from the SSE "done" handler (via
 * `pendingAssistantIdRef`) and once from the realtime onSnapshot "added" event
 * that carries the persisted doc with the same id. Upserting by id collapses
 * the duplicate.
 *
 * When `incoming.id` is falsy (e.g. the stream aborted before an "id" event),
 * a unique temp id is generated so unrelated appends never collide as React
 * keys.
 */
export function appendUniqueMessage(
  prev: ChatMessage[],
  incoming: ChatMessage
): ChatMessage[] {
  if (incoming.id) {
    const exists = prev.some((m) => m.id === incoming.id);
    if (exists) return prev;
    return [...prev, incoming];
  }
  const tempId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const marker = prev.some((m) => m.id === tempId);
  return [...prev, { ...incoming, id: marker ? `${tempId}-2` : tempId }];
}

/**
 * Maps Firestore message docs into our local ChatMessage shape and
 * reverses the desc-ordered input so the list renders chronologically.
 * Drops malformed docs silently — they should not exist if the chat
 * route only writes well-formed messages, but if a legacy/hand-written
 * doc slips through we don't want it crashing the render.
 */
export function mapMessageDocs(docs: FirestoreDocLike[]): ChatMessage[] {
  return docs
    .map((d): ChatMessage | null => {
      const data = d.data() as MessageDocData;
      if (
        (data.role === "user" || data.role === "assistant") &&
        typeof data.content === "string"
      ) {
        const role: "user" | "assistant" = data.role;
        const message: ChatMessage = { id: d.id, role, content: data.content };
        const createdAtMs = toMillis(data.createdAt);
        if (createdAtMs !== undefined) message.createdAtMs = createdAtMs;
        if (data.interrupted === true) message.interrupted = true;
        return message;
      }
      return null;
    })
    .filter((m): m is ChatMessage => m !== null)
    .reverse();
}

/**
 * Applies a Firestore docChanges batch to the local messages array.
 *
 * - "added" / "modified" → upsert by id; a new id is inserted in time
 *   order (by `createdAt`). If the id is in `dirtyIds`
 *   (the user has the message open in an editor), skip — local
 *   unsaved wins.
 * - "removed" → drop by id. Same dirty check; an in-flight edit
 *   should not be silently deleted by a remote event.
 * - Local-only messages (id starting with "local-") are preserved
 *   verbatim, so optimistic UI survives the first onSnapshot delivery.
 */
export function reconcileMessages(
  prev: ChatMessage[],
  changes: FirestoreChangeLike[],
  dirtyIds: Set<string>
): ChatMessage[] {
  if (changes.length === 0) return prev;
  let next = prev;
  let mutated = false;
  for (const change of changes) {
    const id = change.doc.id;
    if (dirtyIds.has(id)) continue;
    const data = change.doc.data() as MessageDocData;
    if (
      change.type === "removed" ||
      (data.role !== "user" && data.role !== "assistant") ||
      typeof data.content !== "string"
    ) {
      // Either a delete, or a malformed doc (shouldn't happen) — drop it.
      const before = next.length;
      next = next.filter((m) => m.id !== id);
      if (next.length !== before) mutated = true;
      continue;
    }
    const incoming: ChatMessage = {
      id,
      role: data.role,
      content: data.content,
    };
    const createdAtMs = toMillis(data.createdAt);
    if (createdAtMs !== undefined) incoming.createdAtMs = createdAtMs;
    if (data.interrupted === true) incoming.interrupted = true;
    const idx = next.findIndex((m) => m.id === id);
    if (idx === -1) {
      next = insertByTime(next, incoming);
    } else if (
      next[idx].content !== incoming.content ||
      next[idx].role !== incoming.role ||
      Boolean(next[idx].interrupted) !== Boolean(incoming.interrupted) ||
      // The server timestamp replaces an optimistic (browser-clock) one, so
      // later time-ordered inserts compare against the server's clock.
      (incoming.createdAtMs !== undefined &&
        incoming.createdAtMs !== next[idx].createdAtMs)
    ) {
      next = [...next];
      // Keep the known timestamp while the incoming one is still pending.
      next[idx] = { ...incoming, createdAtMs: incoming.createdAtMs ?? next[idx].createdAtMs };
    } else {
      continue;
    }
    mutated = true;
  }
  return mutated ? next : prev;
}
