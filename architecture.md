# Talk to the Dead — System Architecture

This document describes how the `talk-to-the-dead-poc` codebase is wired together. It is the technical companion to [`prd.md`](./prd.md) (what the product does).

> **Also read the project `AGENTS.md`** for conventions and behavioral requirements before persona or prompt work.

---

## 1. Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (pages router) + React 19 + TypeScript |
| Styling | Tailwind CSS v4 |
| Auth | Firebase Auth (email/password) — adapter-shaped for future swap |
| Database | Cloud Firestore, **named database** `talk-to-the-dead` |
| LLM | Adapter interface in `lib/llm/` — LCM Studio (default) or Ollama |
| Rate limiting | In-process per-UID token bucket + concurrency cap (`lib/rate-limit.ts`) |
| Server-side data access | Firestore REST + Identity Toolkit REST (no `firebase-admin`) |

### Why no `firebase-admin`?
The server verifies ID tokens and reads/writes Firestore using raw `fetch` against Google's REST APIs instead of the Admin SDK. Smaller dependency surface, same functionality — the API key already needed for Firestore REST also works for `accounts:lookup`.

### Why a named Firestore database?
The Firebase project was provisioned with a non-default database named `talk-to-the-dead`. Both the client SDK and the server-side REST wrapper point at this database explicitly. **Do not change it** without updating `lib/firestore.ts`'s `getDatabaseId()` and `firebase/config.ts`'s `getFirestore(app, ...)`.

### Why adapter-shaped auth and LLM?
Both providers sit behind a small interface (`lib/auth/types.ts`, `lib/llm/types.ts`) and are selected by env-var-driven factories. Swapping providers is a new file plus an env var — no changes to routes, components, or other modules. The Firebase JS SDK is split into `firebase.client.ts` / `firebase.server.ts` so it never lands in the Node server bundle.

---

## 2. High-Level Architecture

```
+----------------+        POST /api/chat             +----------------------+
|  Browser       |   Authorization: Bearer <idTok>   |  Next.js API route   |
|  (React app)   | --------------------------------> |  (pages/api/chat.ts) |
|                | <-------------------------------- |                      |
|  - useAuth()   |   text/event-stream (SSE)         |  1. verifyAccessToken|
|  - parse SSE   |     event: delta { delta: "..."}  |  2. checkRequestRate |
|  - render live |     event: done  { reply: "..."}  |  3. getPersona +     |
|                |     event: error { error: "..."}  |     listMemories     |
+----------------+                                   |  4. acquireStreamSlot|
|  (after Send)  | -- addDoc(conversations/.../msgs) |  5. llmAdapter.stream|
|  (on mount)    | -- getDocs(conversations/.../msgs)|  6. pipe stream      |
+----------------+                                   |  7. on done: persist |
                                                     |  8. releaseStreamSlot|
+----------------+                                   +----------+-----------+
| Firebase Auth  | -- accounts:lookup (server) ------+           |
| IdentityToolkit|                                          |
+----------------+                                              v
                                                     +----------------------+
+----------------+        Firestore REST             | LLM adapter          |
|  Firestore     | <-- getPersona/listMemories ----- |  lm-studio | ollama  |
|  (named db)    | <-- appendConversationMessage --+ +----------------------+
+----------------+                                   |
| Personas etc.  | -- getDocs/addDoc (client SDK) ---- Browser
+----------------+
```

Two distinct data paths:
- **Client SDK path** — components read/write Firestore directly with the user's auth token. Protected by Firestore security rules.
- **Server REST path** — the API route reads/writes Firestore with `?key=<FIREBASE_API_KEY>`. This uses the API key's privileges, not the user's token, so the route's own ownership checks protect this path.

---

## 3. Request Lifecycle — `POST /api/chat`

`pages/api/chat.ts` is the only route. It returns `text/event-stream`.

