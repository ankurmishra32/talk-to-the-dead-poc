# Talk to the Dead — PoC

A Next.js app that lets you hold a conversation with an AI simulation of someone you remember. You describe the person — who they were, how they spoke, what they often said — and the model responds in their voice, drawing on memories you've saved.

This is a **proof of concept**. The goal is to explore the experience and the underlying plumbing (auth, data model, local LLM streaming) before committing to a larger architecture.

## What it does

- **Sign up / sign in** with email + password (Firebase Auth).
- **Create a persona** through a guided interview — relationship, language, what they called you, how they spoke, things they often said, a memory of them. No prompt engineering required.
- **Add memories** about that person over time.
- **Chat** with the persona. Responses stream token-by-token over Server-Sent Events, so replies feel conversational rather than API-shaped.
- **Privacy**: each persona is scoped to its creator. The server rejects cross-user requests with a 404 (not 403) so existence isn't leaked.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (pages router) + React 19 + TypeScript |
| Styling | Tailwind CSS v4 |
| Auth | Firebase Auth (email/password) |
| Database | Cloud Firestore, **named database** `talk-to-the-dead` |
| LLM | [Ollama](https://ollama.com/) running locally, model `llama3.2` |
| Server-side data access | Firestore REST API + Identity Toolkit REST (no `firebase-admin`) |

### Why no `firebase-admin`?

The server needs to verify ID tokens and read/write Firestore documents. We do both with raw `fetch` against Google's REST APIs rather than pulling in the Admin SDK. Smaller dependency surface, same functionality, and the API key we already need for Firestore REST also works for `accounts:lookup`.

### Why a named Firestore database?

The Firebase project was provisioned with a non-default database named `talk-to-the-dead`. Both the client SDK and the server-side REST wrapper point at this database explicitly. Don't change this without updating `lib/firestore.ts`'s `getDatabaseId()` and `firebase/config.ts`'s `getFirestore(app, ...)` call.

## Getting started

### Prerequisites

- Node.js (whatever version Next.js 16 requires)
- Ollama installed and running locally, with `llama3.2` pulled:
  ```bash
  ollama pull llama3.2
  ```
- A Firebase project with:
  - Email/password auth enabled
  - Firestore enabled
  - A Firestore database named `talk-to-the-dead` (not the default `(default)`)

### Setup

1. Clone and install:
   ```bash
   cd talk-to-the-dead-poc
   npm install
   ```

2. Create `.env.local`:
   ```
   OLLAMA_HOST=http://localhost:11434
   OLLAMA_MODEL=llama3.2
   FIREBASE_API_KEY=your-firebase-browser-api-key
   ```
   The `FIREBASE_API_KEY` is the same value as `firebaseConfig.apiKey` in `firebase/config.ts`. It's not a secret in the Firebase sense (it's the browser key), but it does identify your project.

3. Run the dev server:
   ```bash
   npm run dev
   ```

4. Open http://localhost:3000, sign up, create a persona, start chatting.

## Project layout

```
.
├── components/
│   ├── Chat.tsx              # Streaming chat UI with ReadableStream + SSE parser
│   ├── MemoryInput.tsx       # Inline memory capture, scoped to current persona
│   └── PersonaSelection.tsx  # Guided persona interview + per-user persona list
├── firebase/
│   └── config.ts             # Firebase client SDK init (named db "talk-to-the-dead")
├── lib/
│   ├── firestore.ts          # Server-side Firestore + Identity Toolkit REST wrapper
│   │                         # Includes getUidFromAuthHeader, getPersona, listMemoriesForPersona
│   └── prompts.ts            # Pure system-prompt builder (no IO, easily testable)
├── pages/
│   ├── _app.tsx
│   ├── index.tsx             # Login / signup
│   ├── dashboard.tsx         # Persona picker → chat
│   └── api/
│       └── chat.ts           # POST endpoint: validates auth, fetches persona+memories,
│                             #   streams Ollama response as SSE deltas
├── styles/globals.css        # Tailwind v4 entry
└── next.config.ts
```

