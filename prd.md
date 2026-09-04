# Talk to the Dead — Product Requirements Document

> Inspired by *Black Mirror* S02E01 "Be Right Back" — an AI simulation of someone you remember, built from your memories of them.

**Status:** Proof of concept
**Owner:** Ankur Mishra

---

## 1. Vision

A web app that lets someone hold a conversation with an AI simulation of a person who has passed. The simulation is built entirely from the user's own memories — who the person was, how they spoke, what they often said, and stories about them. No audio recordings, photos, or data uploads are required; the user's words are the only raw material.

The core promise: a **convincing, emotionally consistent persona** — not a generic chatbot that occasionally repeats a catchphrase. The user describes the person once through a guided interview, and the model responds in that person's voice, drawing on the memories and behavioral patterns the user supplied.

This is a **proof of concept**. The goal is to validate the experience and the underlying plumbing (auth, data model, local LLM streaming, security) before committing to a larger architecture.

## 2. Users

The primary user is someone grieving or curious who wants to "talk to" a simulated version of a person they knew. The PoC targets a single-user model:
- Each persona and its conversation history is **scoped to its creator**.
- There is no social, sharing, or multi-tenancy beyond per-user ownership.
- Authentication is a simple email/password sign-up; there is no admin, roles, or B2B surface.

## 3. User Journey

```
Landing (login/signup)
   │
   ▼
Dashboard ── no persona ──▶ PersonaSelection (guided interview → create)
   │
   └── persona selected ──▶ Chat (streaming conversation)
                               │
                               ├── Memories (add/edit/delete memories)
                               └── Profile (view persona's detail)
```

1. **Sign up / sign in** with email + password (Firebase Auth). Signup is a 2-step wizard: account credentials, then a profile (display name, optional phone, optional "who do you want to remember?" hint). On success, land on the dashboard.
2. **Create a persona** through a guided interview — the app asks how you'd describe the person, without requiring any prompt engineering from the user.
3. **Chat** with the persona. Replies stream token-by-token so the conversation feels natural, not API-shaped.
4. **Manage memories** over time from inside the chat surface — capture new memories, edit, or delete them as they occur to you.
5. **Come back anytime** — conversations persist and resume where you left off.
6. **Delete the account** anytime from the persona header (re-auth + type `DELETE`), which removes all data and the account.

## 4. Features

### 4.1 Authentication
| Requirement | Acceptance criteria |
|---|---|
| Email/password sign-up | User can create an account with email, password, and confirm password via a 2-step wizard (Account → Profile). |
| Profile capture | After creating the account, the user supplies a display name (required), phone (optional), and optional "who do you want to remember?" hint, saved to `users/{uid}`. |
| Email/password sign-in | Existing user can sign in and reach their dashboard. |
| Session persistence | Logging in once keeps the user authenticated across refreshes. |
| Sign out | User can sign out and is returned to the login screen. |
| Auth guard | Unauthenticated users cannot reach the dashboard (redirected to login). |
| Profile guard | A logged-in user without a `users/{uid}` profile doc is redirected to `/signup` to complete it. |
| Delete account | From the persona header ("Account settings"), the user can re-authenticate, type `DELETE`, and permanently remove the account and all associated data (personas, memories, conversation history). |

### 4.1.1 Account & data management
- Account deletion requires **re-authentication** (current password) and a
  typed `DELETE` confirmation to prevent accidental or unauthorized deletion.
- Deleting the account removes the `users/{uid}` profile, all `personas`,
  all `memories`, and all `conversations/{personaId}/messages` for the user,
  then deletes the Firebase Auth account.
- Login/signup inputs carry correct `name` + `autocomplete` attributes so
  browser password managers (e.g. Google Password Manager) offer to save
  credentials.

### 4.2 Guided persona interview
The user describes the person through structured, non-technical questions. No prompt engineering required.

| Field | What it captures |
|---|---|
| **Name** | What the user called them. |
| **Relationship** | Mother / Father / Grandparent / Sibling / Friend / Partner / Other. |
| **They called you** | How the persona addressed the user (term of address). |
| **Languages** | Hindi / English / Hinglish / Other (multi-select). |
| **How they spoke** | Quiet / Talkative / Direct / Playful / Sarcastic / Formal / Emotional / Blunt (multi-select). |
| **Speech examples** | Repeatable: a **phrase** they'd say, the **context** that triggers it, optionally the **meaning**, **tone**, and **typical reaction** behind it. |
| **Distinctive story** | A memorable story or background fact. |

**Acceptance criteria**
- Each speech example is optional, but a phrase requires a context.
- The user can add/remove multiple speech examples.
- Personas can be created, edited, and deleted from the dashboard.
- Existing personas using legacy fields (`oftenSaid`, free-text `traits`) must keep working.

### 4.3 Streaming chat
| Requirement | Acceptance criteria |
|---|---|
| Token-by-token streaming | Reply streams in as it is generated, shown as a blinking cursor while typing. |
| Cancel mid-stream | User can stop generation; any partial text is preserved as the assistant reply. |
| Typing indicator | "Name is typing…" is shown while waiting for the first token. |
| Auto-scroll | New messages keep the latest message in view. |

### 4.4 Message management
| Requirement | Acceptance criteria |
|---|---|
| Edit own messages | User messages can be edited inline (hover to reveal controls). |
| Delete own messages | User messages can be deleted inline with a confirm. |
| Read-only assistant messages | Assistant replies are not editable or deletable. |
| Local-unsaved-wins | While a row is being edited, remote edits to that same row on another device are ignored until the local edit commits or is cancelled. |