1. **Method check** — only `POST` (405 otherwise).
2. **Body validation** — `{ personaId: string, messages: ChatMessage[] }`. Cap: 40 messages, 4000 chars each, 24000 total. Each message is `{ role: "user"|"assistant", content: string }`.
3. **Auth** — `authAdapter.verifyAccessToken(authorization)` → `uid` (401 on failure).
4. **Rate limit** — `checkRequestRate(uid)` — token bucket (default 10/min, burst 5). 429 + `Retry-After` on reject.
5. **Load persona** — `getPersona(personaId, uid, authorization)`. Returns `null` → 404 (ownership enforced, **no existence leak**).
6. **Load memories** — `listMemoriesForPersona(personaId, uid, authorization, 20)` — structured query, max 20.
7. **Build prompt** — `buildSystemPrompt(persona, memories)` (see §8).
8. **Concurrency cap** — `acquireStreamSlot(uid)` — per-UID (default 2) + global (default 10). 503 on reject.
9. **LLM stream** — `llmAdapter.streamChat({ system, messages }, signal)` → `{ stream, finalReply, completed }`.
10. **SSE headers** — `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `res.flushHeaders()`.
11. **Pipe stream** — read chunks from the upstream `ReadableStream`, write raw bytes to `res`.
12. **Persistence** — after the stream ends, await `finalReply` + `completed`. If `completed === true`, call `appendConversationMessage(...)` (returns the Firestore doc id), emit `event: id { id }`, then `releaseStreamSlot(uid)` + `res.end()`.
13. **Abort** — `req.on("close", () => ac.abort())` — a client disconnect cancels the LLM stream.

The client sends its **last 40 messages** in the request body (matching the route's `slice(-40)` cap).

---

## 4. Project Layout

```
components/
├── Chat.tsx              # Streaming chat UI: ReadableStream + SSE parser, pagination,
│                         #   optimistic writes, edit/delete, profile & memory toggles
├── MemoryInput.tsx       # Memory CRUD surface (capture, view, edit, delete)
├── PersonaSelection.tsx  # Guided persona interview + create/edit/delete/list personas
├── DeleteAccountModal.tsx# Account deletion confirmation (re-auth + type DELETE)
└── Confirm.tsx           # Reusable accessible confirm dialog
firebase/
└── config.ts             # Firebase client SDK init (named db "talk-to-the-dead")
lib/
├── auth/                 # Auth adapter (client/server split so Firebase SDK never
│   │                     #   reaches the Node bundle)
│   ├── types.ts          #   AuthAdapter, AuthUser contract
│   ├── firebase.client.ts#   Client-side Firebase implementation
│   ├── firebase.server.ts#   Server-side REST implementation (accounts:lookup)
│   ├── client.ts         #   Client entry (factory)
│   ├── server.ts         #   Server entry (factory)
│   ├── useAuth.ts        #   React hook
│   └── index.ts          #   Type re-exports
├── llm/                  # LLM adapter (provider-swappable)
│   ├── types.ts          #   LlmAdapter, LlmStream contract
│   ├── lm-studio.ts      #   LM Studio impl (OpenAI SSE → app SSE)
│   ├── ollama.ts         #   Ollama impl (NDJSON → app SSE)
│   └── index.ts          #   Provider factory
├── rate-limit.ts         # Per-UID token bucket + concurrency cap
├── firestore.ts          # Server-side Firestore + Identity Toolkit REST wrapper
├── users.ts              # Client-side user profile helpers (get/createUserProfile)
├── account.ts            # Account deletion: Firestore cleanup + Firebase Auth deleteUser
├── logger.ts             # createLogger() — log technical detail, not user copy
├── strings.ts            # Centralized user-facing strings incl. friendly errors
└── prompts.ts            # Pure system-prompt builder (no IO, easily testable)
pages/
├── _app.tsx
├── index.tsx             # Login (email + password)
├── signup.tsx            # 2-step signup wizard (Account → Profile)
├── dashboard.tsx         # Persona picker → chat; profile guard → /signup
└── api/
    └── chat.ts           # POST endpoint (streams SSE, persists reply)