## Architecture

```
+----------------+        POST /api/chat            +----------------------+
|  Browser       |   Authorization: Bearer <idTok>  |  Next.js API route   |
|  (React app)   | --------------------------------> |  (pages/api/chat.ts) |
|                | <-------------------------------- |                      |
|  - getIdToken  |   text/event-stream (SSE)         |  1. Verify idToken   |
|  - parse SSE   |     event: delta { delta: "..."} |     via Identity     |
|  - render live |     event: done  { reply: "..."} |     Toolkit REST     |
+----------------+                                  |  2. Fetch persona +  |
                                                    |     memories via     |
                                                    |     Firestore REST   |
                                                    |  3. POST to Ollama   |
                                                    |     /api/chat with   |
                                                    |     stream:true      |
                                                    |  4. Pipe NDJSON      |
                                                    |     chunks as SSE    |
                                                    +----------+-----------+
                                                               |
                                                               v
                                                    +----------------------+
                                                    |  Ollama (localhost)  |
                                                    |  model: llama3.2     |
                                                    +----------------------+

+----------------+                                +----------------------+
|  Browser       | -- addDoc(collection("personas")) ---> |  Firestore          |
|                | -- addDoc(collection("memories")) ---> |  database:          |
|                | <-- getDocs() (scoped to user) ------ |  talk-to-the-dead   |
+----------------+                                +----------------------+
```

## Data model

```
personas/{personaId}                  memories/{memoryId}
├── name: string                       ├── personaId: string
├── userId: string (Firebase uid)      ├── userId: string
├── relationship: string?              ├── text: string
├── theyCalledYou: string?             └── createdAt: timestamp
├── languages: string[]?
├── howTheySpoke: string[]?
├── oftenSaid: string[]?
├── distinctiveStory: string?
├── traits: string                     (empty for new personas;
└── createdAt: timestamp                legacy free-text field)

```

`personas.userId` is the security boundary — the server-side `getPersona(id, uid)` returns `null` if `persona.userId !== uid`. The client-side persona list also filters by `userId` for UX, but the server is the source of truth.

## Streaming chat protocol

`POST /api/chat` returns `Content-Type: text/event-stream`. Each NDJSON line from Ollama is re-emitted as an SSE event:

| Server event | Data payload | When |
|---|---|---|
| `event: delta` | `{ "delta": "Hello" }` | One per token from Ollama |
| `event: done`  | `{ "reply": "Hello, beta." }` | Ollama signals end-of-stream |
| `event: error` | `{ "error": "..." }` | Upstream error; client should stop |

The client (`components/Chat.tsx`) reads the stream with `ReadableStream`, appends each `delta` to a live message bubble, and commits the final accumulated text when `done` arrives. A Cancel button aborts the fetch via `AbortController`, preserving whatever was streamed so far.

## Scripts

```bash
npm run dev      # Dev server with Turbopack
npm run build    # Production build
npm start        # Serve production build
npm run lint     # ESLint (next/core-web-vitals + next/typescript)
```

## What's intentionally missing

This is a PoC. The following are **known gaps**, not bugs:

- **Firestore Security Rules** — anyone with the project ID can read/write. The `/api/chat` ownership check protects chat access, but direct Firestore reads aren't gated. Add rules before exposing beyond local testing.
- **Chat history persistence** — messages reset on reload. The streaming plumbing already supports replay; this just hasn't been wired to a `conversations` collection yet.
- **Embeddings / retrieval** — `listMemoriesForPersona` is a list-all-then-filter pass. Fine for tens of memories; needs structured query or embeddings once you have hundreds.
- **Few-shot exemplars** — `lib/prompts.ts` uses framing + style hints but no example Q/A pairs. Adding 2–3 stored "they would have said..." examples noticeably improves fidelity on small local models.
- **Persona profile surface** — currently you only see the persona's name in the chat header. There's no view of all the structured fields you filled in.

## License

Internal PoC. No license declared.