### 4.5 History persistence
| Requirement | Acceptance criteria |
|---|---|
| Every turn persists | Each user and assistant message is saved to Firestore. |
| Resume after reload | Reloading the page, switching personas, or returning days later restores the conversation. |
| Pagination | Scrolling up loads older messages (40 at a time) without disturbing the viewport. |
| Realtime sync | Open chats across devices stay in sync for the recent-window of messages. |

### 4.6 Memory management
| Requirement | Acceptance criteria |
|---|---|
| Capture memories | Add a memory for the active persona from the chat surface. |
| Edit / delete memories | Memory items can be edited or deleted (hover to reveal, delete confirms). |
| Persona scoping | Memories are associated with a persona and used as chat context. |

### 4.7 Persona profile view
| Requirement | Acceptance criteria |
|---|---|
| View persona detail | The active persona's structured fields (relationship, language, how they spoke, speech examples, distinctive story) are viewable from the chat header. |

## 5. Persona & Behavioral Design

This is the product's defining requirement: **model behavior, not just catchphrases.**

A `speechExample` captures a full behavioral pattern, not merely a line to repeat:

```
Pattern:
  - Trigger / Situation:  (context)
  - Emotional state/Tone: (tone)
  - Characteristic expression: "..."
  - Underlying meaning:   (meaning)
  - Typical reaction:     (reaction)
```

The intended chain is: **trigger → emotional response → typical reaction → possible characteristic phrase → natural follow-up.**

Rules for the model:
- Reproduce the person's emotional reaction and response pattern; use a characteristic phrase only when it is natural.
- Do **not** insert a catchphrase into a non-matching conversation.
- Persona-specific behavior takes precedence over stereotypes about a relationship (mother, father, grandparent).
- Never frame the model as the real deceased person — it is a **simulation** built from the user's memories and behavioral evidence.
- Preserve the practical meaning, slang, and emotional subtext of Hindi, Hinglish, and other colloquial expressions rather than translating them literally.

**Product quality bar:** a matching trigger (e.g. the persona scolding an expensive purchase) should produce the persona's characteristic reaction; an ordinary update (e.g. coming home early) should **not** trigger it.

## 6. Data Model (product view)

Collections, all scoped to a user:

- **users/{uid}** — the user's profile (display name, optional phone, optional "who do you want to remember?" hint, created at signup step 2).
- **personas/{personaId}** — a description of one simulated person (name, relationship, terms of address, languages, speaking style, speech examples, distinctive story, timestamps).
- **memories/{memoryId}** — a single memory, optionally attached to a persona.
- **conversations/{personaId}/messages/{msgId}** — one chat message (user or assistant) with its content and timestamp. Each message is its own document, enabling pagination and per-message edit/delete without a 1 MiB document limit.

See `architecture.md` for the full field-level schema.

## 7. Non-Functional Requirements

### 7.1 Privacy
- Each persona and its conversation history is scoped to its creator.
- The server returns **404** (not 403) on attempts to read another user's persona, so the existence of that persona is not leaked.
- Client-side reads are gated by Firestore security rules; server-side reads are gated by an ownership check.
- Prompts stay on local hardware (LM Studio / Ollama) in the current configuration; swapping to a hosted LLM moves prompts off-device and is driven by the `LLM_PROVIDER` switch.
- Firestore security rules **must be deployed** before running with real data, or the database is world-readable/writable.

### 7.2 Robustness
- **Rate limiting:** per-UID token bucket (default 10 req/min, burst 5) returns `429` with `Retry-After`.
- **Concurrency cap:** limits in-flight LLM streams (default 2 per UID, 10 globally) returns `503` when saturated.
- **Input validation:** the chat endpoint caps request at 40 messages and 4000 chars each (24000 total).

### 7.3 Performance
- Responses stream incrementally so first-token latency is minimal.
- Tolerable within a tens-of-memories scale; see Known Gaps for the replacement path at larger scale.

## 8. Roadmap

This PoC validates the core loop. Planned phases:

### Phase 2 — Cloud LLM + Shareable Deployment
- Swap LM Studio for a hosted LLM (OpenAI, Claude API) via the existing LLM adapter.
- Deploy to Vercel; move rate limiting to a shared store (Redis) for multi-instance safety.
- Make the app shareable beyond localhost.

### Phase 3 — Voice
- Upload a short audio clip (10–30 s) → voice cloning (ElevenLabs / Coqui / PlayHT).
- AI responses are spoken back in the cloned voice.
- Add a `lib/tts/` adapter layer using the same swappable pattern as `lib/llm/`.

### Phase 4 — Rich Data Ingestion
- Upload WhatsApp chats, email, or social posts.
- Auto-enrich the persona — no manual interview required.
- Embeddings + retrieval for large memory sets (replace list-all-then-filter).

### Phase 5 — Video Avatar
- Upload short video clips.
- Generate a talking avatar (HeyGen / D-ID / Tavus).
- Combined with cloned voice for a full "Be Right Back" experience.

## 9. Known Gaps (intentional, not bugs)

- **Embeddings / retrieval** — `listMemoriesForPersona` is a list-all-then-filter pass. Fine for tens of memories; needs a structured query or embeddings once there are hundreds.
- **Few-shot exemplars** — the prompt uses framing + style hints but no example Q/A pairs. Adding 2–3 stored "they would have said…" examples materially improves fidelity on small local models.
- **Cross-instance rate limiting** — the rate limiter is in-process. Each cold start on Vercel gets a fresh store; fine for a personal project, swap for a Redis-backed implementation at scale.
- **Streaming partial saves** — reloading mid-stream loses the partial reply; the conversation shows up to the last completed turn. Matches user intuition.
- **Realtime coverage of older pages** — realtime sync covers only the active chat's latest 40 messages; older paginated pages are static until scrolled back to.