styles/globals.css        # Tailwind v4 entry
firestore.rules           # Security rules — DEPLOY before going live
firestore.indexes.json    # Composite indexes for owner-scoped queries
```

---

## 5. Data Model (field-level)

### users/{uid}
| Field | Type | Notes |
|---|---|---|
| `uid` | string | Firebase uid — key of the document |
| `email` | string | Account email (denormalized) |
| `displayName` | string | Required at signup |
| `phone` | string? | Optional, `null` if not supplied |
| `onboardingHint` | string? | Optional "who do you remember" free text |
| `createdAt` | timestamp | `serverTimestamp()` at signup |

Created on signup step 2 via `createUserProfile()` in `lib/users.ts` (client
SDK). Used by the dashboard guard (redirect to `/signup` when missing) and
removed by account deletion in `lib/account.ts`.

### personas/{personaId}
| Field | Type | Notes |
|---|---|---|
| `name` | string | Required |
| `userId` | string | Firebase uid — owner |
| `relationship` | string? | Mother/Father/Grandparent/Sibling/Friend/Partner/Other |
| `theyCalledYou` | string? | How the persona addressed the user |
| `languages` | string[]? | Hindi/English/Hinglish/Other |
| `howTheySpoke` | string[]? | Quiet/Talkative/Direct/Playful/Sarcastic/Formal/Emotional/Blunt |
| `speechExamples` | SpeechExample[]? | Behavioral patterns |
| `oftenSaid` | string[]? | **Legacy** — always populated as `speechExamples.map(→phrase)` |
| `traits` | string | **Legacy** — empty string for new personas |
| `distinctiveStory` | string? | Free-text background |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp? | Only on edit |

**SpeechExample** (`lib/firestore.ts`):
```ts
{
  phrase: string;      // Required — characteristic expression
  context: string;     // Required — trigger/situation
  meaning?: string;    // Optional — underlying intent
  tone?: string;       // Optional — emotional tone
  reaction?: string;   // Optional — typical behavioral follow-up
}
```
Legacy aliases accepted during read: `trigger` → `context`, `emotion` → `tone`.

### memories/{memoryId}
| Field | Type | Notes |
|---|---|---|
| `userId` | string | Owner |
| `personaId` | string? / null | Attached persona (null = global memory) |
| `text` | string | |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp? | Only on edit |

### conversations/{personaId}/messages/{msgId}
| Field | Type | Notes |
|---|---|---|
| `userId` | string | Same uid both sides — user owns the conversation |
| `personaId` | string | Denormalized so rules needn't traverse up |
| `role` | "user" \| "assistant" | |
| `content` | string | |
| `createdAt` | timestamp | |

Each message is its own document — avoids the 1 MiB limit and enables per-message pagination/edit/delete.

**Composite indexes** (`firestore.indexes.json`):
- `personas`: userId ASC + createdAt DESC
- `memories`: userId ASC + createdAt DESC; also userId + personaId + createdAt DESC
- `messages`: userId ASC + createdAt DESC

---

## 6. LLM Adapter — `lib/llm/`

### Interface (`types.ts`)
```ts
type LlmAdapter = {
  streamChat(req: ChatRequest, signal: AbortSignal): Promise<LlmStream>;
};
type LlmStream = {
  stream: ReadableStream<Uint8Array>; // SSE-formatted bytes emitted by the adapter
  finalReply: Promise<string>;        // accumulated text
  completed: Promise<boolean>;        // true only on clean completion
};
```

The adapter owns the provider-specific wire format translation and emits the app's uniform SSE vocabulary (`event: delta` / `done` / `error`). The route just pipes `stream` to `res` — it never deals with NDJSON or OpenAI chunks, and it gets `finalReply` for persistence without re-parsing the SSE bytes.

### Factory (`index.ts`)
`LLM_PROVIDER` env var: `"lm-studio"` (default) or `"ollama"`.

### LM Studio (`lm-studio.ts`)
- Endpoint: `{LM_STUDIO_BASE_URL}/chat/completions` (default `http://localhost:1234/v1`), OpenAI-compatible.
- Inbound SSE: `data: {"choices":[{"delta":{"content":"..."}}]}` … `data: [DONE]`.
- Model: `LM_STUDIO_MODEL` (default `qwen3.5:9b`). Optional `LM_STUDIO_API_KEY`.
- Note: the active model can differ from the env default — see the project `AGENTS.md`.

