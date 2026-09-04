// Shared domain types for the talk-to-the-dead PoC.
//
// These shapes are used by the client components (Chat.tsx,
// PersonaSelection.tsx), by the server route (pages/api/chat.ts), and by
// lib/prompts.ts / lib/firestore.ts. Consolidating them here means a schema
// change updates one place instead of having parallel type declarations with
// drift risk.

/** A single structured behavioral/ speech example for a persona. */
export type SpeechExample = {
  phrase: string;
  context: string;
  meaning?: string;
  tone?: string;
  reaction?: string;
};

/** A persona as stored in Firestore (server-side read returns nullable fields). */
export type PersonaDoc = {
  id: string;
  name: string;
  ownerId?: string;
  // Legacy free-text trait field. Empty for new personas; may be populated
  // for older ones. Note: lib/prompts.ts uses `traits: string`, while the
  // server's getPersona surfaces it as a string. Kept required for the
  // prompt builder's convenience.
  traits: string;
  relationship?: string;
  theyCalledYou?: string;
  languages?: string[];
  howTheySpoke?: string[];
  speechExamples?: SpeechExample[];
  oftenSaid?: string[];
  distinctiveStory?: string;
};

/** A single saved memory as stored in Firestore. */
export type MemoryDoc = {
  text: string;
  createdAt?: string | null;
};

/**
 * A message in the conversation list, as the UI models it.
 *
 * `id` is the Firestore document id. It is absent for local-only messages —
 * e.g. a partially-streamed assistant reply captured after a Cancel, or a
 * user message whose addDoc is still in flight. When `id` starts with
 * "local-" it is a temporary client-side key used to match the eventual
 * Firestore id back to this exact message.
 */
export type ChatMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
};

/** The subset of the Firebase user used by components. */
export type MinimalUser = {
  uid: string;
};

/** The minimal persona identity needed to select/enter a chat. */
export type PersonaReference = {
  id: string;
  name: string;
};

/** A list item persona with nullable optional fields (client-facing). */
export type PersonaItem = {
  id: string;
  name: string;
  ownerId: string | null;
  relationship?: string | null;
  theyCalledYou?: string | null;
  languages?: string[];
  howTheySpoke?: string[];
  speechExamples?: SpeechExample[];
  oftenSaid?: string[];
  distinctiveStory?: string | null;
};

/** The full persona profile shown in the chat header ("View profile"). */
export type FullPersonaProfile = {
  id: string;
  name: string;
  relationship?: string | null;
  theyCalledYou?: string | null;
  languages?: string[];
  howTheySpoke?: string[];
  speechExamples?: SpeechExample[];
  oftenSaid?: string[];
  distinctiveStory?: string | null;
};

/** The raw Firestore document shape for a persona (as written/read). */
export type PersonaFirestoreDoc = {
  name?: string;
  userId?: string;
  relationship?: string;
  theyCalledYou?: string;
  languages?: string[];
  howTheySpoke?: string[];
  speechExamples?: SpeechExample[];
  oftenSaid?: string[];
  distinctiveStory?: string;
  traits?: string;
};
