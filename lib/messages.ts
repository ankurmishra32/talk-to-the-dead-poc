// Pure helpers for transforming Firestore message documents into the
// UI's ChatMessage shape, and for applying incremental onSnapshot change
// batches. Kept side-effect free (no Firebase runtime imports — only the
// query types) so they can be unit-tested in isolation.
//
// Only the `type` import of QueryDocumentSnapshot / DocumentChange is used;
// these are erased at compile time, so this module has no runtime dependency
// on the Firebase SDK.

import type { DocumentChange, QueryDocumentSnapshot } from "firebase/firestore";
import type { ChatMessage } from "./types";

/** True when a message id corresponds to a real persisted Firestore doc. */
export function isPersistedId(id: string | undefined): id is string {
  return typeof id === "string" && !id.startsWith("local-");
}

/**
 * Maps Firestore message docs into our local ChatMessage shape and
 * reverses the desc-ordered input so the list renders chronologically.
 * Drops malformed docs silently — they should not exist if the chat
 * route only writes well-formed messages, but if a legacy/hand-written
 * doc slips through we don't want it crashing the render.
 */
export function mapMessageDocs(docs: QueryDocumentSnapshot[]): ChatMessage[] {
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
  changes: DocumentChange[],
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