### Ollama (`ollama.ts`)
- Endpoint: `{OLLAMA_HOST}/api/chat` (default `http://localhost:11434`), streamed NDJSON.
- Inbound: `{"message":{"content":"..."},"done":false}` … `{"done":true}`.
- Model: `OLLAMA_MODEL` (default `llama3.2`).

Both adapters handle network errors, HTTP errors, and mid-stream failure by emitting `event: error` and resolving `completed: false` (so the route won't persist a truncated reply).

---

## 7. Auth Adapter — `lib/auth/`

### Interface (`types.ts`)
`AuthAdapter` exposes `signIn`, `signUp`, `signOut`, `onAuthChange`, `getAccessToken` (client) and `verifyAccessToken` (server).

### Client (`firebase.client.ts` + `useAuth.ts`)
- Uses Firebase JS SDK: `signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, `onAuthStateChanged`.
- `useAuth()` hook returns `{ user, loading, signIn, signUp, signOut, getAccessToken }`.
- `getAccessToken()` calls `auth.currentUser.getIdToken()` → raw ID token for API calls.
- Selector: `NEXT_PUBLIC_AUTH_PROVIDER` (default `"firebase"`).

### Server (`firebase.server.ts`)
- `verifyAccessToken(token)` strips `Bearer `, POSTs to `identitytoolkit.googleapis.com/v1/accounts:lookup?key=<FIREBASE_API_KEY>` with `{ idToken }`, returns `{ uid, email }`.
- Selector: `AUTH_PROVIDER` (default `"firebase"`).

### Client-side account lifecycle (outside the adapter)
Signup, profile persistence, and deletion are handled directly with the client
SDK (via `lib/users.ts` / `lib/account.ts`), not through the adapter:
- `createUserProfile()` writes `users/{uid}` after `signUp()`.
- `deleteAccount()` re-authenticates with `EmailAuthProvider.credential`,
  batch-deletes a user's Firestore data (personas, memories, conversation
  messages via `deleteQueryBatch`, then the profile doc), and calls
  `deleteUser()` on the Firebase Auth account.

---

## 8. Prompt Assembly — `lib/prompts.ts`

`buildSystemPrompt(persona, memories)` is a **pure function** (no IO) producing seven sections:

1. **Identity & Relationship Frame** — simulation framing + terms of address.
2. **Languages & Communication Nuances** — pragmatics; preserve idiom/slang; don't translate literally.
3. **Behavioral Patterns & Situational Responses** (highest priority) — each speechExample as Trigger / Tone / Phrase / Meaning / Reaction with execution rules (chain, don't mechanically insert, precedence over stereotypes). Legacy fallback: bare `oftenSaid` list with a "don't recite mechanically" rule.
4. **General Speaking Style** — `howTheySpoke` joined; "don't caricature."
5. **Memories & Background Context** — `distinctiveStory` + numbered memories.
6. **Conversational Discipline** — avoid chatbot boilerplate, first person, 1–3 sentence replies, don't invent facts, deflect unknowns.
7. **Simulation Note** — "This conversation is an AI simulation."

---

## 9. Firestore REST Wrapper — `lib/firestore.ts`

All access via `https://firestore.googleapis.com/v1` with `?key=<FIREBASE_API_KEY>`.

Helpers:
- `getProjectId()` → `FIREBASE_PROJECT_ID` or `"be-right-back-b47be"`
- `getDatabaseId()` → `FIREBASE_DATABASE_ID` or `"talk-to-the-dead"`
- `getApiKey()` → `FIREBASE_API_KEY` (throws if missing)
- `authenticatedHeaders(authorization)` — normalizes Bearer prefix

Value parsers: `readString`, `readStringArray`, `readSpeechExamples` (handles `mapValue.fields` + legacy `trigger`/`emotion` aliases).

Exports:
- `getPersona(personaId, requestingUid, authorization)` → `PersonaDoc | null` — ownership check returns `null` on mismatch.
- `listMemoriesForPersona(personaId, userId, authorization, limit=20)` → `MemoryDoc[]` — POST `runQuery` with a structured AND filter (userId + personaId), ordered createdAt DESC.
- `appendConversationMessage(personaId, message, userId, authorization)` → `string` — POST auto-generated doc, returns the Firestore-assigned id.

---

## 10. Rate Limiting — `lib/rate-limit.ts`

- `checkRequestRate(uid)` — per-UID **token bucket**: `RATE_LIMIT_PER_MINUTE` (default 10), `RATE_LIMIT_BURST` (default 5). Returns 429 + `Retry-After` on reject.
- `acquireStreamSlot(uid)` / `releaseStreamSlot(uid)` — **concurrency cap**: `RATE_LIMIT_CONCURRENCY_PER_UID` (default 2) + `RATE_LIMIT_CONCURRENCY_GLOBAL` (default 10). Returns 503 when saturated.
- In-process (a fresh Map per cold start). Fine for a personal project; replace with a Redis-backed implementation for multi-instance scale.

---

## 11. Streaming Chat Protocol

`POST /api/chat` → `text/event-stream`.

| Server event | Data payload | When |
|---|---|---|
| `event: delta` | `{ "delta": "Hello" }` | One per token from the LLM |
| `event: done` | `{ "reply": "Hello, beta." }` | LLM signals end-of-stream |
| `event: id` | `{ "id": "<firestore id>" }` | Assistant reply persisted (after `done`) |
| `event: error` | `{ "error": "..." }` | Upstream error; client stops |

Client (`components/Chat.tsx`) `parseSseEvent()` splits on `\n\n`, extracts event name + JSON data, and drives a live message bubble (append on `delta`, commit on `done`). A Cancel button aborts via `AbortController`, preserving partial text.

---

## 12. History Persistence & Realtime Sync

- **On mount / persona change:** `onSnapshot` on `conversations/{personaId}/messages`, ordered createdAt DESC, limited to latest 40. Subsequent snapshots apply incremental `DocumentChange`s (added/modified/removed) via `reconcileMessages` — no re-fetch.
- **Pagination:** scroll up → one-shot cursor query (`startAfter(cursor)`, page size 40). Scroll position preserved via `distanceFromBottom` + `useLayoutEffect` so the prepend doesn't jump the view.
- **On Send:** user message is written via SDK *before* the LLM request; optimistic local update shows it immediately. The realtime subscription echoes it back as `added`; `reconcileMessages` upserts by id (no duplicate).
- **On stream completion:** the route persists the assistant reply via `appendConversationMessage`; client saw `done` already, so the subscription's `added` echo replaces the optimistic copy.
- **Edit / delete:** each mutation marks the id "dirty" in a ref, so concurrent `modified`/`removed` events for that id are ignored until the mutation resolves ("local unsaved wins"). Remote edits on other devices propagate normally unless the row is open.
- **On reload:** messages load from Firestore on mount.

Realtime sync covers the active chat's **initial 40-message window** and the **persona list**. Older paginated pages are static until scrolled back to.

---

## 13. Security Model

Four layers:

1. **Firebase Auth** — ID tokens verified server-side via the auth adapter; the resulting uid drives every downstream check.
2. **Server-side ownership** — `getPersona(personaId, requestingUid)` returns `null` on mismatch → route maps to **404** (not 403) so another user's persona existence isn't leaked.
3. **Firestore Security Rules** (`firestore.rules`) — gate all client SDK reads/writes. Each user can only access their own `personas`, `memories`, `conversations/{personaId}/messages`. **Must be deployed manually** (`firebase deploy --only firestore:rules`) or the database is world-readable/writable.
4. **Rate limiting** — token bucket + concurrency cap (see §10).

---

## 14. Environment Variables

| Var | Default | Where |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | (empty) | `firebase/config.ts` |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `"be-right-back-b47be.firebaseapp.com"` | `firebase/config.ts` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `"be-right-back-b47be"` | `firebase/config.ts` |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | `"be-right-back-b47be.appspot.com"` | `firebase/config.ts` |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | (empty) | `firebase/config.ts` |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | (empty) | `firebase/config.ts` |
| `LLM_PROVIDER` | `"lm-studio"` | `lib/llm/index.ts` |
| `LM_STUDIO_BASE_URL` | `"http://localhost:1234/v1"` | `lib/llm/lm-studio.ts` |
| `LM_STUDIO_MODEL` | `"qwen3.5:9b"` | `lib/llm/lm-studio.ts` |
| `LM_STUDIO_API_KEY` | (none) | `lib/llm/lm-studio.ts` |
| `OLLAMA_HOST` | `"http://localhost:11434"` | `lib/llm/ollama.ts` |
| `OLLAMA_MODEL` | `"llama3.2"` | `lib/llm/ollama.ts` |
| `FIREBASE_API_KEY` | (required) | `lib/firestore.ts`, `lib/auth/firebase.server.ts` |
| `FIREBASE_PROJECT_ID` | `"be-right-back-b47be"` | `lib/firestore.ts` |
| `FIREBASE_DATABASE_ID` | `"talk-to-the-dead"` | `lib/firestore.ts` |
| `AUTH_PROVIDER` | `"firebase"` | `lib/auth/server.ts` |
| `NEXT_PUBLIC_AUTH_PROVIDER` | `"firebase"` | `lib/auth/client.ts` |
| `RATE_LIMIT_PER_MINUTE` | `10` | `lib/rate-limit.ts` |
| `RATE_LIMIT_BURST` | `5` | `lib/rate-limit.ts` |
| `RATE_LIMIT_CONCURRENCY_PER_UID` | `2` | `lib/rate-limit.ts` |
| `RATE_LIMIT_CONCURRENCY_GLOBAL` | `10` | `lib/rate-limit.ts` |

Client Firebase values are read by `firebase/config.ts` from `NEXT_PUBLIC_*` vars (metadata fields fall back to defaults; `apiKey`/`appId`/`messagingSenderId` are empty and must be provided in `.env.local`). The `NEXT_PUBLIC_` values are served to the browser and are public by design — the real protection is restricting the key by HTTP referrer in GCP Console (see README). The server half reads `FIREBASE_API_KEY` from `process.env` separately in `lib/firestore.ts` / `lib/auth/firebase.server.ts`. See `.env.example` for a ready-to-copy template.

---

## 15. Commands

```bash
npm run dev      # Dev server with Turbopack (http://localhost:3000)
npm run build    # Production build
npm start        # Serve production build
npm run lint     # ESLint (next/core-web-vitals + next/typescript), flat config in eslint.config.mjs
npm test         # Vitest unit tests (tests/) — prompts, Firestore parsers, SSE, helpers
```

Unit tests live in `tests/` and run with Vitest (`npm test`). CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests, and the production build on every push/PR.

---

## 16. Known Gaps (technical)

- **Embeddings / retrieval** — `listMemoriesForPersona` is list-all-then-filter; fine for tens of memories, needs structured query or embeddings at hundreds.
- **Few-shot exemplars** — no example Q/A pairs in the prompt; adding 2–3 "they would have said…" examples improves fidelity on small local models.
- **Cross-instance rate limiting** — in-process; becomes per-cold-start on Vercel.
- **Streaming partial saves** — reload mid-stream loses the partial reply (matches intuition).
- **Realtime coverage of older pages** — `onSnapshot` only covers the latest 40 messages.
