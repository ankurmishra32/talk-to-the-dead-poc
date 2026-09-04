// Pure helpers for transforming Firestore persona documents into the UI's
// PersonaItem shape, and for applying incremental onSnapshot change batches.
// Kept side-effect free so they can be unit-tested in isolation.

import type { DocumentChange, QueryDocumentSnapshot } from "firebase/firestore";
import type { PersonaItem, PersonaFirestoreDoc } from "./types";

/**
 * Maps a Firestore persona doc to our local shape. Defensive on every
 * field — old hand-written docs may not have every structured field,
 * and the rule layer rejects docs whose ownerId doesn't match the
 * requesting user anyway, so we only render what the user owns.
 */
export function mapPersonaDoc(
  d: QueryDocumentSnapshot,
  ownerId: string
): PersonaItem | null {
  const data = d.data() as PersonaFirestoreDoc;
  if (data.userId !== ownerId) return null;
  return {
    id: d.id,
    name: data.name ?? "(unnamed)",
    ownerId: data.userId ?? null,
    relationship: data.relationship ?? null,
    theyCalledYou: data.theyCalledYou ?? null,
    languages: Array.isArray(data.languages) ? data.languages : [],
    howTheySpoke: Array.isArray(data.howTheySpoke) ? data.howTheySpoke : [],
    speechExamples: Array.isArray(data.speechExamples) ? data.speechExamples : [],
    oftenSaid: Array.isArray(data.oftenSaid) ? data.oftenSaid : [],
    distinctiveStory: data.distinctiveStory ?? null,
  };
}

/**
 * Applies a docChanges batch to the local persona list. Same
 * incremental pattern as reconcileMessages — added/modified upsert by
 * id, removed drops by id. Order is preserved: new items append to the
 * end (matching the existing list's insertion order, which is
 * desc-by-createdAt because that's how Firestore served the first
 * snap).
 */
export function reconcilePersonas(
  prev: PersonaItem[],
  changes: DocumentChange[],
  ownerId: string
): PersonaItem[] {
  if (changes.length === 0) return prev;
  let next = prev;
  let mutated = false;
  for (const change of changes) {
    const id = change.doc.id;
    if (change.type === "removed") {
      const before = next.length;
      next = next.filter((p) => p.id !== id);
      if (next.length !== before) mutated = true;
      continue;
    }
    const incoming = mapPersonaDoc(change.doc, ownerId);
    if (!incoming) {
      // Doc is no longer ours (or is malformed) — drop it from the list.
      const before = next.length;
      next = next.filter((p) => p.id !== id);
      if (next.length !== before) mutated = true;
      continue;
    }
    const idx = next.findIndex((p) => p.id === id);
    if (idx === -1) {
      next = [...next, incoming];
    } else {
      next = [...next];
      next[idx] = incoming;
    }
    mutated = true;
  }
  return mutated ? next : prev;
}
