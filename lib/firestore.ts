// Server-side Firestore data access for the /api/chat route.
//
// Uses Firestore's REST API rather than firebase-admin to keep the PoC
// dependency surface minimal. Requests carry the caller's verified Firebase
// ID token so Firestore rules enforce the same ownership boundary as the
// browser SDK. Memory listing uses a structured query constrained to the
// requesting user and persona, which also keeps the query compatible with
// the ownership rules.
//
// Auth verification (ID-token → uid) was previously in this file as
// getUidFromAuthHeader. It moved to lib/auth/server.ts as part of the
// auth-adapter seam. The data-access functions below still take a
// `requestingUid` for ownership checks — the route is responsible for
// obtaining that uid via the auth adapter before calling.

const FIRESTORE_BASE = "https://firestore.googleapis.com/v1";

import type { SpeechExample } from "./types";
export type { SpeechExample };

function getProjectId(): string {
  // Pulled from the same config the client uses. Keeping the value here
  // (rather than importing from firebase/config.ts) avoids dragging any
  // client-only Firebase modules into the server bundle.
  return process.env.FIREBASE_PROJECT_ID || "be-right-back-b47be";
}

function getDatabaseId(): string {
  // Named (non-default) databases are supported. The project was provisioned
  // with a database named "talk-to-the-dead" instead of the default "(default)".
  return process.env.FIREBASE_DATABASE_ID || "talk-to-the-dead";
}

function getApiKey(): string {
  const key = process.env.FIREBASE_API_KEY;
  if (!key) {
    throw new Error(
      "FIREBASE_API_KEY not configured. Add it to .env.local. " +
        "This is the same value used in firebase/config.ts."
    );
  }
  return key;
}

function authenticatedHeaders(authorization: string): HeadersInit {
  const token = authorization.trim();
  if (!token) {
    throw new Error("Missing Firebase ID token for Firestore request.");
  }
  return {
    // The route accepts either a standard Bearer header or a raw token;
    // Firestore REST requires the former.
    Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
  };
}

type FirestoreValueField = {
  stringValue?: string;
  timestampValue?: string;
  arrayValue?: {
    values?: Array<{
      stringValue?: string;
      mapValue?: {
        fields?: Record<string, { stringValue?: string }>;
      };
    }>;
  };
};

export type FirestoreFields = Record<string, FirestoreValueField>;
type FirestoreValue = { fields: FirestoreFields };

export function readString(
  fields: FirestoreFields,
  key: string
): string | null {
  const v = fields[key];
  return v?.stringValue ?? null;
}

/**
 * Reads a string array from a Firestore field. Returns an empty array if
 * the field is missing or not an array — callers can treat that as "no
 * values" rather than having to null-check.
 */
export function readStringArray(
  fields: FirestoreFields,
  key: string
): string[] {
  const v = fields[key];
  const values = v?.arrayValue?.values;
  if (!values) return [];
  return values
    .map((entry) => entry.stringValue)
    .filter((s): s is string => typeof s === "string");
}

/**
 * Reads an array of speech/behavioral example maps from a Firestore field.
 * Handles both structured SpeechExample entries and skips malformed items.
 */
export function readSpeechExamples(
  fields: FirestoreFields,
  key: string
): SpeechExample[] {
  const v = fields[key];
  const values = v?.arrayValue?.values;
  if (!values || !Array.isArray(values)) return [];
  return values
    .map((entry): SpeechExample | null => {
      const mapFields = entry?.mapValue?.fields;
      if (!mapFields) return null;
      const phrase = mapFields.phrase?.stringValue;
      const context = mapFields.context?.stringValue || mapFields.trigger?.stringValue;
      if (!phrase || !context) return null;
      const example: SpeechExample = {
        phrase: phrase.trim(),
        context: context.trim(),
      };
      const meaning = mapFields.meaning?.stringValue;
      if (meaning && meaning.trim()) {
        example.meaning = meaning.trim();
      }
      const tone = mapFields.tone?.stringValue || mapFields.emotion?.stringValue;
      if (tone && tone.trim()) {
        example.tone = tone.trim();
      }
      const reaction = mapFields.reaction?.stringValue;
      if (reaction && reaction.trim()) {
        example.reaction = reaction.trim();
      }
      return example;
    })
    .filter((e): e is SpeechExample => e !== null);
}

export type PersonaDoc = {
  id: string;
  name: string;
  ownerId: string;
  // Legacy free-text trait field. Still filled by older personas; for new
  // personas we leave it empty and rely on the structured fields below.
  traits: string;
  // Structured fields collected by the guided interview.
  relationship?: string;
  theyCalledYou?: string;
  languages?: string[];
  howTheySpoke?: string[];
  speechExamples?: SpeechExample[];
  oftenSaid?: string[];
  distinctiveStory?: string;
};

export type MemoryDoc = {
  text: string;
  createdAt?: string | null;
};

export type ConversationMessageDoc = {
  role: "user" | "assistant";
  content: string;
  userId: string;
  ownerUid: string;
  personaId: string;
  createdAt?: string | null;
};

