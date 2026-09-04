// Pure helpers for transforming Firestore message documents into the
// UI's ChatMessage shape, and for applying incremental onSnapshot change
// batches. Kept side-effect free and dependency-free (no Firebase imports —
// operates on the minimal FirestoreDocLike / FirestoreChangeLike shapes) so
// they can be unit-tested in isolation with lightweight fakes.

import type { ChatMessage, FirestoreDocLike, FirestoreChangeLike } from "./types";

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
      const data = d.data() as { role?: string; content?: string };
      if (
        (data.role === "user" || data.role === "assistant") &&
        typeof data.content === "string"
      ) {
        const role: "user" | "assistant" = data.role;
        return { id: d.id, role, content: data.content };
      }
      return null;
    })
    .filter((m): m is ChatMessage => m !== null)
    .reverse();
}

/**
 * Applies a Firestore docChanges batch to the local messages array.
 *
 * - "added" / "modified" → upsert by id. If the id is in `dirtyIds`
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
    const data = change.doc.data() as { role?: string; content?: string };
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
    const idx = next.findIndex((m) => m.id === id);
    if (idx === -1) {
      next = [...next, incoming];
    } else if (
      next[idx].content !== incoming.content ||
      next[idx].role !== incoming.role
    ) {
      next = [...next];
      next[idx] = incoming;
    } else {
      continue;
    }
    mutated = true;
  }
  return mutated ? next : prev;
}
