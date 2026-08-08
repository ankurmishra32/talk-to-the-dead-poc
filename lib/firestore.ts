// Server-side Firestore access for the /api/chat route.
//
// Uses Firestore's REST API rather than firebase-admin to keep the PoC
// dependency surface minimal. The API key from the client Firebase config
// is used for authorization. Memory listing is intentionally a "list all
// then filter" pattern because the REST API's structured-query endpoint
// is heavyweight and the PoC has very few memories per session.

const FIRESTORE_BASE = "https://firestore.googleapis.com/v1";
const IDENTITY_TOOLKIT_BASE = "https://identitytoolkit.googleapis.com/v1";

// Thrown by getUidFromAuthHeader when the request has no/invalid auth.
// The API route maps this to 401.
export class UnauthenticatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

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

type FirestoreFields = Record<string, { stringValue?: string; timestampValue?: string }>;
type FirestoreValue = { fields: FirestoreFields };

function readString(
  fields: Record<string, { stringValue?: string; timestampValue?: string }>,
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
function readStringArray(
  fields: Record<string, { stringValue?: string; timestampValue?: string; arrayValue?: { values?: Array<{ stringValue?: string }> } }>,
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
 * Extracts and verifies a Firebase ID token from the Authorization header.
 * Returns the authenticated user's uid, or throws UnauthenticatedError if
 * the header is missing, malformed, or the token is rejected by the
 * Identity Toolkit.
 *
 * Uses the legacy Firebase Auth REST API (`accounts:lookup`) which accepts
 * a `?key=<browser-api-key>` query parameter. We deliberately use the same
 * API key as the Firestore REST calls — the key identifies the Firebase
 * project, not the calling user.
 */
export async function getUidFromAuthHeader(
  authHeader: string | undefined
): Promise<string> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new UnauthenticatedError("Missing or malformed Authorization header.");
  }
  const idToken = authHeader.slice("Bearer ".length).trim();
  if (!idToken) {
    throw new UnauthenticatedError("Empty bearer token.");
  }

  const url = `${IDENTITY_TOOLKIT_BASE}/accounts:lookup?key=${getApiKey()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });

  if (!res.ok) {
    // 400 with INVALID_ID_TOKEN is the common case. We don't surface the
    // exact reason to the client — just 401.
    throw new UnauthenticatedError("ID token rejected by Identity Toolkit.");
  }

  type LookupResponse = {
    users?: Array<{ localId?: string; valid?: string | boolean }>;
  };
  const data = (await res.json()) as LookupResponse;
  const user = data.users?.[0];
  const uid = user?.localId;
  if (!uid || user.valid === false || user.valid === "false") {
    throw new UnauthenticatedError("Identity Toolkit did not return a valid user.");
  }
  return uid;
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
  oftenSaid?: string[];
  distinctiveStory?: string;
};

export type MemoryDoc = {
  text: string;
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
  requestingUid?: string
): Promise<PersonaDoc | null> {
  const url = `${FIRESTORE_BASE}/projects/${getProjectId()}/databases/${getDatabaseId()}/documents/personas/${encodeURIComponent(
    personaId
  )}?key=${getApiKey()}`;

  const res = await fetch(url);
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
    oftenSaid: readStringArray(fields, "oftenSaid"),
    distinctiveStory: readString(fields, "distinctiveStory") ?? undefined,
  };
}

export async function listMemoriesForPersona(
  personaId: string,
  limit = 20
): Promise<MemoryDoc[]> {
  // List all memories and filter by personaId. Sufficient for a PoC; can
  // be swapped for a structured query once memory volume grows.
  const url = `${FIRESTORE_BASE}/projects/${getProjectId()}/databases/${getDatabaseId()}/documents/memories?key=${getApiKey()}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Firestore listMemories failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { documents?: FirestoreValue[] };
  const docs = data.documents ?? [];

  const filtered = docs
    .map((d) => {
      const fields = d.fields;
      const text = readString(fields, "text");
      const personaIdValue = readString(fields, "personaId");
      const createdAt = fields.createdAt?.timestampValue ?? null;
      return { text, personaIdValue, createdAt };
    })
    .filter((m) => m.text && m.personaIdValue === personaId)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, limit)
    .map((m) => ({ text: m.text!, createdAt: m.createdAt }));

  return filtered;
}