/**
 * Fetches a persona by id. If `requestingUid` is provided, the persona is
 * only returned when its ownerId matches — otherwise the function behaves
 * as if the document didn't exist (returns null). This avoids leaking the
 * existence of someone else's persona via a 403 vs 404 distinction.
 */
export async function getPersona(
  personaId: string,
  requestingUid: string,
  authorization: string
): Promise<PersonaDoc | null> {
  const url = `${FIRESTORE_BASE}/projects/${getProjectId()}/databases/${getDatabaseId()}/documents/personas/${encodeURIComponent(
    personaId
  )}?key=${getApiKey()}`;

  const res = await fetch(url, { headers: authenticatedHeaders(authorization) });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Firestore getPersona failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as FirestoreValue;
  const fields = data.fields;
  const name = readString(fields, "name");
  const ownerId = readString(fields, "userId");
  if (!name || !ownerId) {
    throw new Error(`Persona ${personaId} is missing required fields.`);
  }
  if (requestingUid !== undefined && ownerId !== requestingUid) {
    // Treat cross-user access as "not found" so we don't leak existence.
    return null;
  }
  return {
    id: personaId,
    name,
    ownerId,
    // Legacy field — empty for new personas, may be populated for older ones.
    traits: readString(fields, "traits") ?? "",
    relationship: readString(fields, "relationship") ?? undefined,
    theyCalledYou: readString(fields, "theyCalledYou") ?? undefined,
    languages: readStringArray(fields, "languages"),
    howTheySpoke: readStringArray(fields, "howTheySpoke"),
    speechExamples: readSpeechExamples(fields, "speechExamples"),
    oftenSaid: readStringArray(fields, "oftenSaid"),
    distinctiveStory: readString(fields, "distinctiveStory") ?? undefined,
  };
}

export async function listMemoriesForPersona(
  personaId: string,
  userId: string,
  authorization: string,
  limit = 20
): Promise<MemoryDoc[]> {
  const url = `${FIRESTORE_BASE}/projects/${getProjectId()}/databases/${getDatabaseId()}/documents:runQuery?key=${getApiKey()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authenticatedHeaders(authorization),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "memories" }],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: "userId" },
                  op: "EQUAL",
                  value: { stringValue: userId },
                },
              },
              {
                fieldFilter: {
                  field: { fieldPath: "personaId" },
                  op: "EQUAL",
                  value: { stringValue: personaId },
                },
              },
            ],
          },
        },
        orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
        limit,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Firestore listMemories failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as Array<{ document?: FirestoreValue }>;
  return data
    .map((result) => result.document)
    .filter((document): document is FirestoreValue => document !== undefined)
    .map((d) => {
      const fields = d.fields;
      const text = readString(fields, "text");
      const createdAt = fields.createdAt?.timestampValue ?? null;
      return { text, createdAt };
    })
    .filter((m): m is { text: string; createdAt: string | null } => Boolean(m.text))
    .map((m) => ({ text: m.text!, createdAt: m.createdAt }));
}

/**
 * Appends a single message to a persona's conversation history.
 *
 * Called server-side from /api/chat after the LLM stream completes.
 * The route passes the verified UID as `userId`; clients cannot
 * influence this call, so the create-time userId check in
 * firestore.rules is effectively a server-side assertion here.
 *
 * Firestore REST wraps string fields in { stringValue: "..." } and
 * timestamps in { timestampValue: "..." } — the field value shape
 * is required by the REST API but the SDK handles it implicitly.
 *
 * The POST endpoint auto-generates a document ID when `documentId`
 * is omitted from the URL. We let Firestore generate it, and return
 * it to the caller so the route can echo it back to the client over
 * SSE — the client needs the id to enable later edit/delete of this
 * message via the Firestore SDK.
 */
export async function appendConversationMessage(
  personaId: string,
  message: { role: "user" | "assistant"; content: string },
  userId: string,
  authorization: string
): Promise<string> {
  const url = `${FIRESTORE_BASE}/projects/${getProjectId()}/databases/${getDatabaseId()}/documents/conversations/${encodeURIComponent(
    personaId
  )}/messages?key=${getApiKey()}`;

  const body = {
    fields: {
      ownerUid: { stringValue: userId },
      userId: { stringValue: userId },
      personaId: { stringValue: personaId },
      role: { stringValue: message.role },
      content: { stringValue: message.content },
      createdAt: { timestampValue: new Date().toISOString() },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authenticatedHeaders(authorization),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(
      `Firestore appendConversationMessage failed: ${res.status} ${await res.text()}`
    );
  }

  // Firestore REST returns { name: "projects/<p>/databases/<d>/documents/conversations/<pid>/messages/<msgId>" }.
  // The trailing path segment is the auto-generated doc id we want to surface.
  const data = (await res.json()) as { name?: string };
  const name = data.name ?? "";
  const id = name.split("/").pop() ?? "";
  if (!id) {
    throw new Error(
      `Firestore appendConversationMessage returned no document id (response name=${name}).`
    );
  }
  return id;
}
